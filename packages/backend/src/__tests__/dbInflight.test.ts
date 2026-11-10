import { describe, it, expect, beforeEach } from 'vitest';
import {
  _resetInflight,
  ageSeconds,
  beginInflight,
  describeEntry,
  describeInflightSummary,
  describeOldestByKind,
  endInflight,
  inflightCounts,
  inflightEntries,
  inflightSize,
  poolDemand,
  trackInflight,
  transactionClosed,
  transactionOpened,
  type InflightEntry,
} from '../db/inflight.js';

beforeEach(() => {
  _resetInflight();
});

describe('beginInflight / endInflight', () => {
  it('adds an entry and removes it', () => {
    const id = beginInflight('owner_tx', 'GET /api/v1/tasks', {}, 1_000);
    expect(inflightEntries()).toEqual([
      { id, kind: 'owner_tx', label: 'GET /api/v1/tasks', startedAt: 1_000, reportedAt: null },
    ]);
    endInflight(id);
    expect(inflightSize()).toBe(0);
  });

  it.each([
    ['twice', (id: number) => [id, id]],
    ['an unknown id', () => [999]],
  ])('ending %s does nothing more', (_name, ids) => {
    const keep = beginInflight('lock_tx', 'keep');
    const id = beginInflight('lock_tx', 'drop');
    for (const x of ids(id)) endInflight(x);
    expect(inflightEntries().map((e) => e.id)).toContain(keep);
  });

  it('gives each entry a new id', () => {
    const ids = new Set(Array.from({ length: 50 }, () => beginInflight('query', 'select 1')));
    expect(ids.size).toBe(50);
  });

  it('lists entries oldest first even when they were added out of order', () => {
    beginInflight('query', 'b', {}, 2_000);
    beginInflight('query', 'a', {}, 1_000);
    beginInflight('query', 'c', {}, 3_000);
    expect(inflightEntries().map((e) => e.label)).toEqual(['a', 'b', 'c']);
  });
});

