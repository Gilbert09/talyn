import type { CloudProviderInfo, MergeQueuePublic, PRRow } from '@talyn/client/native';
import type { Environment, Workspace } from '@talyn/shared';

import { autoKeepLabel, canMerge, canResubmit, checksLine, failingChecks, fixAgentChoices, mergeLine, prActions, queueStateLabel,
  resolveTaskEnvironment, sessionFixAction, sessionFromConflict, startPrFix } from '../features/prs/actions';
import { fixture, pr } from './workflowFixtures';

const summary = (patch: Partial<PRRow['summary']> = {}) => ({ ...pr().summary, ...patch });
const entry = (patch: Partial<MergeQueuePublic>) => ({ status: 'queued', position: 1, ...patch }) as MergeQueuePublic;
const providers = (patch: Partial<CloudProviderInfo>[] = []): CloudProviderInfo[] => [
  { type: 'selfhosted', displayName: 'Talyn Fleet', connected: true, connectedAgents: ['claude', 'codex'] },
  { type: 'posthog_code', displayName: 'PostHog Code', connected: true },
].map((provider, index) => ({ ...provider, ...patch[index] }));
const envs = [{ id: 'env-fleet', type: 'selfhosted' }, { id: 'env-posthog', type: 'posthog_code' }] as Environment[];

describe('pull request action availability', () => {
  it.each<[string, Partial<PRRow>, boolean, Partial<ReturnType<typeof prActions>>]>([
    ['a reviewer PR', {}, true, { owner: false, merge: false, fix: false, queue: false, autoKeep: false }],
    ['my mergeable PR', { authored: true, summary: summary({ blockingReason: 'mergeable' }) }, true,
      { owner: true, merge: true, fix: true, queue: true, autoKeep: true }],
    ['my PR with optional failures', { authored: true, summary: summary({ blockingReason: 'checks_failed_optional' }) }, false,
      { merge: true, autoKeep: false }],
    ['my blocked PR', { authored: true, summary: summary({ blockingReason: 'checks_failed', checks: { total: 2, passed: 1, failed: 1, inProgress: 0, skipped: 0 } }) }, true,
      { merge: false, fix: true, fixBlocked: null }],
    ['my clean PR with nothing to fix', { authored: true, summary: summary({ blockingReason: 'mergeable', mergeable: 'MERGEABLE' }) }, true,
      { fixBlocked: 'no_fixable_issues' }],
    ['my merged PR', { authored: true, state: 'merged', summary: summary({ blockingReason: 'mergeable' }) }, true,
      { merge: false, fix: false, queue: false, autoKeep: false, fixBlocked: null }],
    ['a parked external entry', { mergeQueued: true, mergeQueue: entry({ status: 'blocked', blockedCode: 'external_queue_rejected' }) }, true,
      { resubmit: true, requeue: false }],
    ['a blocked entry', { mergeQueued: true, mergeQueue: entry({ status: 'blocked', blockedCode: 'fix_budget' }) }, true,
      { resubmit: false, requeue: true }],
    ['a waiting entry', { mergeQueued: true, mergeQueue: entry({ status: 'awaiting_ci' }) }, true, { resubmit: false, requeue: false }],
  ])('%s', (_name, patch, posthogConnected, expected) => {
    expect(prActions(pr(patch), { posthogConnected })).toMatchObject(expected);
  });
  it('blocks a fix while a run works the PR', () => {
    expect(prActions(pr({ authored: true }), { posthogConnected: true, taskRunning: true }).fixBlocked).toBe('task_running');
  });
  it.each([
    [entry({ status: 'blocked', external: { state: 'failed' } as MergeQueuePublic['external'] }), true],
    [entry({ status: 'blocked_manual', blockedCode: 'external_gate' }), true],
    [entry({ status: 'queued', blockedCode: 'external_gate' }), false],
    [null, false],
  ])('resubmit for %j is %s', (value, expected) => expect(canResubmit(value)).toBe(expected));
  it.each([['open', 'mergeable', true], ['open', 'blocked', false], ['closed', 'mergeable', false]] as const)(
    'merge for %s %s is %s', (state, blockingReason, expected) => expect(canMerge(pr({ state, summary: summary({ blockingReason }) }))).toBe(expected));
});

