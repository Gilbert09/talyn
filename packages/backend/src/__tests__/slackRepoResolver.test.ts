import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, seedUser } from './helpers/testDb.js';
import { repositories, slackRepoMemory, workbenches, workspaces } from '../db/schema.js';
import {
  decideByCodeSearch,
  distinctiveSearchQueries,
  explicitRepoRefs,
  hasWholeWord,
  isClear,
  MAX_CODE_SEARCHES,
  nameVariants,
  recordRepoUse,
  resolveRepoOffline,
  resolveRepository,
  type ResolverInput,
} from '../services/slack/repoResolver.js';
import { githubService } from '../services/github.js';

/**
 * Which repository a Slack request is about: the order (explicit, name,
 * memory, code search), the margin that makes a winner "clear", and the
 * refusal to guess.
 */

const REPOS = [
  { id: 'r-web', fullName: 'acme/web-app' },
  { id: 'r-api', fullName: 'acme/billing-api' },
  { id: 'r-fleet', fullName: 'acme/talyn-fleet' },
];

function input(extra: Partial<ResolverInput> = {}): ResolverInput {
  return { repos: REPOS, request: '', thread: [], channelMemory: [], recentSessions: [], ...extra };
}

describe('explicitRepoRefs', () => {
  it.each([
    ['a repo URL', 'see https://github.com/acme/web-app', ['acme/web-app']],
    ['a PR URL', 'https://github.com/Acme/Billing-API/pull/12', ['acme/billing-api']],
    ['an issue URL', 'github.com/acme/web-app/issues/4', ['acme/web-app']],
    ['a blob URL', 'https://github.com/acme/talyn-fleet/blob/main/x.go#L3', ['acme/talyn-fleet']],
    ['a Slack-wrapped URL', '<https://github.com/acme/web-app/pull/3|acme/web-app#3>', ['acme/web-app']],
    ['bare owner/repo', 'fix acme/web-app please', ['acme/web-app']],
    ['a .git clone URL', 'git@github.com:acme/web-app.git', ['acme/web-app']],
  ])('%s', (_n, text, expected) => {
    expect(explicitRepoRefs(text)).toEqual(expect.arrayContaining(expected));
  });
});

describe('hasWholeWord', () => {
  it.each([
    ['plain word', 'the talyn-fleet is down', 'talyn-fleet', true],
    ['case', 'The TALYN-FLEET broke', 'talyn-fleet', true],
    ['inside another word', 'mytalyn-fleetx', 'talyn-fleet', false],
    ['inside a path', 'src/talyn-fleet/x', 'talyn-fleet', false],
    ['a dotted name', 'posthog.com is slow', 'posthog', false],
    ['end of sentence', 'look at posthog.', 'posthog', true],
    ['spaced variant', 'the talyn   fleet runner', 'talyn fleet', true],
  ])('%s', (_n, text, phrase, expected) => {
    expect(hasWholeWord(text, phrase)).toBe(expected);
  });

  it('skips names shorter than four characters, which are ordinary words', () => {
    expect(nameVariants('app')).toEqual([]);
    expect(nameVariants('web-app')).toEqual(expect.arrayContaining(['web-app', 'web app', 'web_app']));
  });
});

describe('isClear', () => {
  it.each([
    ['one positive score', [['a', 1]], 'a'],
    ['twice the runner-up', [['a', 4], ['b', 2]], 'a'],
    ['less than twice', [['a', 3], ['b', 2]], null],
    ['a tie', [['a', 2], ['b', 2]], null],
    ['nothing', [], null],
  ] as Array<[string, Array<[string, number]>, string | null]>)('%s', (_n, entries, winner) => {
    expect(isClear(new Map(entries))?.winner ?? null).toBe(winner);
  });

  it('respects a minimum', () => {
    expect(isClear(new Map([['a', 1.5]]), 2)).toBeNull();
    expect(isClear(new Map([['a', 2]]), 2)?.winner).toBe('a');
  });
});