describe('trackInflight', () => {
  it('holds an entry while fn runs and removes it after it resolves', async () => {
    let seen = 0;
    const out = await trackInflight('lock_tx', 'mergeQueue:tick', async () => {
      seen = inflightSize();
      return 'ok';
    });
    expect(out).toBe('ok');
    expect(seen).toBe(1);
    expect(inflightSize()).toBe(0);
  });

  it('removes the entry when fn rejects, and rethrows', async () => {
    await expect(
      trackInflight('owner_tx', 'GET /x', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(inflightSize()).toBe(0);
  });

  it('does not leak over many settles of both kinds', async () => {
    await Promise.allSettled(
      Array.from({ length: 200 }, (_, i) =>
        trackInflight('owner_tx', `r${i}`, async () => {
          if (i % 2) throw new Error('x');
          return i;
        }),
      ),
    );
    expect(inflightSize()).toBe(0);
  });
});

describe('describeEntry', () => {
  const entry = (over: Partial<InflightEntry>): InflightEntry => ({
    id: 1,
    kind: 'query',
    startedAt: 0,
    label: '',
    reportedAt: null,
    ...over,
  });

  it.each([
    [{ label: 'select "id" from "pull_requests" where "id" = $1', connection: 'transaction', ownerScope: true }, 'select "pull_requests" (owner scope)'],
    [{ label: 'update "tasks" set "status" = $1', connection: 'transaction', ownerScope: false }, 'update "tasks" (transaction)'],
    [{ label: 'insert into "loop_runs" ("id") values ($1)', connection: 'pool', ownerScope: false }, 'insert "loop_runs" (pool)'],
    [{ label: 'select 1 from "users"', connection: 'pool', ownerScope: true }, 'select "users" (pool, from a request)'],
    [{ label: 'begin ', connection: 'pool', ownerScope: false }, 'begin (pool)'],
    [{ kind: 'owner_tx', label: 'GET /api/v1/pull-requests/7302' }, 'GET /api/v1/pull-requests/7302'],
    [{ kind: 'lock_tx', label: 'cloudPoller:tick' }, 'cloudPoller:tick'],
  ] as const)('%o reads %s', (over, expected) => {
    expect(describeEntry(entry(over as Partial<InflightEntry>))).toBe(expected);
  });

  it('never prints a literal value from the SQL text', () => {
    const e = entry({
      label: `select * from "users" where email = 'secret@example.com'`,
      connection: 'pool',
    });
    expect(describeEntry(e)).not.toContain('secret');
  });
});

describe('inflightCounts / poolDemand', () => {
  it('is empty with nothing open', () => {
    const c = inflightCounts();
    expect(c).toEqual({
      queries: 0,
      poolQueries: 0,
      ownerTransactions: 0,
      lockTransactions: 0,
      openTransactions: 0,
      oldest: null,
    });
    expect(poolDemand(c)).toBe(0);
  });

  it('counts by kind and finds the oldest', () => {
    beginInflight('query', 'select 1', { connection: 'pool' }, 5_000);
    beginInflight('query', 'select 1', { connection: 'transaction' }, 6_000);
    beginInflight('owner_tx', 'GET /a', {}, 1_000);
    beginInflight('lock_tx', 'l', {}, 3_000);
    transactionOpened();
    transactionOpened();
    transactionOpened();
    const c = inflightCounts();
    expect(c).toMatchObject({
      queries: 2,
      poolQueries: 1,
      ownerTransactions: 1,
      lockTransactions: 1,
      openTransactions: 3,
    });
    expect(c.oldest?.label).toBe('GET /a');
    // One pool query plus three transactions. A query inside a transaction
    // uses that transaction's connection.
    expect(poolDemand(c)).toBe(4);
  });

  it.each([
    { opened: 0, owner: 2, lock: 1, pool: 0, demand: 3 },
    { opened: 5, owner: 2, lock: 1, pool: 2, demand: 7 },
    { opened: 1, owner: 0, lock: 0, pool: 0, demand: 1 },
  ])(
    'demand with $opened counted transactions, $owner owner, $lock lock, $pool pool queries is $demand',
    ({ opened, owner, lock, pool, demand }) => {
      for (let i = 0; i < opened; i++) transactionOpened();
      for (let i = 0; i < owner; i++) beginInflight('owner_tx', 'o');
      for (let i = 0; i < lock; i++) beginInflight('lock_tx', 'l');
      for (let i = 0; i < pool; i++) beginInflight('query', 'select 1', { connection: 'pool' });
      expect(poolDemand()).toBe(demand);
    },
  );

  it('never lets the open-transaction count go below zero', () => {
    transactionClosed();
    transactionOpened();
    expect(inflightCounts().openTransactions).toBe(1);
  });
});

describe('ageSeconds', () => {
  it.each([
    [0, 0],
    [1_499, 1],
    [47_000, 47],
    [-5_000, 0],
  ])('%dms is %ds', (elapsed, seconds) => {
    const e = { startedAt: 10_000 } as InflightEntry;
    expect(ageSeconds(e, 10_000 + elapsed)).toBe(seconds);
  });
});

describe('describeInflightSummary', () => {
  it('says nothing is in flight', () => {
    expect(describeInflightSummary(0)).toContain('nothing in flight');
  });

  it('names counts and the oldest entry', () => {
    beginInflight('owner_tx', 'GET /api/v1/pull-requests', {}, 0);
    beginInflight('query', 'select 1 from "tasks"', { connection: 'pool' }, 10_000);
    expect(describeInflightSummary(47_000)).toBe(
      '1 queries in flight (1 on the pool), 1 owner transactions, 0 lock transactions, ' +
        '0 open transactions in all; oldest 47s (owner transaction: GET /api/v1/pull-requests)',
    );
  });
});

describe('describeOldestByKind', () => {
  it('prints nothing with nothing open', () => {
    expect(describeOldestByKind(15, 0)).toEqual([]);
  });

  it('caps each kind separately, oldest first, with a "+N more" line', () => {
    for (let i = 0; i < 4; i++) beginInflight('owner_tx', `GET /${i}`, {}, i * 1_000);
    beginInflight('lock_tx', 'lock-a', {}, 0);
    const lines = describeOldestByKind(2, 10_000);
    expect(lines).toEqual([
      'owner transaction: 4 open',
      '  10s GET /0',
      '  9s GET /1',
      '  +2 more',
      'lock transaction: 1 open',
      '  10s lock-a',
    ]);
  });
});
