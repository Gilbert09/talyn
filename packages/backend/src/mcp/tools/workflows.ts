import {
  ALL_WORKFLOW_ACTION_TYPES,
  ALL_WORKFLOW_TRIGGER_EVENTS,
  WORKFLOW_ACTOR_KINDS,
  WORKFLOW_INTEGRATIONS,
  workflowVocabulary,
  type NormalizedWorkflow,
  type WorkflowIntegration,
  type WorkflowDefinition,
  type WorkflowRun,
  type WorkflowSuggestions,
  type WorkflowWithStats,
  type CreatedWorkflow,
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
const integrationSchema = {
  type: 'string',
  enum: WORKFLOW_INTEGRATIONS,
  description: 'Which integration the automation belongs to. Default: github.',
};
const workflowSchema = {
  type: 'object',
  properties: {
    integration: integrationSchema,
    name: textSchema,
    enabled: booleanSchema,
    events: { type: 'array', items: { type: 'string', enum: ALL_WORKFLOW_TRIGGER_EVENTS } },
    conditions: { type: 'object' },
    actions: { type: 'array', items: { type: 'object' } },
    maxRunsPerPrPerHour: { type: 'integer' },
  },
};

function integrationArg(args: Record<string, unknown>): WorkflowIntegration | undefined {
  const value = str(args.integration);
  if (value === undefined) return undefined;
  if (!(WORKFLOW_INTEGRATIONS as readonly string[]).includes(value))
    throw new Error(`integration must be one of: ${WORKFLOW_INTEGRATIONS.join(', ')}.`);
  return value as WorkflowIntegration;
}

async function list(ownerId: string, args: Record<string, unknown>): Promise<WorkflowWithStats[]> {
  const params = new URLSearchParams({ workspaceId: await resolveWorkspace(ownerId, args) });
  const integration = integrationArg(args);
  if (integration) params.set('integration', integration);
  return callApi(ownerId, 'GET', `/workflows?${params}`);
}

async function current(ownerId: string, args: Record<string, unknown>): Promise<WorkflowWithStats> {
  const id = requireId(args, 'workflow_id');
  const workflow = (await list(ownerId, args)).find((row) => row.id === id);
  if (!workflow) throw new Error(`Workflow ${id} was not found in this workspace.`);
  return workflow;
}

// No `integration`: a PATCH keeps the rule's own, and the route refuses a change.
function definition(workflow: WorkflowDefinition): Omit<NormalizedWorkflow, 'integration'> {
  const { name, enabled, events, conditions, actions, maxRunsPerPrPerHour } = workflow;
  return { name, enabled, events, conditions, actions, maxRunsPerPrPerHour };
}

function workflowLine(workflow: WorkflowWithStats): string {
  const stats = workflow.stats;
  return `${workflow.id}  ${workflow.name}  integration: ${workflow.integration ?? 'github'}  enabled: ${workflow.enabled}  events: ${workflow.events.join(', ')}  actions: ${workflow.actions.map((action) => action.type).join(', ')}${stats ? `  runs: ${stats.runsTotal}, last: ${stats.lastStatus ?? 'none'}, failures/7d: ${stats.failures7d}` : ''}`;
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

const actionFields: Record<(typeof ALL_WORKFLOW_ACTION_TYPES)[number], string> = {
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
  start_session:
    'repositoryId: string | null (null lets Talyn choose on Slack, and means the issue repository on github_issues; webhook and linear need one), prompt: string, model?: string, internetAccess?: boolean, issueStartComment?: boolean (issue rules, default true), issueDoneOnMerge?: boolean (issue rules, default true)',
  start_task:
    'repositoryId: string | null (null only on github_issues: the issue repository), prompt: string (the request body or the issue is quoted below it as untrusted text), model?: string, internetAccess?: boolean, issueStartComment?: boolean, issueDoneOnMerge?: boolean',
  issue_comment: 'body: string (may use {{issue.identifier}}, {{issue.url}}, {{session.url}}, {{task.url}})',
  issue_set_status: 'status: string (done, a Linear state name, or open / closed on GitHub Issues)',
  slack_reply: 'text: string (may use {{session.url}} and {{message.permalink}})',
  slack_react: 'emoji: string (a name without colons, for example eyes)',
};

export const WORKFLOWS = [
  defineTool(
    'list_workflows',
    'List automations and run statistics. Pass integration to list one integration only: github, slack, webhook, linear or github_issues.',
    { ...workspaceSchema, integration: integrationSchema },
    [],
    { readOnlyHint: true },
    async (ownerId, args) => linesOrNone(await list(ownerId, args), workflowLine),
    'workflows'
  ),
  defineTool(
    'get_workflow',
    'Get the full automation definition as JSON for editing.',
    idSchema,
    ['workflow_id'],
    { readOnlyHint: true },
    async (ownerId, args) => {
      const workflow = await current(ownerId, args);
      return JSON.stringify(
        { integration: workflow.integration ?? 'github', ...definition(workflow) },
        null,
        2
      );
    },
    'workflows'
  ),
  defineTool(
    'create_workflow',
    'Create an automation with integration (github, slack, webhook, linear or github_issues), name, events, conditions, and actions. Read talyn_get_workflow_vocabulary for the allowed values of that integration. Slack, webhook and issue (linear, github_issues) automations need their own features. A webhook automation answers with its URL and signing secret ONCE: give them to the user, because Talyn cannot show them again.',
    { ...workspaceSchema, workflow: workflowSchema },
    ['workflow'],
    { openWorldHint: true },
    async (ownerId, args) => {
      const workflow = objectArg(args, 'workflow');
      const created = await callApi<CreatedWorkflow>(ownerId, 'POST', '/workflows', {
        ...workflow,
        workspaceId: await resolveWorkspace(ownerId, args),
      });
      if (!created.webhook) return workflowLine(created);
      return [
        workflowLine(created),
        `webhook url (shown once): ${created.webhook.url}`,
        `signing secret (shown once, optional): ${created.webhook.signingSecret}`,
        'Send a POST with a JSON body. To sign, set X-Talyn-Signature: sha256=<hex HMAC-SHA256 of the raw body with the signing secret>.',
      ].join('\n');
    },
    'workflows'
  ),
  defineTool(
    'update_workflow',
    'Merge supplied automation fields into the current definition. Read talyn_get_workflow_vocabulary before editing events, conditions, or actions.',
    { ...idSchema, workflow: workflowSchema },
    ['workflow_id', 'workflow'],
    { openWorldHint: true, idempotentHint: true },
    async (ownerId, args) => update(ownerId, args, objectArg(args, 'workflow')),
    'workflows'
  ),
  defineTool(
    'get_workflow_vocabulary',
    'Get the events, conditions, and actions of one integration (github, slack, webhook, linear or github_issues, default github). For github, pass repos to fetch their GitHub labels and users.',
    { ...workspaceSchema, integration: integrationSchema, repos: { type: 'array', items: textSchema } },
    [],
    { readOnlyHint: true, openWorldHint: true },
    async (ownerId, args) => {
      const integration = integrationArg(args) ?? 'github';
      const vocabulary = workflowVocabulary(integration);
      const lines = [
        `integration: ${integration}`,
        ...vocabulary.events.map((event) => `${event.event}  ${event.label}`),
        ...vocabulary.conditions.map(
          (spec) =>
            `${spec.key}  ${spec.label}  ${spec.hint}${spec.required ? '  required' : ''}  events: ${spec.appliesTo?.join(', ') ?? 'all'}`
        ),
        ...vocabulary.actions.map(
          (action) =>
            `${action.type}  ${action.label}  {type: ${action.type}, ${actionFields[action.type]}}`
        ),
      ];
      if (integration === 'webhook') {
        return [
          ...lines,
          'payloadMatches (optional): [{path: string, op: equals | contains | exists, value?: string}]. path is a dot path with indexes, like issue.labels[0].name. Every test must pass.',
          'The automation gets its own URL when it is created. Use talyn_list_repositories to find repository ids.',
        ].join('\n');
      }
      if (integration === 'linear' || integration === 'github_issues') {
        return [
          ...lines,
          'issueAssignee (optional): {kind: talyn (linear only) | me (github_issues only) | unassigned | people, people?: string[]}',
          ...(integration === 'linear'
            ? ['connectionId is required: the Linear connection id. The Linear page in Talyn lists connections.']
            : ['repos (optional): owner/repo names. Without it, every repository the workspace watches.']),
          'An issue automation can have one start action (start_session or start_task). By default Talyn comments on the issue when it starts and, when the pull request merges, comments and moves the issue to done. Set issueStartComment: false or issueDoneOnMerge: false on the start action to turn either off.',
        ].join('\n');
      }
      if (integration === 'slack') {
        return [
          ...lines,
          'slackAuthors (optional, default anyone in the channel): {kind: any | linked | users, userIds?: string[] of Slack user ids}',
          'Use talyn_list_slack_channels to find channel ids. Only channels Talyn is in are listed.',
        ].join('\n');
      }
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
        ...lines,
        `actor kinds: ${WORKFLOW_ACTOR_KINDS.join(', ')}; logins uses {kind: logins, logins: string[]}`,
        'reviewStates: approved, changes_requested, commented; checkConclusions: success, failure',
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
    'Enable or disable an automation while preserving its definition.',
    { ...idSchema, enabled: booleanSchema },
    ['workflow_id', 'enabled'],
    { openWorldHint: true, idempotentHint: true },
    async (ownerId, args) => update(ownerId, args, { enabled: bool(args, 'enabled') }),
    'workflows'
  ),
  defineTool(
    'delete_workflow',
    'Delete an automation and its run history.',
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
    'List automation runs. Use the returned cursor to fetch older runs.',
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
          `${run.id}  [${run.status}]  ${run.createdAt}  ${run.subjectLabel ?? `${run.repoFullName}#${run.prNumber}`}  ${run.event}${run.taskId ? `  task: ${run.taskId}` : ''}${str(run.error) ? `  ${run.error}` : ''}`
      );
    },
    'workflows'
  ),
];
