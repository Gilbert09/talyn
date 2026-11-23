import type { SetupListStep } from '@talyn/shared';

import {
  addHost, addStepInputs, dotfilesChoices, dotfilesDirty, dotfilesInput, dotfilesProblem, editStepInputs, listedSteps, moveInputs, moveItem,
  removeStepInputs, runOnInputs, stateFacts, stepFormDirty, stepFormDraft, userStepCount, validateStepForm,
} from '../features/sandboxSetup/model';

const step = (patch: Partial<SetupListStep> = {}): SetupListStep => ({
  id: 's1', repositoryId: null, position: 0, name: 'Install', command: 'npm i', kind: 'node', runOn: 'image', origin: 'user', status: 'active',
  statusReason: null, statusChangedAt: null, acceptedBy: null, timeoutSec: null, boxOnlyReason: null, why: null, sourceWorkbenchId: null,
  seenCount: 0, sessionCount: 0, firstSeenAt: '', lastSeenAt: '', confirmedAt: null, imageAppliedAt: null, imageFailedAt: null,
  imageFailureReason: null, boxFailureCount: 0, boxLastFailure: null, lastDurationMs: null, typicalDurationMs: null, measuredBoxes: 0,
  createdAt: '', updatedAt: '', ...patch,
});

describe('dotfilesProblem', () => {
  it.each([
    ['me/dotfiles', '', null],
    ['me/dotfiles', 'make install', null],
    ['  me/dotfiles ', '', null],
    ['', '', 'The repository must be owner/name.'],
    ['dotfiles', '', 'The repository must be owner/name.'],
    ['a/b/c', '', 'The repository must be owner/name.'],
    ['me/dotfiles', 'echo $GITHUB_TOKEN', 'The install command reads a secret. The image build has no secrets.'],
  ])('%s + %s', (slug, install, expected) => {
    expect(dotfilesProblem(slug, install)).toBe(expected);
  });
  it('returns the refusal for a destructive command', () => {
    expect(dotfilesProblem('me/dotfiles', 'x'.repeat(5000))).toMatch(/at most 4096/);
  });
});

describe('dotfiles drafts', () => {
  it.each([
    [null, { slug: '', ref: '', install: '' }, false],
    [null, { slug: 'a/b', ref: '', install: '' }, true],
    [{ slug: 'a/b', ref: 'main', install: null }, { slug: 'a/b', ref: 'main', install: '' }, false],
    [{ slug: 'a/b', ref: 'main', install: null }, { slug: ' a/b ', ref: 'main ', install: '  ' }, false],
    [{ slug: 'a/b', ref: 'main', install: 'x' }, { slug: 'a/b', ref: 'main', install: 'y' }, true],
  ])('dirty %#', (saved, draft, expected) => {
    expect(dotfilesDirty(saved, draft)).toBe(expected);
  });
  it.each([
    [{ slug: ' a/b ', ref: ' v1 ', install: ' ./i ' }, { slug: 'a/b', ref: 'v1', install: './i' }],
    [{ slug: 'a/b', ref: '', install: '   ' }, { slug: 'a/b', ref: '', install: null }],
  ])('builds the request %#', (draft, expected) => {
    expect(dotfilesInput(draft)).toEqual(expected);
  });
  it.each([
    [['me/dots', 'me/app'], '', ['me/dots', 'me/app']],
    [['me/dots', 'me/app'], 'DOT', ['me/dots']],
    [['me/dots'], 'other/repo', ['other/repo', 'me/dots'].slice(0, 1)],
    [['me/dots'], 'me/DOTS', ['me/dots']],
  ])('choices %#', (repos, query, slugs) => {
    const choices = dotfilesChoices(repos, query);
    if (query === 'other/repo') expect(choices).toEqual([{ slug: 'other/repo', label: 'Use other/repo' }]);
    else expect(choices.map((choice) => choice.slug)).toEqual(slugs);
  });
});

describe('validateStepForm', () => {
  const draft = (patch = {}) => ({ name: 'Build', command: 'make', runOn: 'image' as const, timeout: '', ...patch });
  it.each([
    [draft({ name: ' ' }), 'Give the step a name.'],
    [draft({ name: 'a\nb' }), 'The name must be on one line.'],
    [draft({ command: ' ' }), 'The command is empty.'],
    [draft({ timeout: '0' }), 'The time limit must be a whole number from 1 to 3600 seconds.'],
    [draft({ timeout: '3601' }), 'The time limit must be a whole number from 1 to 3600 seconds.'],
    [draft({ timeout: '1.5' }), 'The time limit must be a whole number from 1 to 3600 seconds.'],
    [draft({ timeout: 'abc' }), 'The time limit must be a whole number from 1 to 3600 seconds.'],
  ])('refuses %#', (value, error) => {
    expect(validateStepForm(value, 3600)).toEqual({ error });
  });
  it.each([
    [draft({ name: ' Build ', timeout: ' 60 ', runOn: 'both' }), { name: 'Build', command: 'make', runOn: 'both', timeoutSec: 60 }],
    [draft(), { name: 'Build', command: 'make', runOn: 'image', timeoutSec: null }],
    [draft({ command: 'echo $GITHUB_TOKEN' }), { name: 'Build', command: 'echo $GITHUB_TOKEN', runOn: 'box', timeoutSec: null }],
  ])('accepts %#', (value, expected) => {
    expect(validateStepForm(value, 3600)).toEqual({ value: expected });
  });
});

