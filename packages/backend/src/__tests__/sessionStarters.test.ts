import { describe, expect, it } from 'vitest';
import {
  SESSION_STARTER_PROMPTS,
  sessionStarters,
  starterKindForPr,
  starterPromptWithPr,
  type SessionStarterPr,
} from '@talyn/shared';

function pr(overrides: Partial<SessionStarterPr> & { summary?: Partial<SessionStarterPr['summary']> } = {}): SessionStarterPr {
  const { summary, ...rest } = overrides;
  return {
    id: 'pr-1',
    repositoryId: 'r1',
    owner: 'acme',
    repo: 'app',
    number: 1,
    state: 'open',
    authored: true,
    reviewRequested: false,
    ...rest,
    summary: { title: 'Title', url: 'https://github.com/acme/app/pull/1', mergeable: 'MERGEABLE', blockingReason: null, ...summary },
  };
}

describe('starterKindForPr', () => {
  it.each([
    ['failing checks on my PR', pr({ summary: { blockingReason: 'checks_failed' } }), 'fix_checks'],
    ['conflicts by blocking reason', pr({ summary: { blockingReason: 'merge_conflicts' } }), 'resolve_conflicts'],
    ['conflicts by mergeable state', pr({ summary: { mergeable: 'CONFLICTING' } }), 'resolve_conflicts'],
    ['changes requested', pr({ summary: { blockingReason: 'changes_requested' } }), 'address_review'],
    ['unresolved threads', pr({ summary: { unresolvedReviewThreads: 2 } }), 'address_review'],
    ['checks win over conflicts', pr({ summary: { blockingReason: 'checks_failed', mergeable: 'CONFLICTING' } }), 'fix_checks'],
    ['a clean PR of mine', pr(), null],
    ['zero unresolved threads', pr({ summary: { unresolvedReviewThreads: 0 } }), null],
    ['review requested of me', pr({ authored: false, reviewRequested: true }), 'review'],
    ['review requested on a draft', pr({ authored: false, reviewRequested: true, summary: { draft: true } }), null],
    ['someone else failing, no review asked', pr({ authored: false, summary: { blockingReason: 'checks_failed' } }), null],
    ['a closed PR', pr({ state: 'closed', summary: { blockingReason: 'checks_failed' } }), null],
    ['a merged PR', pr({ state: 'merged', summary: { blockingReason: 'checks_failed' } }), null],
  ])('%s', (_name, row, kind) => {
    expect(starterKindForPr(row)).toBe(kind);
  });
});

describe('sessionStarters', () => {
  it('falls back to general starters with no pull requests', () => {
    expect(sessionStarters([]).map((s) => s.kind)).toEqual(['explain', 'tests']);
    expect(sessionStarters([]).every((s) => s.pr === null && s.detail === null)).toBe(true);
  });

  it('puts pull request jobs first, in a fixed order, and caps at the limit', () => {
    const rows = [
      pr({ id: 'a', number: 5, authored: false, reviewRequested: true }),
      pr({ id: 'b', number: 6, summary: { blockingReason: 'changes_requested' } }),
      pr({ id: 'c', number: 7, summary: { blockingReason: 'checks_failed' } }),
      pr({ id: 'd', number: 8, summary: { mergeable: 'CONFLICTING' } }),
    ];
    expect(sessionStarters(rows).map((s) => s.kind)).toEqual(['fix_checks', 'resolve_conflicts', 'address_review']);
    expect(sessionStarters(rows, 10).map((s) => s.kind)).toEqual([
      'fix_checks', 'resolve_conflicts', 'address_review', 'review', 'explain', 'tests',
    ]);
  });

  it('keeps one starter per kind, on the newest pull request', () => {
    const rows = [
      pr({ id: 'old', number: 3, summary: { blockingReason: 'checks_failed' } }),
      pr({ id: 'new', number: 9, summary: { blockingReason: 'checks_failed' } }),
    ];
    const starters = sessionStarters(rows);
    expect(starters.map((s) => s.key)).toEqual(['fix_checks:new', 'explain', 'tests']);
    expect(starters[0].pr).toEqual({ id: 'new', repositoryId: 'r1', owner: 'acme', repo: 'app', number: 9, url: 'https://github.com/acme/app/pull/1' });
  });

  it('fills up with general starters after pull request jobs', () => {
    const starters = sessionStarters([pr({ summary: { blockingReason: 'checks_failed' } })]);
    expect(starters.map((s) => s.kind)).toEqual(['fix_checks', 'explain', 'tests']);
  });

  it.each([
    ['with a title', { title: 'Add billing' }, '#1 Add billing'],
    ['without a title', { title: undefined }, 'acme/app#1'],
  ])('names the pull request %s', (_name, summary, detail) => {
    const [starter] = sessionStarters([pr({ summary: { blockingReason: 'checks_failed', ...summary } })]);
    expect(starter.detail).toBe(detail);
  });

  it.each([[0, 0], [-1, 0], [1, 1], [2.7, 2]])('limit %s gives %s starters', (limit, count) => {
    expect(sessionStarters([], limit)).toHaveLength(count);
  });

  it('does not reorder the rows it was given', () => {
    const rows = [pr({ id: 'a', number: 1 }), pr({ id: 'b', number: 2 })];
    sessionStarters(rows);
    expect(rows.map((r) => r.id)).toEqual(['a', 'b']);
  });
});

describe('starterPromptWithPr', () => {
  it.each(['fix_checks', 'resolve_conflicts', 'address_review', 'review'] as const)('names the pull request for %s', (kind) => {
    expect(SESSION_STARTER_PROMPTS[kind]).toContain('this pull request');
  });

  it('puts the URL in place of "this pull request"', () => {
    const [starter] = sessionStarters([pr({ summary: { blockingReason: 'checks_failed' } })]);
    expect(starterPromptWithPr(starter)).toBe(
      'Find out why the CI checks fail on pull request https://github.com/acme/app/pull/1. Fix the cause and push the fix.',
    );
  });

  it('falls back to owner/repo#number without a URL', () => {
    const [starter] = sessionStarters([pr({ number: 4, summary: { blockingReason: 'changes_requested', url: undefined } })]);
    expect(starterPromptWithPr(starter)).toContain('on pull request acme/app#4.');
  });

  it('leaves a general prompt alone', () => {
    const starter = sessionStarters([]).find((s) => s.kind === 'explain');
    expect(starter && starterPromptWithPr(starter)).toBe(SESSION_STARTER_PROMPTS.explain);
  });
});
