/**
 * Matching a judge's keep back to the candidate it is about.
 *
 * On 2026-10-07 a judge kept five of sixteen findings, a blocker among them, and
 * the review recorded "Kept 0, dropped 16". The keeps were matched by a key
 * computed again from the judge's own text, the text had changed, and every
 * candidate with no match was marked rejected. What is pinned here is that a
 * keep is matched by its id, and that a keep which still cannot be placed never
 * hides a finding.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  CODE_REVIEW_FINDINGS_SENTINEL,
  codeReviewDedupeKey,
  parseCodeReviewFindings,
  type RawCodeReviewFinding,
} from '@talyn/shared';
import { createTestDb, seedUser } from './helpers/testDb.js';
import {
  prCodeReviewFindings,
  prCodeReviews,
  pullRequests,
  repositories,
  workspaces,
} from '../db/schema.js';
import { applyJudgement } from '../services/codeReview/findings.js';
import { matchJudgeKeep } from '../services/codeReview/executor.js';
import { buildJudgePrompt } from '../services/codeReview/lenses.js';

function keep(over: Partial<RawCodeReviewFinding> = {}): RawCodeReviewFinding {
  return {
    severity: 'major',
    category: 'correctness',
    file: 'src/a.ts',
    lineStart: 10,
    lineEnd: 10,
    anchor: 'const user = await getUser(id)',
    title: 'getUser can return undefined',
    body: 'body',
    suggestion: null,
    confidence: 80,
    ...over,
  };
}

const storedUnverified = codeReviewDedupeKey({
  filePath: 'src/a.ts',
  title: 'getUser can return undefined',
  anchor: 'const user = await getUser(id)',
  anchorVerified: false,
});
const storedVerified = codeReviewDedupeKey({
  filePath: 'src/a.ts',
  title: 'getUser can return undefined',
  anchor: 'const user = await getUser(id)',
  anchorVerified: true,
});

describe('matchJudgeKeep', () => {
  it('uses the id the judge was given, whatever else it changed', () => {
    const keys = new Set(['abc123', 'def456']);
    const changed = keep({ id: 'abc123', title: 'A sharper title', anchor: 'something else' });
    expect(matchJudgeKeep(changed, keys, true)).toBe('abc123');
  });

  it.each([
    ['stored unverified, now verified', storedUnverified, true],
    ['stored unverified, still unverified', storedUnverified, false],
    ['stored verified, now unverified', storedVerified, false],
    ['stored verified, still verified', storedVerified, true],
  ])('falls back to the computed key with no id: %s', (_label, stored, verifiedNow) => {
    expect(matchJudgeKeep(keep(), new Set([stored]), verifiedNow)).toBe(stored);
  });

  it.each([
    ['an id that is not a candidate', keep({ id: 'nope', title: 'Reworded by the judge' })],
    ['no id and a reworded title', keep({ title: 'Reworded by the judge' })],
    ['no id and another file', keep({ file: 'src/b.ts' })],
  ])('answers null for %s', (_label, finding) => {
    expect(matchJudgeKeep(finding, new Set([storedUnverified]), false)).toBeNull();
  });

  it('prefers a wrong id over nothing only when the computed key still matches', () => {
    expect(matchJudgeKeep(keep({ id: 'nope' }), new Set([storedUnverified]), false)).toBe(
      storedUnverified
    );
  });
});

describe('the judge contract', () => {
  it('asks for the id on every keep', () => {
    const prompt = buildJudgePrompt(
      {
        ref: 'acme/app#7',
        title: 't',
        body: '',
        headBranch: 'h',
        baseBranch: 'main',
        files: [],
        chunkIndex: 1,
        chunkTotal: 1,
      },
      [{ id: 'abc123', severity: 'major', filePath: 'src/a.ts', lines: '10', title: 'T', body: 'B' }]
    );
    expect(prompt).toContain('### abc123');
    expect(prompt).toContain('MUST carry one more field: `"id"`');
  });

  it.each([
    ['a plain id', { id: 'abc123' }, 'abc123'],
    ['an id with spaces round it', { id: '  abc123  ' }, 'abc123'],
    ['no id', {}, undefined],
    ['an empty id', { id: '' }, undefined],
    ['an id that is not a string', { id: 42 }, undefined],
  ])('parses %s', (_label, extra, expected) => {
    const text = [
      CODE_REVIEW_FINDINGS_SENTINEL,
      '```json',
      JSON.stringify({ schema: 1, findings: [{ ...keep(), ...extra }] }),
      '```',
    ].join('\n');
    const parsed = parseCodeReviewFindings(text);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.findings[0]!.id).toBe(expected);
  });
});

describe('applyJudgement', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;

  beforeEach(async () => {
    testDb = await createTestDb();
    await seedUser(testDb.db, { id: 'owner-a' });
    await testDb.db.insert(workspaces).values({ id: 'ws-a', ownerId: 'owner-a', name: 'A' });
    await testDb.db.insert(repositories).values({
      id: 'repo-a',
      workspaceId: 'ws-a',
      name: 'acme/app',
      url: 'https://github.com/acme/app',
    });
    await testDb.db.insert(pullRequests).values({
      id: 'pr-a',
      workspaceId: 'ws-a',
      repositoryId: 'repo-a',
      owner: 'acme',
      repo: 'app',
      number: 7,
      state: 'open',
    });
    await testDb.db.insert(prCodeReviews).values({
      id: 'rev-1',
      workspaceId: 'ws-a',
      repositoryId: 'repo-a',
      pullRequestId: 'pr-a',
      cycle: 3,
      preset: 'standard',
      runsTotal: 5,
      phase: 'validating',
    });
    await testDb.db.insert(prCodeReviewFindings).values(
      ['kept', 'named', 'silent'].map((key) => ({
        id: `f-${key}`,
        reviewId: 'rev-1',
        workspaceId: 'ws-a',
        pullRequestId: 'pr-a',
        dedupeKey: key,
        severity: 'major',
        title: `Finding ${key}`,
        lastSeenCycle: 3,
      }))
    );
  });

  afterEach(async () => {
    await testDb.cleanup();
  });

  async function verdicts() {
    const rows = await testDb.db
      .select({
        key: prCodeReviewFindings.dedupeKey,
        verdict: prCodeReviewFindings.verdict,
        disposition: prCodeReviewFindings.disposition,
        reason: prCodeReviewFindings.verdictReason,
        severity: prCodeReviewFindings.severity,
      })
      .from(prCodeReviewFindings)
      .where(eq(prCodeReviewFindings.reviewId, 'rev-1'));
    return Object.fromEntries(rows.map((r) => [r.key, r]));
  }

  it('confirms the keeps and rejects everything else when every keep matched', async () => {
    const out = await applyJudgement(
      'rev-1',
      3,
      [{ key: 'kept', severity: 'blocker' }],
      null as never,
      new Map([['named', 'The caller validates this.']])
    );
    expect(out).toEqual({ confirmed: 1, rejected: 2 });
    const v = await verdicts();
    expect(v.kept).toMatchObject({ verdict: 'confirmed', severity: 'blocker', disposition: 'open' });
    expect(v.named).toMatchObject({ verdict: 'rejected', reason: 'The caller validates this.' });
    expect(v.silent).toMatchObject({ verdict: 'rejected', disposition: 'stale' });
  });

  it('rejects only the named drops when a keep could not be matched', async () => {
    const out = await applyJudgement(
      'rev-1',
      3,
      [],
      null as never,
      new Map([['named', 'The caller validates this.']]),
      { onlyNamedDrops: true }
    );
    expect(out).toEqual({ confirmed: 0, rejected: 1 });
    const v = await verdicts();
    expect(v.named).toMatchObject({ verdict: 'rejected', disposition: 'stale' });
    // The judge kept one of these two. Neither may be hidden.
    expect(v.kept).toMatchObject({ verdict: 'unvalidated', disposition: 'open' });
    expect(v.silent).toMatchObject({ verdict: 'unvalidated', disposition: 'open' });
  });

  it('rejects nothing when a keep could not be matched and no drop was named', async () => {
    const out = await applyJudgement('rev-1', 3, [], null as never, new Map(), {
      onlyNamedDrops: true,
    });
    expect(out).toEqual({ confirmed: 0, rejected: 0 });
    const v = await verdicts();
    for (const key of ['kept', 'named', 'silent']) {
      expect(v[key]).toMatchObject({ verdict: 'unvalidated', disposition: 'open' });
    }
  });

  it('never rejects a finding the judge both kept and named as dropped', async () => {
    await applyJudgement(
      'rev-1',
      3,
      [{ key: 'kept', severity: 'major' }],
      null as never,
      new Map([['kept', 'Duplicate of another one.']]),
      { onlyNamedDrops: true }
    );
    expect((await verdicts()).kept).toMatchObject({ verdict: 'confirmed', disposition: 'open' });
  });
});
