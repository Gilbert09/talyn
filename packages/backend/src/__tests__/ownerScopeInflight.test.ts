import { EventEmitter } from 'node:events';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';

/**
 * The owner-scope transaction in the in-flight registry. RLS scoping opens a
 * transaction only against real Postgres, so the client module is replaced by
 * a scripted pool that says it is real.
 */
const state = vi.hoisted(() => ({ transactionFails: false }));

vi.mock('../db/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/client.js')>();
  const pool = {
    transaction: async <T>(fn: (tx: unknown) => Promise<T>) => {
      if (state.transactionFails) throw new Error('connect timeout');
      return fn({ execute: async () => [] });
    },
  };
  return { ...actual, isRealPostgres: () => true, getPoolDbClient: () => pool };
});

const { withOwnerScope } = await import('../db/scope.js');
const { ownerScope } = await import('../middleware/ownerScope.js');
const { _resetInflight, inflightEntries, inflightSize } = await import('../db/inflight.js');

beforeEach(() => {
  _resetInflight();
  state.transactionFails = false;
});

describe('withOwnerScope in-flight entry', () => {
  it('holds an owner_tx entry with its label while fn runs, then removes it', async () => {
    let during: unknown[] = [];
    const out = await withOwnerScope(
      'user-1',
      async () => {
        during = inflightEntries().map((e) => [e.kind, e.label]);
        return 'done';
      },
      'GET /api/v1/tasks',
    );
    expect(out).toBe('done');
    expect(during).toEqual([['owner_tx', 'GET /api/v1/tasks']]);
    expect(inflightSize()).toBe(0);
  });

  it('uses a default label when none is given', async () => {
    let label: string | undefined;
    await withOwnerScope('user-1', async () => {
      label = inflightEntries()[0]?.label;
    });
    expect(label).toBe('owner scope');
  });

  it('removes the entry when fn rejects', async () => {
    await expect(
      withOwnerScope('user-1', async () => {
        throw new Error('handler failed');
      }),
    ).rejects.toThrow('handler failed');
    expect(inflightSize()).toBe(0);
  });

  it('adds no entry when the transaction never opens', async () => {
    state.transactionFails = true;
    await expect(withOwnerScope('user-1', async () => 1)).rejects.toThrow('connect timeout');
    expect(inflightSize()).toBe(0);
  });

  it('a nested call reuses the scope and adds no second entry', async () => {
    let inner = -1;
    await withOwnerScope('user-1', () =>
      withOwnerScope('user-1', async () => {
        inner = inflightSize();
      }, 'nested'),
    );
    expect(inner).toBe(1);
    expect(inflightSize()).toBe(0);
  });
});

describe('ownerScope middleware label', () => {
  it.each([
    ['GET', '/api/v1/pull-requests/7302', 'GET /api/v1/pull-requests/7302'],
    ['POST', '/api/v1/tasks?workspaceId=abc&token=secret', 'POST /api/v1/tasks'],
    ['GET', '/api/v1/tasks?', 'GET /api/v1/tasks'],
    ['DELETE', '/', 'DELETE /'],
  ])('%s %s is labelled %s', async (method, originalUrl, expected) => {
    const res = new EventEmitter() as unknown as Response & EventEmitter;
    (res as unknown as { headersSent: boolean }).headersSent = false;
    const req = { user: { id: 'user-1' }, method, originalUrl } as unknown as Request;
    let label: string | undefined;
    const next = vi.fn(() => {
      label = inflightEntries()[0]?.label;
    }) as unknown as NextFunction;

    ownerScope(req, res, next);
    await vi.waitFor(() => expect(next).toHaveBeenCalled());
    expect(label).toBe(expected);
    res.emit('finish');
    await vi.waitFor(() => expect(inflightSize()).toBe(0));
  });

  it.each(['finish', 'close'])('ends the entry on res "%s"', async (event) => {
    const res = new EventEmitter() as unknown as Response & EventEmitter;
    const req = { user: { id: 'user-1' }, method: 'GET', originalUrl: '/x' } as unknown as Request;
    const next = vi.fn() as unknown as NextFunction;
    ownerScope(req, res, next);
    await vi.waitFor(() => expect(next).toHaveBeenCalled());
    expect(inflightSize()).toBe(1);
    res.emit(event);
    await vi.waitFor(() => expect(inflightSize()).toBe(0));
  });

  it('opens nothing for an unauthenticated request', () => {
    const next = vi.fn() as unknown as NextFunction;
    ownerScope({} as Request, new EventEmitter() as unknown as Response, next);
    expect(next).toHaveBeenCalled();
    expect(inflightSize()).toBe(0);
  });
});
