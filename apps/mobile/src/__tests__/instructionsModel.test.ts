import {
  DEFAULT_PROMPT_TEMPLATES, MAX_REPOSITORY_INSTRUCTION_BYTES, PROMPT_TEMPLATE_MAX_CHARS, defaultPromptTemplateHash,
  type PromptKind, type PromptTemplateOverride, type RepositoryInstructionsSummary,
} from '@talyn/shared';

import {
  SAMPLE_PR, byteLength, checkRepositoryInstructions, initialPromptDraft, insertVariableAt, isPromptKind, kb, previewNote, previewRowLabel,
  promptCards, promptEditorState, promptOverride, promptSavedMessage, promptSettingsPatch, renderPromptPreview, repositoryInstructionRows,
  variableGroups,
} from '../features/instructions/model';

const KINDS: PromptKind[] = ['mergeable', 'skill', 'review_fix'];
const override = (kind: PromptKind, template: string, basedOnHash = defaultPromptTemplateHash(kind)): PromptTemplateOverride =>
  ({ template, basedOnHash, updatedAt: '2026-11-01T10:00:00Z' });

describe('sizes', () => {
  it.each([
    ['', 0], ['abc', 3], ['é', 2], ['🙂', 4], ['a\nb', 3],
  ])('byteLength(%j) is %i', (text, bytes) => expect(byteLength(text)).toBe(bytes));

  it.each([
    [0, '0.0 KB'], [512, '0.5 KB'], [1024, '1.0 KB'], [10 * 1024 - 1, '10.0 KB'], [10 * 1024, '10 KB'], [64 * 1024, '64 KB'],
  ])('kb(%i) is %s', (bytes, label) => expect(kb(bytes)).toBe(label));
});

describe('repository instruction rows', () => {
  const repos = [
    { id: 'r1', fullName: 'acme/api', workspaceId: 'w1' },
    { id: 'r2', fullName: 'acme/web', workspaceId: 'w1' },
    { id: 'r3', fullName: 'other/app', workspaceId: 'w2' },
  ];
  const summary = (repositoryId: string, agents: RepositoryInstructionsSummary['agents'], bytes: number): RepositoryInstructionsSummary =>
    ({ repositoryId, agents, bytes, updatedAt: '2026-11-01T00:00:00Z' });

  it.each([
    ['no summaries', null, 'w1', [{ id: 'r1', set: false, detail: undefined }, { id: 'r2', set: false, detail: undefined }]],
    ['one set for both agents', [summary('r1', 'both', 2048)], 'w1',
      [{ id: 'r1', set: true, detail: '2.0 KB · Claude and Codex' }, { id: 'r2', set: false, detail: undefined }]],
    ['codex only, big', [summary('r2', 'codex', 20 * 1024)], 'w1',
      [{ id: 'r1', set: false, detail: undefined }, { id: 'r2', set: true, detail: '20 KB · Codex' }]],
    ['other workspace', [summary('r3', 'claude', 100)], 'w2', [{ id: 'r3', set: true, detail: '0.1 KB · Claude' }]],
    ['no workspace keeps every repository', [], null, [{ id: 'r1', set: false, detail: undefined }, { id: 'r2', set: false, detail: undefined },
      { id: 'r3', set: false, detail: undefined }]],
  ] as const)('%s', (_name, summaries, workspaceId, expected) => {
    const rows = repositoryInstructionRows(repos, summaries as RepositoryInstructionsSummary[] | null, workspaceId);
    expect(rows.map(({ id, set, detail }) => ({ id, set, detail }))).toEqual(expected);
  });
});

describe('repository instructions check', () => {
  const big = 'x'.repeat(MAX_REPOSITORY_INSTRUCTION_BYTES + 1);
  it.each([
    ['empty new', { body: '', agents: 'both' }, null, { empty: true, dirty: false, canSave: false, tooLarge: false }],
    ['whitespace new', { body: '  \n', agents: 'both' }, null, { empty: true, dirty: false, canSave: false, tooLarge: false }],
    ['text new', { body: 'Run npm test', agents: 'both' }, null, { empty: false, dirty: true, canSave: true, tooLarge: false }],
    ['unchanged', { body: 'a', agents: 'claude' }, { body: 'a', agents: 'claude' }, { dirty: false, canSave: false }],
    ['agents changed', { body: 'a', agents: 'codex' }, { body: 'a', agents: 'claude' }, { dirty: true, canSave: true }],
    ['body emptied', { body: '', agents: 'claude' }, { body: 'a', agents: 'claude' }, { dirty: true, canSave: false, empty: true }],
    ['too large', { body: big, agents: 'both' }, null, { tooLarge: true, canSave: false }],
    ['exactly the limit', { body: 'x'.repeat(MAX_REPOSITORY_INSTRUCTION_BYTES), agents: 'both' }, null, { tooLarge: false, canSave: true }],
  ] as const)('%s', (_name, draft, saved, expected) => {
    expect(checkRepositoryInstructions(draft, saved)).toMatchObject(expected);
  });

  it('labels the count against the limit', () => {
    expect(checkRepositoryInstructions({ body: 'x'.repeat(1536), agents: 'both' }, null).count).toBe('1.5 KB of 64 KB');
  });
});