describe('step requests', () => {
  const a = step({ id: 'a', name: 'A', timeoutSec: 30 });
  const b = step({ id: 'b', name: 'B', command: 'make' });
  const learned = step({ id: 'c', origin: 'learned', name: 'C' });
  const value = { name: 'N', command: 'x', runOn: 'box' as const, timeoutSec: null };

  it('keeps every field of the rows it does not change', () => {
    expect(addStepInputs([a], value)).toEqual([{ id: 'a', name: 'A', runOn: 'image', timeoutSec: 30 }, { name: 'N', command: 'x', runOn: 'box', timeoutSec: null }]);
  });
  it('sends the command only when it changed', () => {
    expect(editStepInputs([a, b], b, { ...value, command: 'make' })[1]).toEqual({ id: 'b', name: 'N', runOn: 'box', timeoutSec: null });
    expect(editStepInputs([a, b], b, value)[1]).toEqual({ id: 'b', name: 'N', runOn: 'box', timeoutSec: null, command: 'x' });
    expect(editStepInputs([a, b], b, value)[0]).toEqual({ id: 'a', name: 'A', runOn: 'image', timeoutSec: 30 });
  });
  it('removes one row', () => { expect(removeStepInputs([a, b], 'a').map((input) => input.id)).toEqual(['b']); });
  it('changes where a row runs', () => { expect(runOnInputs([a, b], 'b', 'both').map((input) => input.runOn)).toEqual(['image', 'both']); });
  it.each([[0, 1, ['b', 'a']], [1, 0, ['b', 'a']], [0, 0, null], [0, 2, null], [-1, 0, null]])('moves %i to %i', (from, to, ids) => {
    expect(moveInputs([a, b], from, to)?.map((input) => input.id) ?? null).toEqual(ids);
  });
  it('moveItem keeps the list when the move is a no-op', () => {
    const list = [1, 2, 3];
    expect(moveItem(list, 1, 1)).toBe(list);
    expect(moveItem(list, 0, 2)).toEqual([2, 3, 1]);
  });
  it('lists without dismissed rows and counts own steps', () => {
    const dismissed = step({ id: 'd', status: 'dismissed' });
    expect(listedSteps([a, dismissed]).map((s) => s.id)).toEqual(['a']);
    expect(userStepCount([a, b, learned])).toBe(2);
  });
});

describe('step form drafts and facts', () => {
  it('detects edits', () => {
    const initial = stepFormDraft(step({ timeoutSec: 60 }));
    expect(initial.timeout).toBe('60');
    expect(stepFormDirty(initial, { ...initial })).toBe(false);
    expect(stepFormDirty(initial, { ...initial, command: 'x' })).toBe(true);
    expect(stepFormDirty(stepFormDraft(), { ...stepFormDraft(), name: 'a' })).toBe(true);
  });
  it.each([
    [step(), ['Active', 'Not in the image yet']],
    [step({ runOn: 'box' }), ['Active']],
    [step({ status: 'disabled', statusReason: 'failed 3 times' }), ['Disabled: failed 3 times']],
    [step({ status: 'disabled' }), ['Disabled']],
    [step({ imageFailedAt: 'x', imageFailureReason: 'timeout' }), ['Active', 'Not in the image: timeout']],
    [step({ status: 'suggested' }), ['Suggested']],
  ])('facts %#', (row, texts) => { expect(stateFacts(row).map((fact) => fact.text)).toEqual(texts); });
});

describe('addHost', () => {
  it.each([
    [[], '  ', { skip: true }],
    [['a.com'], 'A.com', { skip: true }],
    [['a.com'], 'b.com', { hosts: ['a.com', 'b.com'] }],
    [['a.com', 'b.com'], 'c.com', { error: 'You can add at most 2 hosts.' }],
  ])('%j + %s', (hosts, input, expected) => { expect(addHost(hosts, input, 2)).toEqual(expected); });
  it('refuses an invalid host with a message', () => {
    expect(addHost([], 'not a host!', 5)).toEqual({ error: expect.any(String) });
  });
});
