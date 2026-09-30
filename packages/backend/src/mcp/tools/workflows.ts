import {
  WORKFLOW_ACTION_LABELS,
  WORKFLOW_ACTION_TYPES,
  WORKFLOW_ACTOR_KINDS,
  WORKFLOW_CONDITION_SPECS,
  WORKFLOW_EVENT_LABELS,
  WORKFLOW_TRIGGER_EVENTS,
  type NormalizedWorkflow,
  type WorkflowRun,
  type WorkflowSuggestions,
  type WorkflowWithStats,
} from '@talyn/shared';
import { callApi } from '../api.js';
import {
  bool,
  booleanSchema,
  defineTool,
  linesOrNone,
  objectArg,
  pageQuery,
  pageSchema,
  pageText,
  requireId,
  resolveWorkspace,
  str,
  textSchema,
  workspaceSchema,
} from './helpers.js';

const idSchema = { ...workspaceSchema, workflow_id: textSchema };
const workflowSchema = {
  type: 'object',
  properties: {
    name: textSchema,
    enabled: booleanSchema,
    events: { type: 'array', items: { type: 'string', enum: WORKFLOW_TRIGGER_EVENTS } },
    conditions: { type: 'object' },
    actions: { type: 'array', items: { type: 'object' } },
    maxRunsPerPrPerHour: { type: 'integer' },
  },
};

async function list(ownerId: string, args: Record<string, unknown>): Promise<WorkflowWithStats[]> {
  const params = new URLSearchParams({ workspaceId: await resolveWorkspace(ownerId, args) });
  return callApi(ownerId, 'GET', `/workflows?${params}`);
}

async function current(ownerId: string, args: Record<string, unknown>): Promise<WorkflowWithStats> {
  const id = requireId(args, 'workflow_id');
  const workflow = (await list(ownerId, args)).find((row) => row.id === id);
  if (!workflow) throw new Error(`Workflow ${id} was not found in this workspace.`);
  return workflow;
}

function definition(workflow: NormalizedWorkflow): NormalizedWorkflow {
  const { name, enabled, events, conditions, actions, maxRunsPerPrPerHour } = workflow;
  return { name, enabled, events, conditions, actions, maxRunsPerPrPerHour };
}

function workflowLine(workflow: WorkflowWithStats): string {
  const stats = workflow.stats;
  return `${workflow.id}  ${workflow.name}  enabled: ${workflow.enabled}  events: ${workflow.events.join(', ')}  actions: ${workflow.actions.map((action) => action.type).join(', ')}${stats ? `  runs: ${stats.runsTotal}, last: ${stats.lastStatus ?? 'none'}, failures/7d: ${stats.failures7d}` : ''}`;
}

async function update(
  ownerId: string,
  args: Record<string, unknown>,
  patch: Record<string, unknown>
): Promise<string> {
  const workflow = await current(ownerId, args);
  return workflowLine(
    await callApi<WorkflowWithStats>(ownerId, 'PATCH', `/workflows/${workflow.id}`, {
      ...definition(workflow),
      ...patch,
    })
  );
}

const actionFields: Record<(typeof WORKFLOW_ACTION_TYPES)[number], string> = {
  add_labels: 'labels: string[]',
  remove_labels: 'labels: string[]',
  request_reviewers: 'users?: string[], teams?: string[]',
  assign: 'users: string[]',
  comment: 'body: string',
  run_skill: 'skillKey: string, model?: string',
  run_prompt: 'prompt: string, model?: string',
  watch_pr: 'no extra fields',
  enqueue_merge_queue: 'method?: squash | merge | rebase',
  run_code_review: 'preset?: quick | standard | deep',
};