describe('prompt cards', () => {
  it.each([
    ['no settings', undefined, { mergeable: false, skill: false, review_fix: false }],
    ['blank override is not a customization', { prompts: { skill: override('skill', '   ') } }, { mergeable: false, skill: false, review_fix: false }],
    ['one customized', { prompts: { mergeable: override('mergeable', 'Fix {{pr.url}}') } }, { mergeable: true, skill: false, review_fix: false }],
    ['null resets', { prompts: { mergeable: null } }, { mergeable: false, skill: false, review_fix: false }],
  ])('%s', (_name, settings, expected) => {
    const cards = promptCards(settings as never);
    expect(cards.map((card) => card.kind)).toEqual(KINDS);
    expect(Object.fromEntries(cards.map((card) => [card.kind, card.customized]))).toEqual(expected);
  });

  it('marks an override whose default moved', () => {
    const [card] = promptCards({ prompts: { mergeable: override('mergeable', 'Fix {{pr.url}}\n{{gitRules}}', 'old-hash') } });
    expect(card).toMatchObject({ stale: true, updatedAt: '2026-11-01T10:00:00Z' });
  });

  it.each([
    ['mergeable', true], ['skill', true], ['review_fix', true], ['other', false], ['', false], [undefined, false], [3, false],
  ])('isPromptKind(%j) is %s', (value, expected) => expect(isPromptKind(value)).toBe(expected));
});

describe('prompt editor state', () => {
  it.each(KINDS)('%s starts from the default and cannot save unchanged', (kind) => {
    const draft = initialPromptDraft(kind, undefined);
    expect(draft).toEqual({ template: DEFAULT_PROMPT_TEMPLATES[kind], basedOnHash: defaultPromptTemplateHash(kind) });
    expect(promptEditorState(kind, undefined, draft)).toMatchObject({ dirty: false, canSave: false, isDefaultText: true,
      staleDefault: false, saveLabel: 'Save as workspace prompt' });
  });

  it.each([
    ['edited and valid', 'Fix {{pr.url}} please\n{{gitRules}}', { dirty: true, canSave: true }],
    ['missing the required variable', 'Fix it', { dirty: true, canSave: false }],
    ['unknown variable', 'Fix {{pr.url}} {{gitRules}} {{nope}}', { dirty: true, canSave: false }],
    ['empty', '', { dirty: true, canSave: false }],
    ['over the limit', `{{pr.url}}${'x'.repeat(PROMPT_TEMPLATE_MAX_CHARS)}`, { dirty: true, canSave: false }],
  ])('mergeable: %s', (_name, template, expected) => {
    const state = promptEditorState('mergeable', undefined, { template, basedOnHash: defaultPromptTemplateHash('mergeable') });
    expect(state).toMatchObject(expected);
    if (!expected.canSave) expect(state.validation.errors.length).toBeGreaterThan(0);
  });

  it('tracks used variables and the character count', () => {
    const state = promptEditorState('mergeable', undefined, { template: '{{pr.url}} {{ pr.number }}', basedOnHash: 'x' });
    expect([...state.used].sort()).toEqual(['pr.number', 'pr.url']);
    expect(state.chars).toBe('26 chars');
  });

  it('a stale override can save after dismissing the notice alone', () => {
    const saved = override('mergeable', 'Fix {{pr.url}}\n{{gitRules}}', 'old-hash');
    const start = initialPromptDraft('mergeable', saved);
    expect(promptEditorState('mergeable', saved, start)).toMatchObject({ staleDefault: true, dirty: false, saveLabel: 'Save changes' });
    const dismissed = { ...start, basedOnHash: defaultPromptTemplateHash('mergeable') };
    expect(promptEditorState('mergeable', saved, dismissed)).toMatchObject({ staleDefault: false, dirty: true, canSave: true });
  });

  it('builds the override and the PATCH body', () => {
    const now = new Date('2026-11-09T12:00:00Z');
    const value = promptOverride({ template: 'T', basedOnHash: 'h' }, now);
    expect(value).toEqual({ template: 'T', basedOnHash: 'h', updatedAt: '2026-11-09T12:00:00.000Z' });
    expect(promptSettingsPatch('skill', value)).toEqual({ settings: { prompts: { skill: value } } });
    expect(promptSettingsPatch('review_fix', null)).toEqual({ settings: { prompts: { review_fix: null } } });
  });

  it.each([
    ['mergeable', true, 'Keep mergeable / Fix PR prompt saved'],
    ['skill', false, "Skill runs prompt reset to Talyn's default"],
  ] as const)('%s saved=%s', (kind, saved, message) => expect(promptSavedMessage(kind, saved)).toBe(message));
});

