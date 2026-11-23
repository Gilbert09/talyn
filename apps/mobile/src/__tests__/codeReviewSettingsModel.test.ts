import {
  AUTO_KEEP_DEFAULT_ERROR_CODE, AUTO_REVIEW_ERROR_CODE, CODE_REVIEW_REVIEWER_SKILL_MAX_BYTES, USAGE_EXHAUSTED_ERROR_CODE,
  type CodeReviewCustomReviewer, type ListSkillsResponse, type SkillSummary,
} from '@talyn/shared';
import { Alert } from 'react-native';

import {
  addReviewerPatch, codeReviewPatchBody, codeReviewSettingsOf, emptySkillsText, lensStatRows, removeReviewerPatch, repoSkillsError,
  reviewerProblems, reviewerRows, reviewersBadge, reviewerSkillRefusal, skillGroups, sortSkillsForPicker,
} from '../features/codeReviewSettings/model';
import { BILLING_ROUTE, paidFeatureRefusal, showPaidFeatureRefusal } from '../lib/errors';

const mockNavigate = jest.fn();
jest.mock('expo-router', () => ({ router: { navigate: (...args: unknown[]) => mockNavigate(...args) } }));

const REPO_KEY = 'repo:acme/api:security';
const TALYN_KEY = 'platform:abc123';
const reviewer = (skillKey: string, name = 'R'): CodeReviewCustomReviewer => ({ skillKey, name });
const skill = (overrides: Partial<SkillSummary> = {}): SkillSummary => ({ key: TALYN_KEY, source: 'platform', name: 'Skill', description: '', ...overrides });

describe('codeReviewSettingsOf', () => {
  it.each([
    ['nothing stored', undefined, {}, { preset: 'standard', autoReview: false, builtInReviewers: true, autoFixSeverity: 'blocker', reportingBar: 'minor' }],
    ['a stored preset', { preset: 'deep' as const }, {}, { preset: 'deep' }],
    ['a pending change over the stored one', { preset: 'deep' as const, autoReview: false }, { autoReview: true }, { preset: 'deep', autoReview: true }],
    ['an unknown preset', { preset: 'huge' as never }, {}, { preset: 'standard' }],
    ['built-in reviewers turned off', { builtInReviewers: false }, {}, { builtInReviewers: false }],
    ['a pending auto-fix floor', null, { autoFix: true, autoFixSeverity: 'major' as const }, { autoFix: true, autoFixSeverity: 'major' }],
  ])('%s', (_name, stored, pending, expected) => {
    expect(codeReviewSettingsOf(stored, pending)).toMatchObject(expected);
  });

  it('drops a stored local reviewer', () => {
    expect(codeReviewSettingsOf({ customReviewers: [reviewer('local:mine'), reviewer(REPO_KEY)] }).customReviewers)
      .toEqual([{ skillKey: REPO_KEY, name: 'security' }]);
  });
});

describe('codeReviewPatchBody', () => {
  it.each([
    [{ autoReview: true }],
    [{ preset: 'quick' as const }],
    [{ customReviewers: [reviewer(TALYN_KEY)] }],
  ])('sends only the changed key under codeReview: %j', (patch) => {
    expect(codeReviewPatchBody(patch)).toEqual({ settings: { codeReview: patch } });
  });
});

describe('reviewersBadge', () => {
  it.each([
    [true, 0, "Talyn's"],
    [false, 0, 'None'],
    [true, 1, "Talyn's and 1 of your own"],
    [false, 2, '2 of your own'],
    [true, 3, "Talyn's and 3 of your own"],
  ])('built-in %s with %i custom', (builtIn, custom, expected) => {
    expect(reviewersBadge(builtIn, custom)).toBe(expected);
  });
});

describe('reviewerProblems', () => {
  const problem = "Turn on Talyn's reviewers or add at least one of your own.";
  it.each([
    ['built-in on, none of your own', true, [], { off: problem, removeLast: null }],
    ['built-in on, one of your own', true, [reviewer(TALYN_KEY)], { off: null, removeLast: null }],
    ['built-in off, one of your own', false, [reviewer(TALYN_KEY)], { off: null, removeLast: problem }],
    ['built-in off, two of your own', false, [reviewer(TALYN_KEY), reviewer(REPO_KEY)], { off: null, removeLast: null }],
    ['built-in on, two of your own', true, [reviewer(TALYN_KEY), reviewer(REPO_KEY)], { off: null, removeLast: null }],
  ])('%s', (_name, builtInReviewers, customReviewers, expected) => {
    expect(reviewerProblems({ builtInReviewers, customReviewers })).toEqual(expected);
  });
});

