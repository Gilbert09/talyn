import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, seedUser } from './helpers/testDb.js';
import { prCheckStates, pullRequests, repositories, workspaces } from '../db/schema.js';

const { formatFixChecksContext, readFixChecksContext } = await import('../services/workbenches/actions.js');
const { githubService } = await import('../services/github.js');

type Check = Parameters<typeof formatFixChecksContext>[0]['checks'][number];

const check = (name: string, over: Partial<Check> = {}): Check => ({
  name,
  conclusion: 'FAILURE',
  required: true,
  url: `https://github.com/acme/app/actions/runs/${name}`,
  ...over,
});

describe('formatFixChecksContext', () => {
  const base = { prNumber: 42, prUrl: 'https://github.com/acme/app/pull/42', headSha: 'abcdef1234567890' };

  it('is empty when nothing fails, so the configured prompt goes alone', () => {
    expect(formatFixChecksContext({ ...base, checks: [] })).toBe('');
  });

  it.each<[string, Check[], string[]]>([
    [
      'one required failure',
      [check('lint')],
      [
        '## Failing checks on #42 (head abcdef1)',
        '',
        '- `lint` — failure — required — https://github.com/acme/app/actions/runs/lint',
        '',
        'All checks: https://github.com/acme/app/pull/42/checks',
      ],
    ],
    [
      'required before unknown before optional, then by name',
      [
        check('zeta', { required: false, conclusion: 'TIMED_OUT' }),
        check('beta', { required: null, conclusion: null }),
        check('alpha'),
        check('gamma'),
      ],
      [
        '## Failing checks on #42 (head abcdef1)',
        '',
        '- `alpha` — failure — required — https://github.com/acme/app/actions/runs/alpha',
        '- `gamma` — failure — required — https://github.com/acme/app/actions/runs/gamma',
        '- `beta` — failed — required-ness unknown — https://github.com/acme/app/actions/runs/beta',
        '- `zeta` — timed out — optional — https://github.com/acme/app/actions/runs/zeta',
        '',
        'All checks: https://github.com/acme/app/pull/42/checks',
        '',
        'Fix the required checks first. An optional check does not block the merge.',
      ],
    ],
    [
      'a check with no link',
      [check('build', { url: null, conclusion: 'ACTION_REQUIRED' })],
      [
        '## Failing checks on #42 (head abcdef1)',
        '',
        '- `build` — action required — required',
        '',
        'All checks: https://github.com/acme/app/pull/42/checks',
      ],
    ],
    [
      'only optional failures: no ordering hint',
      [check('docs', { required: false })],
      [
        '## Failing checks on #42 (head abcdef1)',
        '',
        '- `docs` — failure — optional — https://github.com/acme/app/actions/runs/docs',
        '',
        'All checks: https://github.com/acme/app/pull/42/checks',
      ],
    ],
  ])('%s', (_name, checks, expected) => {
    expect(formatFixChecksContext({ ...base, checks }).split('\n')).toEqual(expected);
  });

  it('names only, with no head and no PR URL', () => {
    const out = formatFixChecksContext({
      prNumber: 7,
      prUrl: null,
      headSha: null,
      namesOnly: true,
      checks: [check('e2e', { conclusion: null, required: null, url: null })],
    });
    expect(out).toBe('## Failing checks on #7\n\n- `e2e`');
  });
});

