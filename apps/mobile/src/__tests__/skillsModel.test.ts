import type { ListSkillsResponse, SkillSummary } from '@talyn/shared';

import {
  NAME_AND_CONTENT_REQUIRED, deleteSkillMessage, repoSkillsMessage, selectedRepositoryId, skillCreateRequest, skillDirty, skillDraftError,
  skillDraftOf, skillSaveFailureTitle, skillSubtitle, skillUpdateRequest, splitSkills,
} from '../features/skills/model';

const skill = (overrides: Partial<SkillSummary>): SkillSummary => ({ key: 'k', source: 'platform', name: 'n', description: '', ...overrides });
const response = (overrides: Partial<ListSkillsResponse> = {}): ListSkillsResponse =>
  ({ platform: [], repo: [], repoStatus: 'ok', usage: {}, ...overrides });

describe('lists', () => {
  it('splits by source and ignores anything else', () => {
    const out = splitSkills(response({
      platform: [skill({ key: 'p', id: 'p1' }), skill({ key: 'l', source: 'local' })],
      repo: [skill({ key: 'r', source: 'repo', repoPath: '.claude/skills/r/SKILL.md' })],
    }));
    expect(out.platform.map((s) => s.key)).toEqual(['p']);
    expect(out.repo.map((s) => s.key)).toEqual(['r']);
  });

  it.each([[null], [undefined]])('nothing loaded (%j) is empty', (value) => expect(splitSkills(value)).toEqual({ platform: [], repo: [] }));

  it.each([
    [[], null, null], [[], 'r1', null], [[{ id: 'r1' }, { id: 'r2' }], null, 'r1'], [[{ id: 'r1' }, { id: 'r2' }], 'r2', 'r2'],
    [[{ id: 'r1' }], 'gone', 'r1'],
  ])('repositories %j with %j selected picks %j', (repos, selected, expected) => expect(selectedRepositoryId(repos, selected)).toBe(expected));

  it.each([
    [0, response(), [], 'No repositories in this workspace.'],
    [2, response({ repoStatus: 'error' }), [], 'Could not load skills from GitHub. Try refreshing.'],
    [1, response({ repoStatus: 'none' }), [], 'No skills in this repo. Talyn looked in .claude/skills on the default branch.'],
    [1, response(), [], 'No skills in this repo. Talyn looked in .claude/skills on the default branch.'],
    [1, response(), [skill({ source: 'repo' })], null],
    [1, null, [], 'No skills in this repo. Talyn looked in .claude/skills on the default branch.'],
  ] as const)('%i repositories, status %j', (count, value, skills, message) =>
    expect(repoSkillsMessage(count, value, [...skills] as SkillSummary[])).toBe(message));

  it.each([
    [{ description: 'Reviews', repoPath: 'a' }, 'Reviews'], [{ description: '', repoPath: '.claude/skills/x/SKILL.md' }, '.claude/skills/x/SKILL.md'],
    [{ description: '' }, undefined],
  ])('subtitle of %j', (value, expected) => expect(skillSubtitle(value)).toBe(expected));
});

describe('drafts', () => {
  const full = { name: 'pr-review', description: 'Reviews', content: '# Body' };
  it.each([
    [full, null], [{ ...full, name: '  ' }, NAME_AND_CONTENT_REQUIRED], [{ ...full, content: '\n' }, NAME_AND_CONTENT_REQUIRED],
    [{ ...full, description: '' }, null], [{ name: '', description: '', content: '' }, NAME_AND_CONTENT_REQUIRED],
  ])('error for %j', (draft, error) => expect(skillDraftError(draft)).toBe(error));

  it.each([
    ['empty new', null, { name: '', description: '', content: '' }, false],
    ['new with text', null, { name: '', description: '', content: 'x' }, true],
    ['new with spaces', null, { name: ' ', description: '', content: '' }, false],
    ['unchanged', full, full, false],
    ['renamed', full, { ...full, name: 'other' }, true],
    ['description changed', full, { ...full, description: '' }, true],
  ])('dirty: %s', (_name, original, draft, dirty) => expect(skillDirty(original, draft)).toBe(dirty));

  it('builds the requests', () => {
    expect(skillDraftOf(null)).toEqual({ name: '', description: '', content: '' });
    expect(skillDraftOf({ ...full })).toEqual(full);
    expect(skillCreateRequest('w1', full)).toEqual({ workspaceId: 'w1', ...full });
    expect(skillUpdateRequest(full)).toEqual(full);
  });

  it.each([[true, 'Could not update skill'], [false, 'Could not create skill']])('failure title, editing %s', (editing, title) =>
    expect(skillSaveFailureTitle(editing)).toBe(title));

  it('explains a delete', () => expect(deleteSkillMessage('pr-review')).toBe('pr-review is removed from this workspace. Tasks that already ran with it are unaffected.'));
});