describe('reviewerSkillRefusal', () => {
  it.each([
    ['a Talyn skill', skill(), [], null],
    ['a repository skill', skill({ key: REPO_KEY, source: 'repo' }), [], null],
    ['a skill on this machine', skill({ key: 'local:mine', source: 'local' }), [], 'On this machine only. Talyn runs reviews on its servers.'],
    ['a skill already added', skill(), [reviewer(TALYN_KEY)], 'Already a reviewer'],
    ['a skill at the size limit', skill({ contentSize: CODE_REVIEW_REVIEWER_SKILL_MAX_BYTES }), [], null],
    ['a skill over the size limit', skill({ contentSize: CODE_REVIEW_REVIEWER_SKILL_MAX_BYTES + 1 }), [], 'Too large to run as a reviewer'],
    ['a local skill already added says local first', skill({ key: 'local:x', source: 'local' }), [reviewer('local:x')],
      'On this machine only. Talyn runs reviews on its servers.'],
  ])('%s', (_name, given, added, expected) => {
    expect(reviewerSkillRefusal(given, added)).toBe(expected);
  });
});

describe('reviewer patches', () => {
  it('adds a reviewer with the skill name', () => {
    expect(addReviewerPatch([reviewer(REPO_KEY, 'security')], { key: TALYN_KEY, name: 'Style' }))
      .toEqual({ customReviewers: [{ skillKey: REPO_KEY, name: 'security' }, { skillKey: TALYN_KEY, name: 'Style' }] });
  });
  it.each([
    [[reviewer(REPO_KEY), reviewer(TALYN_KEY)], REPO_KEY, [reviewer(TALYN_KEY)]],
    [[reviewer(REPO_KEY)], REPO_KEY, []],
    [[reviewer(REPO_KEY)], 'platform:missing', [reviewer(REPO_KEY)]],
  ])('removes %j less %s', (list, key, expected) => {
    expect(removeReviewerPatch(list, key)).toEqual({ customReviewers: expected });
  });
});

describe('reviewerRows', () => {
  it.each([
    [reviewer(REPO_KEY, 'security'), { repo: true, source: 'acme/api', scope: 'Runs on pull requests in acme/api only.' }],
    [reviewer(TALYN_KEY, 'Style'), { repo: false, source: 'Talyn skill', scope: null }],
  ])('%j', (given, expected) => {
    expect(reviewerRows([given])[0]).toMatchObject({ skillKey: given.skillKey, name: given.name, ...expected });
  });
});

describe('lensStatRows', () => {
  it.each([
    [{ lens: 'correctness', raised: 10, kept: 4 }, [], { label: 'Logic', percent: 40, text: '4 of 10 kept' }],
    [{ lens: 'security', raised: 0, kept: 0 }, [], { label: 'Security', percent: 0, text: '0 of 0 kept' }],
    [{ lens: 'logic', raised: 3, kept: 3 }, [], { percent: 100 }],
    [{ lens: 'logic', raised: 3, kept: 1 }, [], { percent: 33 }],
    [{ lens: `skill:${TALYN_KEY}`, raised: 2, kept: 1 }, [reviewer(TALYN_KEY, 'Style')], { label: 'Style', percent: 50 }],
    [{ lens: `skill:${REPO_KEY}`, raised: 2, kept: 2 }, [], { label: 'security' }],
    [{ lens: 'mystery', raised: 1, kept: 0 }, [], { label: 'mystery' }],
  ])('%j', (stat, reviewers, expected) => {
    expect(lensStatRows([stat], reviewers)[0]).toMatchObject(expected);
  });
});

