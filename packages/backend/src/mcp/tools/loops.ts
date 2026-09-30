import {
  defaultModelForLoopProvider,
  emptyLoopInput,
  LOOP_CONCURRENCIES,
  LOOP_PROVIDERS,
  loopToInput,
  type LoopRun,
  type LoopWithStats,
} from '@talyn/shared';
import { callApi, type WatchedRepo } from '../api.js';
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

const fields = {
  name: textSchema,
  prompt: textSchema,
  cron: { type: 'string', description: 'Cron expression. Default: 0 9 * * *.' },
  timezone: { type: 'string', default: 'UTC' },
  enabled: booleanSchema,
  provider: { type: 'string', enum: LOOP_PROVIDERS },
  model: textSchema,
  concurrency: { type: 'string', enum: LOOP_CONCURRENCIES },
  internetAccess: booleanSchema,
  mcpServerIds: { type: ['array', 'null'], items: textSchema },
  repositoryId: textSchema,
  repoFullName: textSchema,
};
const inputSchema = {
  ...workspaceSchema,
  ...fields,
  repository_id: textSchema,
  loop: {
    type: 'object',
    properties: fields,
    description:
      'Optional object with the same fields. Do not combine it with top-level loop fields.',
  },
};
const idSchema = { ...workspaceSchema, loop_id: textSchema };

function input(args: Record<string, unknown>): Record<string, unknown> {
  const nested = args.loop === undefined ? null : objectArg(args, 'loop');
  if (nested && Object.keys(fields).some((key) => args[key] !== undefined))
    throw new Error('Pass loop fields in one place.');
  const source = nested ?? args;
  const values = Object.fromEntries(
    Object.keys(fields)
      .filter((key) => source[key] !== undefined)
      .map((key) => [key, source[key]])
  );
  if (str(args.repository_id)) values.repositoryId = str(args.repository_id);
  return values;
}

async function list(ownerId: string, args: Record<string, unknown>): Promise<LoopWithStats[]> {
  const params = new URLSearchParams({ workspaceId: await resolveWorkspace(ownerId, args) });
  return callApi(ownerId, 'GET', `/loops?${params}`);
}

async function current(ownerId: string, args: Record<string, unknown>): Promise<LoopWithStats> {
  const id = requireId(args, 'loop_id');
  const loop = (await list(ownerId, args)).find((row) => row.id === id);
  if (!loop) throw new Error(`Loop ${id} was not found in this workspace.`);
  return loop;
}

const loopLine = (loop: LoopWithStats) =>
  `${loop.id}  ${loop.name}  enabled: ${loop.enabled}  ${loop.cron} (${loop.timezone})  ${loop.provider}/${loop.model}  next: ${loop.nextRunAt ?? 'none'}${loop.disabledReason ? `  disabled: ${loop.disabledReason}` : ''}`;
const runLine = (run: LoopRun) =>
  `${run.id}  [${run.status}]  ${run.scheduledFor}  task: ${run.taskId ?? 'none'}${run.error ? `  ${run.error}` : ''}${run.retryAfter ? `  retry: ${run.retryAfter}` : ''}${run.task?.prUrl ? `  ${run.task.prUrl}` : ''}`;

async function repoName(
  ownerId: string,
  workspaceId: string,
  values: Record<string, unknown>
): Promise<void> {
  if (!str(values.repositoryId) || str(values.repoFullName)) return;
  const params = new URLSearchParams({ workspaceId });
  const repo = (await callApi<WatchedRepo[]>(ownerId, 'GET', `/repositories?${params}`)).find(
    (row) => row.id === values.repositoryId
  );
  if (!repo) throw new Error('The repository was not found in this workspace.');
  values.repoFullName = repo.fullName;
}