export const WORKFLOWS = [
  defineTool(
    'list_workflows',
    'List workflow definitions and run statistics.',
    workspaceSchema,
    [],
    { readOnlyHint: true },
    async (ownerId, args) => linesOrNone(await list(ownerId, args), workflowLine),
    'workflows'
  ),
  defineTool(
    'get_workflow',
    'Get the full workflow definition as JSON for editing.',
    idSchema,
    ['workflow_id'],
    { readOnlyHint: true },
    async (ownerId, args) => JSON.stringify(definition(await current(ownerId, args)), null, 2),
    'workflows'
  ),
  defineTool(
    'create_workflow',
    'Create a workflow object with name, events, conditions, and actions. Read talyn_get_workflow_vocabulary for allowed values.',
    { ...workspaceSchema, workflow: workflowSchema },
    ['workflow'],
    { openWorldHint: true },
    async (ownerId, args) => {
      const workflow = objectArg(args, 'workflow');
      return workflowLine(
        await callApi<WorkflowWithStats>(ownerId, 'POST', '/workflows', {
          ...workflow,
          workspaceId: await resolveWorkspace(ownerId, args),
        })
      );
    },
    'workflows'
  ),
  defineTool(
    'update_workflow',
    'Merge supplied workflow fields into the current definition. Read talyn_get_workflow_vocabulary before editing events, conditions, or actions.',
    { ...idSchema, workflow: workflowSchema },
    ['workflow_id', 'workflow'],
    { openWorldHint: true, idempotentHint: true },
    async (ownerId, args) => update(ownerId, args, objectArg(args, 'workflow')),
    'workflows'
  ),
  defineTool(
    'get_workflow_vocabulary',
    'Get event, condition, and action fields with concrete suggestions. Pass repos to fetch their GitHub labels and users.',
    { ...workspaceSchema, repos: { type: 'array', items: textSchema } },
    [],
    { readOnlyHint: true, openWorldHint: true },
    async (ownerId, args) => {
      const params = new URLSearchParams({
        workspaceId: await resolveWorkspace(ownerId, args),
        github: '1',
      });
      if (Array.isArray(args.repos)) params.set('repos', args.repos.map(String).join(','));
      const suggestions = await callApi<WorkflowSuggestions>(
        ownerId,
        'GET',
        `/workflows/suggestions?${params}`
      );
      return [
        ...WORKFLOW_TRIGGER_EVENTS.map((event) => `${event}  ${WORKFLOW_EVENT_LABELS[event]}`),
        ...WORKFLOW_CONDITION_SPECS.map(
          (spec) =>
            `${spec.key}  ${spec.input}  ${spec.hint}  events: ${spec.appliesTo?.join(', ') ?? 'all'}`
        ),
        `actor kinds: ${WORKFLOW_ACTOR_KINDS.join(', ')}; logins uses {kind: logins, logins: string[]}`,
        'reviewStates: approved, changes_requested, commented; checkConclusions: success, failure',
        ...WORKFLOW_ACTION_TYPES.map(
          (type) =>
            `${type}  ${WORKFLOW_ACTION_LABELS[type]}  {type: ${type}, ${actionFields[type]}}`
        ),
        `repos: ${suggestions.repos.join(', ')}`,
        `labels: ${suggestions.labels.join(', ')}`,
        `branches: ${suggestions.branches.join(', ')}`,
        `people: ${suggestions.people.map((person) => person.login).join(', ')}`,
        `teams: ${suggestions.teams.join(', ')}`,
        ...(suggestions.partial
          ? ['Suggestions are incomplete. You can enter values directly.']
          : []),
      ].join('\n');
    },
    'workflows'
  ),
  defineTool(
    'set_workflow_enabled',
    'Enable or disable a workflow while preserving its definition.',
    { ...idSchema, enabled: booleanSchema },
    ['workflow_id', 'enabled'],
    { openWorldHint: true, idempotentHint: true },
    async (ownerId, args) => update(ownerId, args, { enabled: bool(args, 'enabled') }),
    'workflows'
  ),
  defineTool(
    'delete_workflow',
    'Delete a workflow and its run history.',
    { workflow_id: textSchema },
    ['workflow_id'],
    { destructiveHint: true },
    async (ownerId, args) => {
      const id = requireId(args, 'workflow_id');
      await callApi(ownerId, 'DELETE', `/workflows/${id}`);
      return `${id} deleted.`;
    },
    'workflows'
  ),
  defineTool(
    'list_workflow_runs',
    'List workflow runs. Use the returned cursor to fetch older runs.',
    { workflow_id: textSchema, ...pageSchema },
    ['workflow_id'],
    { readOnlyHint: true },
    async (ownerId, args) => {
      const rows = await callApi<WorkflowRun[]>(
        ownerId,
        'GET',
        `/workflows/${requireId(args, 'workflow_id')}/runs?${pageQuery(args)}`
      );
      return pageText(
        rows,
        args,
        (run) =>
          `${run.id}  [${run.status}]  ${run.createdAt}  ${run.repoFullName}#${run.prNumber}  ${run.event}${run.taskId ? `  task: ${run.taskId}` : ''}${str(run.error) ? `  ${run.error}` : ''}`
      );
    },
    'workflows'
  ),
];