describe('resolveRepoOffline', () => {
  it.each([
    ['an explicit URL in the request', input({ request: 'fix https://github.com/acme/billing-api/issues/9' }), 'r-api', 'explicit'],
    ['an explicit owner/repo in the thread', input({ thread: ['it is in acme/talyn-fleet'] }), 'r-fleet', 'explicit'],
    ['the name as a word', input({ request: 'the web-app login is broken' }), 'r-web', 'name'],
    ['a spaced name', input({ request: 'billing api returns 500' }), 'r-api', 'name'],
    ['an alias', input({ request: 'the runner is slow', aliases: new Map([['r-fleet', ['runner']]]) }), 'r-fleet', 'name'],
    [
      'channel memory',
      input({ request: 'it crashes', channelMemory: [{ repositoryId: 'r-api', uses: 2, corrections: 0 }] }),
      'r-api',
      'memory',
    ],
    [
      'a correction weighs double',
      input({
        request: 'it crashes',
        channelMemory: [
          { repositoryId: 'r-api', uses: 2, corrections: 0 },
          { repositoryId: 'r-web', uses: 1, corrections: 2 },
        ],
      }),
      'r-web',
      'memory',
    ],
    [
      'recent sessions alone at a lower weight',
      input({ request: 'it crashes', recentSessions: ['r-fleet', 'r-fleet', 'r-fleet', 'r-fleet'] }),
      'r-fleet',
      'memory',
    ],
    ['the only repository', { ...input({ request: 'it crashes' }), repos: [REPOS[0]] }, 'r-web', 'only_repository'],
  ])('%s', (_n, inp, repoId, reason) => {
    const out = resolveRepoOffline(inp);
    expect(out).toMatchObject({ kind: 'chosen', repositoryId: repoId, reason });
  });

  it('an explicit reference beats a name and memory', () => {
    const out = resolveRepoOffline(
      input({
        request: 'web-app is fine, the bug is in acme/billing-api',
        channelMemory: [{ repositoryId: 'r-web', uses: 50, corrections: 5 }],
      })
    );
    expect(out).toMatchObject({ kind: 'chosen', repositoryId: 'r-api', reason: 'explicit' });
  });

  it('a request mention outweighs thread mentions', () => {
    const out = resolveRepoOffline(input({ request: 'fix the web-app', thread: ['billing-api?'] }));
    expect(out).toMatchObject({ kind: 'chosen', repositoryId: 'r-web', reason: 'name' });
  });

  it('a tie in names narrows the later steps to the tied repositories', () => {
    const out = resolveRepoOffline(
      input({
        request: 'web-app or billing-api, not sure',
        channelMemory: [
          { repositoryId: 'r-fleet', uses: 40, corrections: 0 },
          { repositoryId: 'r-api', uses: 3, corrections: 0 },
        ],
      })
    );
    expect(out).toMatchObject({ kind: 'chosen', repositoryId: 'r-api', reason: 'memory' });
  });

  it.each([
    ['one channel use is not enough', [{ repositoryId: 'r-api', uses: 1, corrections: 0 }], []],
    [
      'close memory is not clear',
      [
        { repositoryId: 'r-api', uses: 3, corrections: 0 },
        { repositoryId: 'r-web', uses: 2, corrections: 0 },
      ],
      [],
    ],
    ['nothing at all', [], []],
  ])('does not guess: %s', (_n, channelMemory, recentSessions) => {
    expect(resolveRepoOffline(input({ request: 'it crashes', channelMemory, recentSessions })).kind).toBe('undecided');
  });

  it('a GitHub URL for a repository the workspace lacks is ambiguous, not a guess', () => {
    const out = resolveRepoOffline({ ...input({ request: 'see https://github.com/other/thing/pull/1' }), repos: [REPOS[0]] });
    expect(out).toMatchObject({ kind: 'ambiguous', candidates: [] });
  });

  it('a bare pair that is really a path does not block the only repository', () => {
    const out = resolveRepoOffline({ ...input({ request: 'fix the client/server handshake' }), repos: [REPOS[0]] });
    expect(out).toMatchObject({ kind: 'chosen', reason: 'only_repository' });
  });

  it('offers code search terms, at most two', () => {
    const out = resolveRepoOffline(input({ request: 'parseInvoiceTotals in src/billing/totals.ts throws "invoice total mismatch" and handle_refund_event' }));
    expect(out.kind).toBe('undecided');
    if (out.kind !== 'undecided') return;
    expect(out.searchQueries).toHaveLength(MAX_CODE_SEARCHES);
    expect(out.searchQueries[0]).toBe('filename:totals.ts');
  });
});

describe('distinctiveSearchQueries', () => {
  it.each([
    ['a file path', 'error in src/app/LoginForm.tsx', ['filename:LoginForm.tsx']],
    ['a quoted error', 'it says `Cannot read properties of undefined`', ['"Cannot read properties of undefined"']],
    ['a CamelCase identifier', 'the useWorkbenchStore hook', ['"useWorkbenchStore"']],
    ['a snake_case identifier', 'look at max_retry_count', ['"max_retry_count"']],
    ['ordinary words only', 'please make the login faster', []],
    ['short identifiers', 'fooBar is odd', []],
  ])('%s', (_n, text, expected) => {
    expect(distinctiveSearchQueries(text)).toEqual(expected);
  });
});