describe('the skill picker', () => {
  const repoSkill = skill({ key: 'repo:acme/api:b', source: 'repo', name: 'Beta', description: 'checks security' });
  const repoSkillA = skill({ key: 'repo:acme/api:a', source: 'repo', name: 'Alpha' });
  const talyn = skill({ key: 'platform:1', source: 'platform', name: 'Aardvark' });
  const used = skill({ key: 'platform:2', source: 'platform', name: 'Zed' });

  it.each([
    ['usage count first', { 'platform:2': { count: 3, lastUsedAt: '2026-01-01' } }, '', ['Zed', 'Alpha', 'Beta', 'Aardvark']],
    ['recency breaks a count tie', { 'platform:1': { count: 1, lastUsedAt: '2026-02-01' }, 'platform:2': { count: 1, lastUsedAt: '2026-03-01' } }, '',
      ['Zed', 'Aardvark', 'Alpha', 'Beta']],
    ['never used: repository first, then name', {}, '', ['Alpha', 'Beta', 'Aardvark', 'Zed']],
    ['search by name', {}, 'zed', ['Zed']],
    ['search by description', {}, 'SECURITY', ['Beta']],
    ['search with spaces only', {}, '   ', ['Alpha', 'Beta', 'Aardvark', 'Zed']],
    ['no match', {}, 'nothing', []],
  ])('%s', (_name, usage, query, expected) => {
    expect(sortSkillsForPicker([repoSkill, talyn, used, repoSkillA], usage, query).map((item) => item.name)).toEqual(expected);
  });

  const response = (overrides: Partial<ListSkillsResponse> = {}): ListSkillsResponse =>
    ({ repo: [repoSkill], platform: [talyn], repoStatus: 'ok', usage: {}, ...overrides });

  it.each([
    ['both groups', response(), 'acme/api', '', [['In acme/api', ['Beta']], ['On Talyn', ['Aardvark']]]],
    ['no repository name', response(), null, '', [['In the repository', ['Beta']], ['On Talyn', ['Aardvark']]]],
    ['no repository skills', response({ repo: [] }), 'acme/api', '', [['On Talyn', ['Aardvark']]]],
    ['a search that leaves one group', response(), 'acme/api', 'aard', [['On Talyn', ['Aardvark']]]],
    ['nothing at all', response({ repo: [], platform: [] }), 'acme/api', '', []],
  ])('groups: %s', (_name, given, repoName, query, expected) => {
    expect(skillGroups(given, repoName, query).map((group) => [group.title, group.skills.map((item) => item.name)])).toEqual(expected);
  });

  it('has no groups before the answer', () => {
    expect(skillGroups(undefined, 'acme/api', '')).toEqual([]);
  });

  it.each([
    ['', 'No skills found. Commit one under .claude/skills in the repository, or add one in Settings, Skills.'],
    ['  ', 'No skills found. Commit one under .claude/skills in the repository, or add one in Settings, Skills.'],
    ['x', 'No skills match your search.'],
  ])('empty text for %j', (query, expected) => {
    expect(emptySkillsText(query)).toBe(expected);
  });

  it.each([
    [undefined, null],
    [{ repoStatus: 'ok' as const }, null],
    [{ repoStatus: 'none' as const }, null],
    [{ repoStatus: 'error' as const }, "Could not load this repository's skills."],
    [{ repoStatus: 'error' as const, repoError: 'API rate limit exceeded' }, "Could not load this repository's skills: API rate limit exceeded."],
  ])('repository warning for %j', (given, expected) => {
    expect(repoSkillsError(given)).toBe(expected);
  });
});

describe('paidFeatureRefusal', () => {
  it.each([
    ['auto-review', { status: 402, code: AUTO_REVIEW_ERROR_CODE, message: 'x' }, AUTO_REVIEW_ERROR_CODE, 'Review every new PR with Pro'],
    ['auto-keep default', { status: 402, code: AUTO_KEEP_DEFAULT_ERROR_CODE }, AUTO_KEEP_DEFAULT_ERROR_CODE, 'Keep every new PR green with Pro'],
    ['a code without a status', { code: AUTO_REVIEW_ERROR_CODE }, AUTO_REVIEW_ERROR_CODE, 'Review every new PR with Pro'],
  ])('%s', (_name, error, code, title) => {
    expect(paidFeatureRefusal(error)).toMatchObject({ code, title });
  });

  it.each([
    ['null', null],
    ['a string', 'auto_review_requires_unlimited'],
    ['a plain error', new Error('boom')],
    ['a box refusal', { status: 402, code: USAGE_EXHAUSTED_ERROR_CODE }],
    ['the code on another status', { status: 400, code: AUTO_REVIEW_ERROR_CODE }],
    ['an unknown code', { status: 402, code: 'something_else' }],
  ])('is null for %s', (_name, error) => {
    expect(paidFeatureRefusal(error)).toBeNull();
  });

  it('uses web copy, not the server sentence', () => {
    expect(paidFeatureRefusal({ status: 402, code: AUTO_REVIEW_ERROR_CODE, message: 'Upgrade to Unlimited' })?.message)
      .toBe('Reviewing every new pull request automatically is a Pro feature. You can still review PRs one at a time on Free.');
  });

  it('offers Plan and credits', () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    showPaidFeatureRefusal(paidFeatureRefusal({ status: 402, code: AUTO_REVIEW_ERROR_CODE })!);
    const buttons = alert.mock.calls[0]![2]!;
    expect(buttons.map((button) => button.text)).toEqual(['Close', 'Plan and credits']);
    buttons[1]!.onPress!();
    expect(mockNavigate).toHaveBeenCalledWith(BILLING_ROUTE);
    alert.mockRestore();
  });
});
