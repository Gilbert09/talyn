import {
  BACKGROUND_DEFAULT_KEEP_AWAKE_SECONDS,
  BACKGROUND_MAX_KEEP_AWAKE_SECONDS,
  formatDurationMs,
  type WorkbenchBackground,
  type WorkbenchBackgroundJob,
  type WorkbenchBackgroundLogs,
  type WorkbenchWakeup,
} from '@talyn/shared';
import { callApi } from '../api.js';
import { bool, defineTool, linesOrNone, requireId, str } from './helpers.js';
import type { McpCallContext } from './index.js';

/**
 * Session background jobs and wake-ups. Hidden when the `sessionBackground`
 * flag is off for the account; the routes answer 404 then too.
 */
const FEATURE = 'sessionBackground' as const;

const sessionSchema = {
  session_id: { type: 'string', description: 'The session. Default: the calling session.' },
};
const chatSchema = {
  chat_id: {
    type: 'string',
    description: 'Your chat: the TALYN_CHAT_ID environment variable. Default: the running chat of the session.',
  },
};

/** A session's own token acts on that session only. A user's token names the session. */
function targetSession(args: Record<string, unknown>, ctx: McpCallContext | undefined): string {
  const self = ctx?.session?.workbenchId;
  const sessionId = str(args.session_id) ?? self;
  if (!sessionId) throw new Error('session_id is required');
  if (self && sessionId !== self) throw new Error('A session can run background work and wake-ups for itself only.');
  return sessionId;
}

const base = (sessionId: string) => `/workbenches/${encodeURIComponent(sessionId)}`;

function integerArg(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new Error(`${key} must be a whole number`);
  return value;
}

function jobLine(job: WorkbenchBackgroundJob): string {
  const ran = formatDurationMs(Math.max(0, (job.endedAt ? Date.parse(job.endedAt) : Date.now()) - Date.parse(job.startedAt)));
  const state = job.status === 'exited' ? `exited ${job.exitCode ?? '?'}` : job.status;
  const awake = job.status === 'running' && job.keepAwakeUntil ? `  keeps the box awake until ${job.keepAwakeUntil}` : '';
  const command = job.command.split('\n')[0].slice(0, 120);
  return `${job.id}  "${job.name}"  [${state}, ${ran}]${awake}${job.detail ? `  note: ${job.detail}` : ''}\n    $ ${command}`;
}

function wakeupLine(w: WorkbenchWakeup): string {
  const when = w.status === 'scheduled' ? `at ${w.wakeAt}` : `${w.status}${w.firedAt ? ` ${w.firedAt}` : ''}`;
  return `${w.id}  [${when}]  by ${w.createdBy}  ${w.reason}${w.failureDetail ? `  (${w.failureDetail})` : ''}`;
}