describe('pull request status lines', () => {
  it.each<[Partial<PRRow>, Partial<PRRow['summary']>, string]>([
    [{ state: 'merged' }, {}, 'Merged.'],
    [{ state: 'closed' }, {}, 'Closed without merging.'],
    [{}, { draft: true }, 'Draft. Mark it ready for review on GitHub before it can merge.'],
    [{}, { blockingReason: 'mergeable' }, 'Ready to merge.'],
    [{}, { blockingReason: 'checks_failed_optional' }, 'Ready to merge. Some optional checks fail.'],
    [{}, { blockingReason: 'unknown' }, 'GitHub has not said yet if this can merge.'],
    [{}, { blockingReason: 'merge_conflicts' }, 'Blocked by merge conflicts with the base branch.'],
    [{}, { blockingReason: 'checks_failed' }, 'Blocked by failing CI checks.'],
    [{}, { blockingReason: 'changes_requested', reviewDecision: 'CHANGES_REQUESTED' }, 'Blocked by a reviewer requested changes.'],
    [{}, { blockingReason: 'blocked' }, 'Blocked by a branch rule, such as a required review.'],
  ])('merge line for %j %j', (row, patch, expected) => expect(mergeLine(pr(row), summary(patch))).toBe(expected));
  it.each([
    [{ total: 0, passed: 0, failed: 0, inProgress: 0, skipped: 0 }, null],
    [{ total: 1, passed: 1, failed: 0, inProgress: 0, skipped: 0 }, '1 check: 1 passed'],
    [{ total: 14, passed: 11, failed: 2, inProgress: 1, skipped: 0 }, '14 checks: 11 passed, 2 failing, 1 running'],
    [{ total: 5, passed: 4, failed: 0, inProgress: 0, skipped: 1 }, '5 checks: 4 passed, 1 skipped'],
  ])('checks line %j', (checks, expected) => expect(checksLine(checks)).toBe(expected));
  it('lists failing checks with required ones first', () => {
    expect(failingChecks([
      { name: 'lint', state: 'failure', url: null, required: false },
      { name: 'build', state: 'success', url: null },
      { name: 'test', state: 'failure', url: null, required: true },
      { name: 'audit', state: 'failure', url: null, required: null },
    ]).map((check) => check.name)).toEqual(['test', 'audit', 'lint']);
    expect(failingChecks(undefined)).toEqual([]);
  });
  it.each<[Partial<PRRow>, string]>([
    [{ mergeQueued: false }, 'Not queued'],
    [{ mergeQueued: true, mergeQueue: null }, 'Queued'],
    [{ mergeQueued: true, mergeQueue: entry({ position: 3 }) }, 'Queued #3'],
    [{ mergeQueued: true, mergeQueue: entry({ status: 'merging' }) }, 'Merging'],
    [{ mergeQueued: true, mergeQueue: entry({ status: 'fixing' }) }, 'Fixing'],
    [{ mergeQueued: true, mergeQueue: entry({ status: 'blocked', blockedCode: 'agent_needs_human' }) }, 'Queue needs you'],
    [{ mergeQueued: true, mergeQueue: entry({ status: 'blocked', blockedCode: 'fix_budget' }) }, 'Queue blocked'],
  ])('queue label %j', (patch, expected) => expect(queueStateLabel(pr(patch))).toBe(expected));
  it.each<[Partial<PRRow>, string]>([
    [{ autoKeepMergeable: false }, 'Off'],
    [{ autoKeepMergeable: true, autoMergeState: { attempts: 1, paused: false } }, 'On'],
    [{ autoKeepMergeable: true, autoMergeState: { attempts: 3, paused: true } }, 'Auto-fix paused'],
  ])('auto-keep label %j', (patch, expected) => expect(autoKeepLabel(pr(patch))).toBe(expected));
});

describe('fix routing', () => {
  it.each<[string, Parameters<typeof resolveTaskEnvironment>[0], string | null]>([
    ['the fleet first by default', { providers: providers(), environments: envs }, 'env-fleet'],
    ['the workspace default', { providers: providers(), environments: envs, defaultProvider: 'posthog_code' }, 'env-posthog'],
    ['auto when the default is ask', { providers: providers(), environments: envs, defaultProvider: 'ask' }, 'env-fleet'],
    ['a picked provider', { providerType: 'posthog_code', providers: providers(), environments: envs }, 'env-posthog'],
    ['nothing for a picked provider that is not connected', { providerType: 'posthog_code', providers: providers([{}, { connected: false }]), environments: envs }, null],
    ['PostHog Code when the fleet is gone', { providers: providers([{ connected: false }]), environments: envs }, 'env-posthog'],
    ['nothing when no environment exists', { providers: providers(), environments: [] }, null],
  ])('resolves %s', (_name, input, expected) => expect(resolveTaskEnvironment(input)).toBe(expected));
  it.each([
    ['ask', 3],
    ['selfhosted', 0],
    [undefined, 0],
  ] as const)('offers a picker when the default is %s', (defaultCloudProvider, count) => {
    expect(fixAgentChoices(providers(), { settings: { defaultCloudProvider } } as Workspace)).toHaveLength(count);
  });
  it.each<[Partial<PRRow['summary']>, string]>([
    [{ blockingReason: 'merge_conflicts' }, 'resolve_conflicts'],
    [{ mergeable: 'CONFLICTING' }, 'resolve_conflicts'],
    [{ blockingReason: 'checks_failed' }, 'fix_checks'],
    [{ unresolvedReviewThreads: 2 }, 'address_review'],
    [{ reviewDecision: 'CHANGES_REQUESTED' }, 'address_review'],
    [{}, 'fix_checks'],
  ])('sends %j to a session as %s', (patch, expected) => expect(sessionFixAction(pr({ summary: summary(patch) }))).toBe(expected));
  it.each([
    [{ status: 409, code: 'pr_has_session', details: { workbenchId: 'session-one', name: 'Work' } }, { id: 'session-one', name: 'Work' }],
    [{ status: 409, code: 'pr_has_session', details: { workbenchId: 'session-one' } }, { id: 'session-one', name: 'session' }],
    [{ status: 409, code: 'other' }, null],
    [{ status: 500, code: 'pr_has_session' }, null],
  ])('reads a session conflict from %j', (error, expected) => expect(sessionFromConflict(error)).toEqual(expected));
});