async function update(
  ownerId: string,
  args: Record<string, unknown>,
  patch: Record<string, unknown>
): Promise<string> {
  const loop = await current(ownerId, args);
  await repoName(ownerId, loop.workspaceId, patch);
  return loopLine(
    await callApi<LoopWithStats>(ownerId, 'PATCH', `/loops/${loop.id}`, {
      ...loopToInput(loop),
      ...patch,
    })
  );
}

export const LOOPS = [
  defineTool(
    'list_loops',
    'List recurring loops and their next run times.',
    workspaceSchema,
    [],
    { readOnlyHint: true },
    async (ownerId, args) => linesOrNone(await list(ownerId, args), loopLine),
    'loops'
  ),
  defineTool(
    'get_loop',
    'Get the full loop definition as JSON for editing, including the next run time.',
    idSchema,
    ['loop_id'],
    { readOnlyHint: true },
    async (ownerId, args) => {
      const loop = await current(ownerId, args);
      return JSON.stringify({ ...loopToInput(loop), nextRunAt: loop.nextRunAt }, null, 2);
    },
    'loops'
  ),
  defineTool(
    'create_loop',
    'Create recurring cloud work. Supply name, prompt, and repository_id. Defaults match the desktop, with timezone UTC.',
    inputSchema,
    [],
    { openWorldHint: true },
    async (ownerId, args) => {
      const workspaceId = await resolveWorkspace(ownerId, args);
      const values = input(args);
      requireId(values, 'name');
      requireId(values, 'prompt');
      requireId(values, 'repositoryId');
      await repoName(ownerId, workspaceId, values);
      const defaults = emptyLoopInput('UTC');
      if (values.provider === 'selfhosted' || values.provider === 'posthog_code')
        defaults.model = defaultModelForLoopProvider(values.provider);
      return loopLine(
        await callApi<LoopWithStats>(ownerId, 'POST', '/loops', {
          ...defaults,
          ...values,
          workspaceId,
        })
      );
    },
    'loops'
  ),
  defineTool(
    'update_loop',
    'Merge supplied fields into the current loop definition. Set model when changing provider.',
    { ...inputSchema, loop_id: textSchema },
    ['loop_id'],
    { openWorldHint: true, idempotentHint: true },
    async (ownerId, args) => update(ownerId, args, input(args)),
    'loops'
  ),
  defineTool(
    'set_loop_enabled',
    'Enable or disable a loop while preserving its definition.',
    { ...idSchema, enabled: booleanSchema },
    ['loop_id', 'enabled'],
    { openWorldHint: true, idempotentHint: true },
    async (ownerId, args) => update(ownerId, args, { enabled: bool(args, 'enabled') }),
    'loops'
  ),
  defineTool(
    'delete_loop',
    'Delete a loop and its run history.',
    { loop_id: textSchema },
    ['loop_id'],
    { destructiveHint: true },
    async (ownerId, args) => {
      const id = requireId(args, 'loop_id');
      await callApi(ownerId, 'DELETE', `/loops/${id}`);
      return `${id} deleted.`;
    },
    'loops'
  ),
  defineTool(
    'list_loop_runs',
    'List loop runs. Use the returned cursor to fetch older runs.',
    { loop_id: textSchema, ...pageSchema },
    ['loop_id'],
    { readOnlyHint: true },
    async (ownerId, args) =>
      pageText(
        await callApi<LoopRun[]>(
          ownerId,
          'GET',
          `/loops/${requireId(args, 'loop_id')}/runs?${pageQuery(args)}`
        ),
        args,
        runLine
      ),
    'loops'
  ),
  defineTool(
    'run_loop_now',
    'Run a loop now through the normal task and billing checks.',
    { loop_id: textSchema },
    ['loop_id'],
    { openWorldHint: true },
    async (ownerId, args) => {
      const run = await callApi<LoopRun | null>(
        ownerId,
        'POST',
        `/loops/${requireId(args, 'loop_id')}/run`
      );
      return run ? runLine(run) : 'The run no longer exists.';
    },
    'loops'
  ),
];