export const BACKGROUND = [
  defineTool(
    'run_background',
    `Start a shell command in this session's sandbox that keeps running after your turn ends. Use it for work longer than one command may run (about 10 minutes): a long test suite, a build, a data job, a server you need later. Your own background shells (\`&\`, \`nohup\`) stop when your turn ends; this does not. Talyn starts a new turn in your chat when the job exits (notify_on_exit), with the exit code and the last 40 lines of output, so end your turn after you start it. While keep_awake_seconds runs, Talyn checks the job every 30 seconds and the sandbox stays awake. That awake time is billed box time, paid by whoever pays for this turn. With keep_awake_seconds 0 the sandbox may sleep; the job freezes with it and continues when the sandbox wakes. A move or resize of the session stops the job (status lost).`,
    {
      command: { type: 'string', description: 'The shell command. It runs with bash in cwd. Put a long script in a file and run the file.' },
      name: { type: 'string', description: 'A short name for the job. Default: the start of the command.' },
      cwd: { type: 'string', description: 'The directory. Absolute, or relative to the repository. Default: the repository.' },
      keep_awake_seconds: {
        type: 'integer',
        minimum: 0,
        maximum: BACKGROUND_MAX_KEEP_AWAKE_SECONDS,
        default: BACKGROUND_DEFAULT_KEEP_AWAKE_SECONDS,
        description: 'Keep the sandbox awake this long while the job runs. 0 lets it sleep. Billed as box time.',
      },
      notify_on_exit: { type: 'boolean', default: true, description: 'Start a new turn in your chat when the job exits.' },
      ...chatSchema,
      ...sessionSchema,
    },
    ['command'],
    { openWorldHint: true },
    async (ownerId, args, ctx) => {
      const sessionId = targetSession(args, ctx);
      const body: Record<string, unknown> = { command: requireId(args, 'command') };
      if (str(args.name)) body.name = str(args.name);
      if (str(args.cwd)) body.cwd = str(args.cwd);
      if (str(args.chat_id)) body.chatId = str(args.chat_id);
      const keep = integerArg(args, 'keep_awake_seconds');
      if (keep !== undefined) body.keepAwakeSeconds = keep;
      if (args.notify_on_exit !== undefined) body.notifyOnExit = bool(args, 'notify_on_exit');
      const job = await callApi<WorkbenchBackgroundJob>(ownerId, 'POST', `${base(sessionId)}/background/jobs`, body);
      return [
        `Started background job ${job.id} ("${job.name}").`,
        job.keepAwakeUntil ? `The sandbox stays awake until ${job.keepAwakeUntil}.` : 'The sandbox may sleep while the job runs.',
        job.notifyOnExit
          ? 'Talyn starts a new turn in this chat when it exits. End your turn now unless you have other work.'
          : 'Talyn does not tell you when it exits. Check it with talyn_list_background or talyn_background_logs.',
      ].join(' ');
    },
    FEATURE
  ),
  defineTool(
    'list_background',
    "List this session's background jobs: running ones, then recent ended ones, with exit codes and keep-awake times. Read-only.",
    { ...sessionSchema },
    [],
    { readOnlyHint: true },
    async (ownerId, args, ctx) => {
      const state = await callApi<WorkbenchBackground>(ownerId, 'GET', `${base(targetSession(args, ctx))}/background`);
      return linesOrNone(state.jobs, jobLine);
    },
    FEATURE
  ),
  defineTool(
    'background_logs',
    "Read the last lines of a background job's output. Also records the job's exit if it has exited. Read-only otherwise.",
    {
      id: { type: 'string', description: 'The job id.' },
      tail_lines: { type: 'integer', minimum: 1, maximum: 2000, default: 200 },
      ...sessionSchema,
    },
    ['id'],
    { readOnlyHint: true },
    async (ownerId, args, ctx) => {
      const params = new URLSearchParams({ live: '1' });
      const tail = integerArg(args, 'tail_lines');
      if (tail !== undefined) params.set('tail', String(tail));
      const logs = await callApi<WorkbenchBackgroundLogs>(
        ownerId, 'GET',
        `${base(targetSession(args, ctx))}/background/jobs/${encodeURIComponent(requireId(args, 'id'))}/logs?${params}`
      );
      const head = `Job ${logs.jobId}: ${logs.status}${logs.exitCode !== null ? ` (exit ${logs.exitCode})` : ''}.`;
      return logs.lines.length ? `${head}\n${logs.lines.join('\n')}` : `${head} No output to show.`;
    },
    FEATURE
  ),
  defineTool(
    'stop_background',
    'Stop a background job: INT, then TERM, then KILL to its whole process group.',
    { id: { type: 'string', description: 'The job id.' }, ...sessionSchema },
    ['id'],
    { destructiveHint: true, idempotentHint: true },
    async (ownerId, args, ctx) => {
      const job = await callApi<WorkbenchBackgroundJob>(
        ownerId, 'POST',
        `${base(targetSession(args, ctx))}/background/jobs/${encodeURIComponent(requireId(args, 'id'))}/stop`
      );
      return `Job ${job.id} is ${job.status}${job.exitCode !== null ? ` (exit ${job.exitCode})` : ''}.`;
    },
    FEATURE
  ),
  defineTool(
    'schedule_wakeup',
    'Ask Talyn to start a new turn in your chat later, for example to check a deploy, a CI run or a long job in 20 minutes. Give exactly one of delay_seconds and at. The time must be in the future. When it is due, Talyn sends "Wake-up you scheduled at <time>: <reason>" as a new turn; if the chat is busy, it waits in the queue. End your turn after you schedule it. You can schedule several. The wake-up wakes a sleeping sandbox, which is billed box time.',
    {
      delay_seconds: { type: 'integer', minimum: 1, description: 'Seconds from now.' },
      at: { type: 'string', description: 'An ISO time, for example 2026-11-08T15:30:00Z.' },
      reason: { type: 'string', description: 'What to do when you wake up. It opens the wake-up turn.' },
      ...chatSchema,
      ...sessionSchema,
    },
    ['reason'],
    { openWorldHint: true },
    async (ownerId, args, ctx) => {
      const sessionId = targetSession(args, ctx);
      const body: Record<string, unknown> = { reason: requireId(args, 'reason'), createdBy: 'agent' };
      const delay = integerArg(args, 'delay_seconds');
      if (delay !== undefined) body.delaySeconds = delay;
      if (str(args.at)) body.at = str(args.at);
      if (str(args.chat_id)) body.chatId = str(args.chat_id);
      const wakeup = await callApi<WorkbenchWakeup>(ownerId, 'POST', `${base(sessionId)}/wakeups`, body);
      return `Scheduled wake-up ${wakeup.id} for ${wakeup.wakeAt}. Cancel it with talyn_cancel_wakeup.`;
    },
    FEATURE
  ),
  defineTool(
    'list_wakeups',
    "List this session's wake-ups: scheduled ones (soonest first), then recent fired, cancelled or failed ones. Read-only.",
    { ...sessionSchema },
    [],
    { readOnlyHint: true },
    async (ownerId, args, ctx) => {
      const state = await callApi<WorkbenchBackground>(ownerId, 'GET', `${base(targetSession(args, ctx))}/background`);
      return linesOrNone(state.wakeups, wakeupLine);
    },
    FEATURE
  ),
  defineTool(
    'cancel_wakeup',
    'Cancel a scheduled wake-up.',
    { id: { type: 'string', description: 'The wake-up id.' }, ...sessionSchema },
    ['id'],
    { destructiveHint: true, idempotentHint: true },
    async (ownerId, args, ctx) => {
      const wakeup = await callApi<WorkbenchWakeup>(
        ownerId, 'DELETE',
        `${base(targetSession(args, ctx))}/wakeups/${encodeURIComponent(requireId(args, 'id'))}`
      );
      return `Wake-up ${wakeup.id} is ${wakeup.status}.`;
    },
    FEATURE
  ),
];