describe('pull request store actions', () => {
  let active: ReturnType<typeof fixture>;
  beforeEach(() => { active = fixture(); });
  afterEach(() => active.store.dispose());
  const fixable = () => pr({ authored: true, summary: summary({ blockingReason: 'checks_failed', checks: { total: 1, passed: 0, failed: 1, inProgress: 0, skipped: 0 } }) });
  const context = { providers: providers(), environments: envs, workspace: undefined };

  it('queues optimistically and rolls back a refusal', async () => {
    await active.store.load('attention'); await active.store.load('pr', 'pr-one');
    const pending = active.store.setMergeQueue('pr-one', true);
    expect(active.store.findPr('pr-one')?.mergeQueued).toBe(true);
    expect(active.store.read<PRRow[]>('attention').data?.[0].mergeQueued).toBe(true);
    await pending;
    active.api.pullRequests.setMergeQueue.mockRejectedValueOnce({ status: 402, code: 'merge_queue_limit_reached' });
    await expect(active.store.setMergeQueue('pr-one', false)).rejects.toMatchObject({ status: 402 });
    expect(active.store.findPr('pr-one')?.mergeQueued).toBe(true);
  });
  it('arms auto-keep and reverts on failure', async () => {
    await active.store.load('pr', 'pr-one');
    active.api.pullRequests.setAutoKeepMergeable.mockRejectedValueOnce(new Error('No'));
    await expect(active.store.setAutoKeep('pr-one', true)).rejects.toThrow('No');
    expect(active.store.findPr('pr-one')).toMatchObject({ autoKeepMergeable: false });
    await active.store.setAutoKeep('pr-one', true);
    expect(active.store.findPr('pr-one')).toMatchObject({ autoKeepMergeable: true, autoMergeState: { attempts: 0, paused: false } });
  });
  it('creates a fix run on the resolved agent and links it', async () => {
    await active.store.load('pr', 'pr-one');
    await expect(startPrFix(active.store, fixable(), context)).resolves.toEqual({ kind: 'task' });
    expect(active.api.tasks.create).toHaveBeenCalledWith(expect.objectContaining({ type: 'pr_response', assignedEnvironmentId: 'env-fleet',
      pullRequestId: 'pr-one', title: 'Get example/project#42 mergeable' }));
    expect(active.store.findPr('pr-one')?.taskId).toBe('task-new');
  });
  it('sends the model of a picked agent', async () => {
    await startPrFix(active.store, fixable(), { ...context, choice: { type: 'selfhosted', displayName: 'Talyn Fleet · Codex', model: 'gpt-6.1-terra', models: [] } });
    expect(active.api.tasks.create).toHaveBeenCalledWith(expect.objectContaining({ model: 'gpt-6.1-terra' }));
  });
  it('hands the fix to the session that works the PR', async () => {
    const row = { ...fixable(), session: { id: 'session-one', name: 'Work', status: 'ready' } };
    await expect(startPrFix(active.store, row, context)).resolves.toEqual({ kind: 'session', id: 'session-one', name: 'Work' });
    expect(active.api.workbenches.action).toHaveBeenCalledWith('session-one', 'fix_checks');
    expect(active.api.tasks.create).not.toHaveBeenCalled();
  });
  it('follows a session conflict from the server', async () => {
    active.api.tasks.create.mockRejectedValueOnce({ status: 409, code: 'pr_has_session', details: { workbenchId: 'session-two', name: 'Other' } });
    await expect(startPrFix(active.store, fixable(), context)).resolves.toEqual({ kind: 'session', id: 'session-two', name: 'Other' });
  });
  it.each([
    ['no agent', { providers: [] as CloudProviderInfo[], environments: envs, workspace: undefined }, null, { kind: 'no_agent' }],
    ['a running task', context, 'in_progress', { kind: 'blocked', reason: 'task_running' }],
  ])('reports %s', async (_name, input, taskStatus, expected) => {
    const row = { ...fixable(), taskId: taskStatus ? 'task-one' : null };
    if (taskStatus) active.api.tasks.get.mockResolvedValueOnce({ id: 'task-one', status: taskStatus });
    await expect(startPrFix(active.store, row, input)).resolves.toEqual(expected);
    expect(active.api.tasks.create).not.toHaveBeenCalled();
  });
  it('rethrows a box refusal', async () => {
    active.api.tasks.create.mockRejectedValueOnce({ status: 402, code: 'usage_exhausted' });
    await expect(startPrFix(active.store, fixable(), context)).rejects.toMatchObject({ code: 'usage_exhausted' });
  });
});