describe('decideByCodeSearch', () => {
  const undecided = { kind: 'undecided' as const, contenders: ['r-web', 'r-api'], searchQueries: ['"x"'], detail: 'No clear repository.' };
  it.each([
    ['a clear winner', [['r-api', 5], ['r-web', 1]], { kind: 'chosen', repositoryId: 'r-api', reason: 'code_search' }],
    ['a close race', [['r-api', 3], ['r-web', 2]], { kind: 'ambiguous', candidates: ['r-api', 'r-web'] }],
    ['no hits', [], { kind: 'ambiguous' }],
    ['hits outside the contenders', [['r-fleet', 9]], { kind: 'ambiguous' }],
  ] as Array<[string, Array<[string, number]>, object]>)('%s', (_n, hits, expected) => {
    expect(decideByCodeSearch(undecided, new Map(hits), REPOS)).toMatchObject(expected);
  });
});

describe('resolveRepository (IO shell)', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;

  beforeEach(async () => {
    testDb = await createTestDb();
    await seedUser(testDb.db, { id: 'u1' });
    await testDb.db.insert(workspaces).values({ id: 'ws1', ownerId: 'u1', name: 'W' });
    await testDb.db.insert(repositories).values([
      { id: 'r-web', workspaceId: 'ws1', name: 'web-app', url: 'https://github.com/acme/web-app' },
      { id: 'r-api', workspaceId: 'ws1', name: 'billing-api', url: 'https://github.com/acme/billing-api' },
      { id: 'r-fleet', workspaceId: 'ws1', name: 'talyn-fleet', url: 'https://github.com/acme/talyn-fleet' },
    ]);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await testDb.cleanup();
  });

  const ctx = (request: string) => ({ workspaceId: 'ws1', userId: 'u1', teamId: 'T1', channelId: 'C1', request, thread: [] });

  it('uses stored channel memory, with corrections weighing double', async () => {
    await recordRepoUse({ teamId: 'T1', channelId: 'C1', repositoryId: 'r-api', corrected: false });
    await recordRepoUse({ teamId: 'T1', channelId: 'C1', repositoryId: 'r-api', corrected: false });
    await recordRepoUse({ teamId: 'T1', channelId: 'C1', repositoryId: 'r-web', corrected: true });
    await recordRepoUse({ teamId: 'T1', channelId: 'C1', repositoryId: 'r-web', corrected: true });
    const rows = await testDb.db.select().from(slackRepoMemory);
    expect(rows.find((r) => r.repositoryId === 'r-web')).toMatchObject({ uses: 2, corrections: 2, corrected: true });
    const out = await resolveRepository(ctx('it is broken'));
    // r-web: 2 + 2*2 = 6 against r-api: 2.
    expect(out.resolution).toMatchObject({ kind: 'chosen', repositoryId: 'r-web', reason: 'memory' });
  });

  it("counts the user's recent sessions", async () => {
    await testDb.db.insert(workbenches).values(
      [1, 2, 3, 4].map((i) => ({
        id: `wb${i}`,
        workspaceId: 'ws1',
        repositoryId: 'r-fleet',
        repoFullName: 'acme/talyn-fleet',
        name: `s${i}`,
        branch: `b${i}`,
        baseBranch: 'main',
        runtime: 'sandbox',
        agent: 'claude',
      }))
    );
    expect((await resolveRepository(ctx('it is broken'))).resolution).toMatchObject({ repositoryId: 'r-fleet', reason: 'memory' });
  });

  it('breaks a tie with code search, at most twice, restricted to the contenders', async () => {
    const search = vi.spyOn(githubService, 'searchCodeHitsByRepo').mockImplementation(async (_ws, _q, repos) => {
      const hits = new Map<string, number>();
      if (repos.includes('acme/billing-api')) hits.set('acme/billing-api', 4);
      if (repos.includes('acme/web-app')) hits.set('acme/web-app', 1);
      return hits;
    });
    const out = await resolveRepository(ctx('web-app or billing-api? parseInvoiceTotals and handle_refund_event and computeLateFees break'));
    expect(search).toHaveBeenCalledTimes(MAX_CODE_SEARCHES);
    for (const call of search.mock.calls) expect([...call[2]].sort()).toEqual(['acme/billing-api', 'acme/web-app']);
    expect(out.resolution).toMatchObject({ kind: 'chosen', repositoryId: 'r-api', reason: 'code_search' });
  });

  it('does not search without distinctive tokens, and asks instead', async () => {
    const search = vi.spyOn(githubService, 'searchCodeHitsByRepo');
    const out = await resolveRepository(ctx('please make it faster'));
    expect(search).not.toHaveBeenCalled();
    expect(out.resolution).toMatchObject({ kind: 'ambiguous' });
    if (out.resolution.kind === 'ambiguous') expect(out.resolution.candidates.sort()).toEqual(['r-api', 'r-fleet', 'r-web']);
  });

  it('a failed search decides nothing', async () => {
    vi.spyOn(githubService, 'searchCodeHitsByRepo').mockRejectedValue(new Error('rate limited'));
    const out = await resolveRepository(ctx('parseInvoiceTotals is wrong'));
    expect(out.resolution.kind).toBe('ambiguous');
  });
});