describe('insertVariableAt', () => {
  const value = { name: 'pr.url', shape: 'value' as const };
  const block = { name: 'gitRules', shape: 'block' as const };
  it.each([
    ['value at the end', 'Fix ', 4, 4, value, 'Fix {{pr.url}}', 14],
    ['value replaces a selection', 'Fix THIS now', 4, 8, value, 'Fix {{pr.url}} now', 14],
    ['value into empty text', '', 0, 0, value, '{{pr.url}}', 10],
    ['block mid-line gets both newlines', 'ab', 1, 1, block, 'a\n{{gitRules}}\nb', 15],
    ['block at the start needs no leading newline', 'ab', 0, 0, block, '{{gitRules}}\nab', 13],
    ['block after a newline', 'a\nb', 2, 2, block, 'a\n{{gitRules}}\nb', 15],
    ['block before a newline', 'a\nb', 1, 1, block, 'a\n{{gitRules}}\nb', 14],
    ['out-of-range caret clamps to the end', 'ab', 99, 99, value, 'ab{{pr.url}}', 12],
    ['reversed selection inserts at the start', 'abcd', 3, 1, value, 'abc{{pr.url}}d', 13],
  ])('%s', (_name, text, start, end, spec, expected, caret) => {
    expect(insertVariableAt(text, start, end, spec)).toEqual({ text: expected, caret });
  });
});

describe('variable groups and preview', () => {
  it.each(KINDS)('%s groups only the variables it may use, in order', (kind) => {
    const groups = variableGroups(kind);
    const order = ['pr', 'skill', 'review', 'talyn'];
    expect(groups.map((g) => order.indexOf(g.group))).toEqual([...groups.map((g) => order.indexOf(g.group))].sort((a, b) => a - b));
    expect(groups.every((g) => g.items.length > 0)).toBe(true);
    expect(groups[0].group).toBe('pr');
  });

  it('skill runs have skill variables and review fixes have review variables', () => {
    expect(variableGroups('skill').some((g) => g.group === 'skill')).toBe(true);
    expect(variableGroups('mergeable').some((g) => g.group === 'skill')).toBe(false);
    expect(variableGroups('review_fix').some((g) => g.group === 'review')).toBe(true);
  });

  it.each([
    ['mergeable', 'posthog_code'], ['mergeable', 'selfhosted'], ['skill', 'selfhosted'],
  ] as const)('renders %s for %s against the sample PR', (kind, provider) => {
    const out = renderPromptPreview(kind, 'URL {{pr.url}} on {{repo}}', provider);
    expect(out).toBe('URL https://github.com/acme/widgets/pull/128 on acme/widgets');
  });

  it('renders against a tracked row', () => {
    const row = { owner: 'o', repo: 'r', number: 7, summary: { ...SAMPLE_PR.summary, url: 'https://github.com/o/r/pull/7', title: 'T' } } as never;
    expect(renderPromptPreview('mergeable', '{{pr.url}}', 'posthog_code', row)).toBe('https://github.com/o/r/pull/7');
    expect(previewRowLabel(row)).toBe('o/r#7 · T');
  });

  it.each([
    ['skill', 'Rendered with a sample skill so you can see where the SKILL.md lands.'],
    ['mergeable', 'Rendered against the selected PR as it looks right now.'],
    ['review_fix', 'Rendered against the selected PR as it looks right now.'],
  ] as const)('preview note for %s', (kind, note) => expect(previewNote(kind)).toBe(note));

  it('labels the sample when nothing is tracked', () => expect(previewRowLabel(undefined)).toBe('Sample PR (no tracked PRs yet)'));
});