describe('readFixChecksContext', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;

  beforeEach(async () => {
    testDb = await createTestDb();
    await seedUser(testDb.db, { id: 'owner-a' });
    await testDb.db.insert(workspaces).values({ id: 'ws-a', ownerId: 'owner-a', name: 'A' });
    await testDb.db.insert(repositories).values({
      id: 'repo-a', workspaceId: 'ws-a', name: 'Acme/App', url: 'https://github.com/Acme/App', defaultBranch: 'main',
    });
  });

  afterEach(async () => {
    await testDb.cleanup();
    vi.restoreAllMocks();
  });

  async function insertPr(summary: Record<string, unknown>, workspaceId = 'ws-a'): Promise<void> {
    await testDb.db.insert(pullRequests).values({
      id: 'pr-1', workspaceId, repositoryId: 'repo-a', owner: 'Acme', repo: 'App', number: 42, state: 'open',
      lastSummary: { url: 'https://github.com/Acme/App/pull/42', headSha: 'sha-head', checks: { failed: 2 }, ...summary },
    });
  }

  async function insertLedger(rows: Array<{ name: string; state: string; required?: boolean | null; headSha?: string }>) {
    await testDb.db.insert(prCheckStates).values(
      rows.map((r, i) => ({
        id: `cs-${i}`,
        repoFullName: 'acme/app',
        headSha: r.headSha ?? 'sha-head',
        name: r.name,
        source: 'check_run',
        state: r.state,
        required: r.required ?? null,
        rawState: r.state === 'failure' ? 'FAILURE' : 'SUCCESS',
        url: `https://ci.example/${r.name}`,
      })),
    );
  }

  it.each([
    ['no linked PR', null],
    ['a PR id from nowhere', 'pr-missing'],
  ])('is empty with %s', async (_name, pullRequestId) => {
    expect(await readFixChecksContext({ workspaceId: 'ws-a', pullRequestId })).toBe('');
  });

  it('names the failing checks of the head commit from the ledger, and only those', async () => {
    await insertPr({});
    await insertLedger([
      { name: 'lint', state: 'failure', required: true },
      { name: 'unit', state: 'success', required: true },
      { name: 'docs', state: 'failure', required: false },
      { name: 'old', state: 'failure', required: true, headSha: 'sha-old' },
    ]);
    const live = vi.spyOn(githubService, 'listFailingCheckNames');
    const out = await readFixChecksContext({ workspaceId: 'ws-a', pullRequestId: 'pr-1' });
    expect(out).toContain('- `lint` — failure — required — https://ci.example/lint');
    expect(out).toContain('- `docs` — failure — optional — https://ci.example/docs');
    expect(out).not.toContain('unit');
    expect(out).not.toContain('old');
    expect(live).not.toHaveBeenCalled();
  });

  it('does not read another workspace\'s PR', async () => {
    await testDb.db.insert(workspaces).values({ id: 'ws-b', ownerId: 'owner-a', name: 'B' });
    await insertPr({}, 'ws-b');
    await insertLedger([{ name: 'lint', state: 'failure', required: true }]);
    expect(await readFixChecksContext({ workspaceId: 'ws-a', pullRequestId: 'pr-1' })).toBe('');
  });

  it('falls back to the live names when the ledger is empty but the summary counts failures', async () => {
    await insertPr({});
    const live = vi
      .spyOn(githubService, 'listFailingCheckNames')
      .mockResolvedValue({ headSha: 'sha-live1234', names: ['e2e', 'lint'] });
    const out = await readFixChecksContext({ workspaceId: 'ws-a', pullRequestId: 'pr-1' });
    expect(live).toHaveBeenCalledWith('ws-a', 'Acme', 'App', 42);
    expect(out.split('\n')).toEqual([
      '## Failing checks on #42 (head sha-liv)',
      '',
      '- `e2e`',
      '- `lint`',
      '',
      'All checks: https://github.com/Acme/App/pull/42/checks',
    ]);
  });

  it.each([
    ['the summary counts no failures', { checks: { failed: 0 } }, { headSha: 'x', names: ['lint'] }],
    ['the live read fails', {}, null],
    ['the live read finds nothing', {}, { headSha: 'x', names: [] }],
  ])('is empty when %s', async (_name, summary, liveAnswer) => {
    await insertPr(summary);
    vi.spyOn(githubService, 'listFailingCheckNames').mockResolvedValue(liveAnswer);
    expect(await readFixChecksContext({ workspaceId: 'ws-a', pullRequestId: 'pr-1' })).toBe('');
  });

  it('never throws: a failed read sends the prompt alone', async () => {
    await insertPr({});
    vi.spyOn(githubService, 'listFailingCheckNames').mockRejectedValue(new Error('boom'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await readFixChecksContext({ workspaceId: 'ws-a', pullRequestId: 'pr-1' })).toBe('');
  });
});
