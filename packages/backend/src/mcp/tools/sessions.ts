import {
  buildBlocks,
  describeTool,
  extractToolText,
  formatDurationMs,
  isTalynOriginMessage,
  TURN_TIME_CATEGORIES,
  TURN_TIME_CATEGORY_LABELS,
  type AgentEvent,
  type CreateWorkbenchPullRequestResult,
  type FleetAccountView,
  type FleetAccountsResponse,
  SANDBOX_SIZES,
  SETUP_STEP_LIVE_SHARE,
  SETUP_STEP_MIN_SESSIONS,
  SETUP_STEP_WINDOW_DAYS,
  type SandboxSize,
  type RecordSetupStepResult,
  type SandboxStartInfo,
  type SandboxStartLayer,
  type SandboxStartTimeline,
  type WorkbenchSandboxStatus,
  type WorkbenchTiming,
  type Workbench,
  type WorkbenchChanges,
  type WorkbenchDiff,
  type WorkbenchChat,
  type WorkbenchEvent,
  type Workspace,
  type CreateSpaceSessionResponse,
} from '@talyn/shared';
import {
  chatWorkbenchId,
  recordSessionSpawn,
  reserveSessionCreate,
} from '../../services/sessionMcpToken.js';
import type { SessionResizeResult } from '../../services/workbenches/resize.js';
import type { SessionRestartResult } from '../../services/workbenches/restart.js';
import { announceSessionSpawn } from '../../services/workbenches/threads.js';
import { callApi, McpApiError } from '../api.js';
import {
  bool,
  booleanSchema,
  defineTool,
  linesOrNone,
  requireId,
  resolveWorkspace,
  str,
  textSchema,
  trim,
  workspaceSchema,
} from './helpers.js';
import type { McpCallContext } from './index.js';

/** The old step states that `POST /repositories/:id/setup-recipe/steps` answers, as Setup list statuses. */
const RECORDED_STATUS: Record<RecordSetupStepResult['steps'][number]['state'], string> = {
  waiting: 'suggested',
  live: 'active',
  reverted: 'dismissed',
  failing: 'disabled',
};

const FEATURE = 'workbenches' as const;
const LOCAL_MESSAGE =
  "This session runs on the user's own machine in the Talyn desktop app; open it there.";
/** Largest text a transcript or diff call returns. Bigger output is cut and the caller is told how to continue. */
const MAX_OUTPUT_CHARS = 30_000;
const DEFAULT_EVENT_LIMIT = 200;
const MAX_EVENT_LIMIT = 2000;

const sessionIdSchema = { session_id: { type: 'string', description: 'The session id.' } };
const chatTargetSchema = {
  session_id: {
    type: 'string',
    description: "The session id. Uses the session's first open chat.",
  },
  chat_id: { type: 'string', description: 'A chat id. Use it instead of session_id.' },
};

const sessionLine = (wb: Workbench) =>
  [
    wb.id,
    wb.name,
    `[${wb.status}${wb.archivedAt ? ', archived' : ''}]`,
    `${wb.runtime}/${wb.agent}`,
    `${wb.repoFullName}@${wb.branch}`,
    `chats: ${wb.chats?.length ?? 0}`,
    wb.pr ? `pr: ${wb.pr.url}` : wb.pullRequestId ? `pr: ${wb.pullRequestId}` : '',
  ]
    .filter(Boolean)
    .join('  ');

/** One session of a thread: what the thread's agent needs to decide what to read next. */
const threadSessionLine = (wb: Workbench) =>
  [
    wb.id,
    wb.title || wb.name,
    `[${wb.status}${wb.archivedAt ? ', archived' : ''}]`,
    `${wb.repoFullName}@${wb.branch}`,
    `chat: ${wb.chats?.[0]?.status ?? 'none'}`,
    wb.pr ? `pr: ${wb.pr.url} (${wb.pr.state}, checks ${wb.pr.ciStatus})` : 'pr: none',
  ].join('  ');

const chatLine = (chat: WorkbenchChat) =>
  `  ${chat.id}  "${chat.title}"  [${chat.status}]  ${chat.agent}/${chat.model ?? 'default'}${chat.queuedMessages.length ? `  queued: ${chat.queuedMessages.length}` : ''}`;

function sessionDetail(wb: Workbench): string {
  const lines = [
    sessionLine(wb),
    `base: ${wb.baseBranch}`,
    `sandbox: ${wb.sandboxState}`,
    wb.title ? `title: ${wb.title}` : '',
    wb.statusMessage || wb.error ? `note: ${wb.statusMessage ?? wb.error}` : '',
    wb.diffStat
      ? `diff: +${wb.diffStat.added}/-${wb.diffStat.removed} in ${wb.diffStat.files} files`
      : '',
    wb.pr
      ? `pull request: #${wb.pr.number} ${wb.pr.state}, ${wb.pr.mergeable}, checks ${wb.pr.ciStatus}  ${wb.pr.url}`
      : '',
    'chats:',
    ...(wb.chats?.length ? wb.chats.map(chatLine) : ['  none']),
  ];
  return lines.filter(Boolean).join('\n');
}

/** A route's refusal for a local session becomes one plain message. */
async function sandboxOnly<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof McpApiError && err.code === 'local_runtime') throw new Error(LOCAL_MESSAGE);
    throw err;
  }
}

async function loadSession(ownerId: string, id: string): Promise<Workbench> {
  return callApi<Workbench>(ownerId, 'GET', `/workbenches/${encodeURIComponent(id)}`);
}

/** Load a session and refuse early when it runs on the user's machine. */
async function loadSandboxSession(ownerId: string, id: string): Promise<Workbench> {
  const wb = await loadSession(ownerId, id);
  if (wb.runtime === 'local') throw new Error(LOCAL_MESSAGE);
  return wb;
}

/** The chat to act on: an explicit chat id, else the session's first open chat. */
async function resolveChat(ownerId: string, args: Record<string, unknown>): Promise<string> {
  const chatId = str(args.chat_id);
  if (chatId) return chatId;
  const sessionId = str(args.session_id);
  if (!sessionId) throw new Error('session_id or chat_id is required');
  const wb = await loadSandboxSession(ownerId, sessionId);
  const chat = wb.chats?.[0];
  if (!chat) throw new Error(`Session ${sessionId} has no open chat.`);
  return chat.id;
}

/**
 * Whether a call from a session's own token targets that same session. Only
 * then do the self-call rules apply; calls on other sessions run as usual.
 */
async function targetsSelf(
  ctx: McpCallContext | undefined,
  args: Record<string, unknown>,
  chatId?: string
): Promise<boolean> {
  const self = ctx?.session?.workbenchId;
  if (!self) return false;
  if (chatId) return (await chatWorkbenchId(chatId)) === self;
  return str(args.session_id) === self;
}

const SELF_MESSAGE =
  'This is your own session. A message to it would start another turn of yourself after this one. Answer in this reply instead.';
const SELF_CANCEL = 'That would stop the reply you are writing now. To stop, end your reply.';
const SELF_RESTORE = 'This is your own session, and it is running. There is nothing to restore.';
const SELF_RETRY = 'This is your own session, and it is running. There is nothing to retry.';
const SELF_ARCHIVE_DEFERRED =
  'This session will be archived when this reply ends. Finish the reply now, and do not start more work.';

const ACCOUNT_AGENT_LABEL = { claude: 'Claude', codex: 'Codex' } as const;

const RESIZE_SIZES = Object.keys(SANDBOX_SIZES) as SandboxSize[];
const RESIZE_SIZES_TEXT = RESIZE_SIZES.map((size) => `${size}: ${SANDBOX_SIZES[size].memMib / 1024} GB`).join(', ') + '.';

function resizeText(sessionId: string, result: SessionResizeResult, self: boolean): string {
  const label = SANDBOX_SIZES[result.size].label;
  const lines: string[] = [];
  if (result.outcome === 'unchanged') {
    lines.push(`Session ${sessionId} already runs on a ${label} sandbox. Nothing moves.`);
  } else {
    lines.push(
      result.outcome === 'moving'
        ? `Talyn is moving session ${sessionId} to a ${label} sandbox now.`
        : `Talyn moves session ${sessionId} to a ${label} sandbox when its current turn ends, or at its next turn start.`
    );
    if (result.continued) lines.push('Talyn sends the continue_with message after the move, so that turn starts on the new sandbox.');
    if (self) lines.push('End your turn now. Do not start more long work on this sandbox.');
    lines.push('If the fleet refuses the size, the session keeps its sandbox and its transcript says why.');
  }
  if (result.rememberedForRepository) lines.push('New sessions of this repository also get this size.');
  return lines.join(' ');
}

function restartText(sessionId: string, result: SessionRestartResult, self: boolean): string {
  const lines = [
    result.outcome === 'restarting'
      ? `Talyn is restarting session ${sessionId} on a fresh sandbox now.`
      : `Talyn restarts session ${sessionId} on a fresh sandbox when its current turn ends, or at its next turn start.`,
    "The new sandbox gets the workspace's current MCP servers. Their tools appear in the turn after the restart.",
  ];
  if (result.continued) lines.push('Talyn sends the continue_with message after the restart, so that turn starts on the new sandbox.');
  if (self) lines.push('End your turn now. Do not start more long work on this sandbox.');
  lines.push('If the restart fails, the session keeps its sandbox and its transcript says why.');
  return lines.join(' ');
}

function accountUsageText(account: FleetAccountView): string {
  const parts: string[] = [];
  if (account.needsReauth) parts.push('needs to be signed in again');
  if (account.held) parts.push(`rate limited or out of usage until ${account.held.until ?? 'unknown'}`);
  if (account.usage && 'windows' in account.usage) {
    for (const w of account.usage.windows) parts.push(`${w.label} ${Math.round(w.usedPercent)}%`);
  } else if (!account.needsReauth && !account.held) {
    parts.push('usage unknown');
  }
  return parts.join(', ');
}

/** The sessions whose accounts a call may show or change: the caller's own, and a thread's sessions. */
async function accountSessions(ownerId: string, args: Record<string, unknown>, ctx: McpCallContext | undefined): Promise<Workbench[]> {
  const anchorId = str(args.session_id) ?? ctx?.session?.workbenchId;
  if (!anchorId) return [];
  const anchor = await loadSession(ownerId, anchorId);
  if (anchor.kind !== 'thread') return [anchor];
  const children = await callApi<Workbench[]>(ownerId, 'GET', `/workbenches/${encodeURIComponent(anchor.id)}/sessions`);
  return [anchor, ...children];
}

/**
 * The session a call acts on: `session_id`, else the calling session. A
 * session's own token may name itself or a session of its thread; a user's
 * token may name any of the user's sessions.
 */
async function threadScopedSession(
  ownerId: string,
  args: Record<string, unknown>,
  ctx: McpCallContext | undefined,
  action: string
): Promise<string> {
  const self = ctx?.session?.workbenchId;
  const sessionId = str(args.session_id) ?? self;
  if (!sessionId) throw new Error('session_id is required');
  if (self && sessionId !== self) {
    const target = await loadSession(ownerId, sessionId);
    if (target.threadId !== self) throw new Error(`A session can ${action} itself, or a session in its thread.`);
  }
  return sessionId;
}

function timingText(t: WorkbenchTiming): string {
  if (t.turns === 0) return `Session ${t.workbenchId} has no time report yet. Talyn writes one when a turn ends.`;
  const share = (ms: number) => (t.wallMs > 0 ? ` (${Math.round((ms / t.wallMs) * 100)}%)` : '');
  const lines = [
    `Session ${t.workbenchId}: ${t.turns} turn(s), ${formatDurationMs(t.wallMs)} in all, ${t.calls} tool call(s).`,
    'Time by category (parallel calls can make the categories add up to more than the total):',
  ];
  const rows = TURN_TIME_CATEGORIES.map((c) => [c, t.categories[c]] as const)
    .filter(([, b]) => b && b.ms > 0)
    .sort((a, b) => b[1]!.ms - a[1]!.ms);
  for (const [c, b] of rows) {
    const calls = c === 'model' ? '' : ` in ${b!.count} call(s)`;
    lines.push(`  ${TURN_TIME_CATEGORY_LABELS[c]}: ${formatDurationMs(b!.ms)}${share(b!.ms)}${calls}`);
  }
  if (t.slowest.length) {
    lines.push('Slowest calls:');
    for (const s of t.slowest) {
      lines.push(`  ${formatDurationMs(s.ms)}  ${s.category}  ${s.command ?? s.name}${s.isError ? '  (failed)' : ''}`);
    }
  }
  return lines.join('\n');
}

/** The Sandbox panel's facts, as lines an agent can read. */
export function sandboxStatusText(s: WorkbenchSandboxStatus): string {
  const lines = [`Session ${s.workbenchId}: ${s.headline}`];
  if (s.detail) lines.push(`Note: ${s.detail}`);
  const where = [s.host ? `host ${s.host}` : '', s.size ? `size ${s.size.label}` : ''].filter(Boolean).join(', ');
  if (where) lines.push(`Sandbox: ${where}.`);
  if (s.resources) {
    const r = s.resources;
    lines.push('Resources:');
    if (r.memoryUsedMib !== null) {
      lines.push(`  Memory: ${r.memoryUsedMib} MiB used${r.memoryLimitMib !== null ? ` of ${r.memoryLimitMib} MiB` : ''}.`);
    } else if (r.memoryLimitMib !== null) {
      lines.push(`  Memory limit: ${r.memoryLimitMib} MiB.`);
    }
    if (r.vcpus !== null) lines.push(`  CPU: ${r.vcpus} vCPU${r.vcpus === 1 ? '' : 's'} allocated.`);
    if (r.diskMib !== null) lines.push(`  Disk capacity: ${r.diskMib} MiB.`);
  }
  if (s.since) lines.push(`${s.state === 'asleep' || s.state === 'hibernated' ? 'Asleep since' : 'Started at'}: ${s.since}`);
  if (s.sleepsAt) lines.push(`Goes to sleep at: ${s.sleepsAt}`);
  if (!s.fleet.known && s.fleet.error) lines.push(`The fleet did not answer: ${s.fleet.error}`);
  lines.push('Doing:');
  lines.push(...(s.activity.length ? s.activity.map((a) => `  ${a.text}`) : ['  Nothing.']));
  if (s.work) {
    const w = s.work;
    lines.push('Work:');
    lines.push(`  Last checkpoint: ${w.savedAt ?? 'none'}${w.checkedAt && w.checkedAt !== w.savedAt ? `; last check with no new changes: ${w.checkedAt}` : ''}`);
    if (w.uncommitted) lines.push(`  Not committed: ${w.uncommitted.files} file(s), +${w.uncommitted.added}/-${w.uncommitted.removed}`);
    if (w.unpushedCommits !== null) lines.push(`  Commits not on GitHub: ${w.unpushedCommits}`);
    if (w.failures > 0) lines.push(`  Saves failed in a row: ${w.failures}, last at ${w.lastFailureAt ?? 'unknown'}: ${w.lastFailure ?? ''}`.trimEnd());
    if (w.warning) lines.push(`  Warning: ${w.warning}`);
  }
  if (s.problem) lines.push(`Last problem${s.problem.at ? ` (${s.problem.at})` : ''}: ${s.problem.text}`);
  if (s.start) lines.push(...boxStartLines(s.start));
  if (s.actions.length) lines.push(`Actions in the app: ${s.actions.map((a) => a.label).join(', ')}.`);
  return lines.join('\n');
}

const START_LAYER_SHORT: Record<SandboxStartLayer, string> = {
  user: 'your image',
  repo: 'repository image',
  legacy: 'older image',
  base: 'base image',
};

/** "How this box started", as lines. */
function boxStartLines(start: SandboxStartInfo): string[] {
  const lines = ['How this box started:'];
  const { image, timeline } = start;
  if (image) {
    lines.push(`  Image: ${image.label}${image.repoCommit ? `, commit ${image.repoCommit.slice(0, 12)}` : ''}${image.builtAt ? `, built ${image.builtAt}` : ''}.`);
    lines.push(`  ${image.detail}`);
    if (image.pending) lines.push(`  ${image.pending}`);
    if (image.stale) lines.push('  A newer image exists. A new box boots it.');
  }
  if (timeline) {
    if (timeline.requestedAt) lines.push(`  Box requested at ${timeline.requestedAt}${timeline.cause && timeline.cause !== 'new' ? ` (${START_CAUSE[timeline.cause]})` : ''}.`);
    for (const step of timeline.steps) {
      const indent = step.kind === 'setup_step' ? '    ' : '  ';
      const time = step.durationMs === null ? 'not measured' : formatDurationMs(step.durationMs);
      const failed = step.ok === false ? ` (failed${step.detail ? `: ${step.detail}` : ''})` : '';
      lines.push(`${indent}${step.label}: ${time}${failed}`);
    }
  }
  if (start.lastWake) lines.push(`  Last wake (${start.lastWake.at}): ${start.lastWake.text}`);
  if (start.comparison) lines.push(`  ${start.comparison}${start.slow ? ' This start was slow.' : ''}`);
  if (start.recent.length) {
    const recent = start.recent.map((r) => `${formatDurationMs(r.totalMs)}${r.layer ? ` (${START_LAYER_SHORT[r.layer]})` : ''}${r.thisSession ? ' this session' : ''}`);
    lines.push(`  Recent starts of this repository, newest first: ${recent.join(', ')}.`);
  }
  if (start.note) lines.push(`  ${start.note}`);
  return lines;
}

const START_CAUSE: Record<NonNullable<SandboxStartTimeline['cause']>, string> = {
  new: 'a new session',
  move: 'a move to a new box',
  lost: 'a new box for a lost one',
  restore: 'a restore of an archived session',
};

const eventSeq = (key: string): number | null => {
  const match = /^(\d+)(?:\.|$)/.exec(key);
  return match ? Number(match[1]) : null;
};

/** One readable line group per transcript item, tagged with the event it came from. */
function transcriptItems(events: WorkbenchEvent[]): { seq: number; text: string }[] {
  const items: { seq: number; text: string }[] = [];
  const lastSeq = events.length ? events[events.length - 1].seq : 0;
  for (const { event, seq } of events) {
    const talyn = (event as { talyn?: { kind?: string } }).talyn;
    if (event.type === 'user' && talyn?.kind === 'user_message') {
      const label = isTalynOriginMessage(talyn) ? 'talyn' : 'user';
      const content = event.message?.content;
      const text = Array.isArray(content)
        ? content
            .map((part) => (part as { text?: unknown }).text)
            .filter((t): t is string => typeof t === 'string')
            .join('\n')
        : '';
      if (text) items.push({ seq, text: `${label}: ${text}` });
    }
  }
  for (const block of buildBlocks(events.map((e) => e.event as AgentEvent))) {
    const seq = eventSeq(block.key) ?? lastSeq;
    switch (block.kind) {
      case 'text':
        items.push({ seq, text: `assistant: ${block.text}` });
        break;
      case 'tool_use': {
        const tool = describeTool(block.name, block.input);
        items.push({ seq, text: `[tool] ${tool.label}${tool.detail ? `: ${trim(tool.detail, 200)}` : ''}` });
        break;
      }
      case 'tool_result': {
        const text = extractToolText(block.content);
        items.push({
          seq,
          text: `[${block.isError ? 'tool error' : 'tool result'}] ${trim((text ?? '').trim(), 300)}`,
        });
        break;
      }
      case 'system':
        // A Talyn message is listed above with the user messages.
        if (block.text && block.subtype !== 'talyn_message') items.push({ seq, text: `[system] ${block.text}` });
        break;
      case 'result':
        items.push({
          seq,
          text: `[turn ${block.isError ? 'failed' : 'done'}]${block.summary ? ` ${trim(block.summary, 300)}` : ''}`,
        });
        break;
      default:
        break;
    }
  }
  return items.sort((a, b) => a.seq - b.seq);
}

function renderTranscript(page: { events: WorkbenchEvent[]; cursor: number }, limit: number): string {
  if (page.events.length === 0) return `No events after cursor ${page.cursor}.`;
  const items = transcriptItems(page.events);
  const lines: string[] = [];
  let used = 0;
  let cursor = page.cursor;
  let cut = false;
  for (let i = 0; i < items.length; i++) {
    const { seq, text } = items[i];
    if (used + text.length > MAX_OUTPUT_CHARS && lines.length > 0) {
      // Never split an event: resume after the last whole one.
      let lastWhole = lines.length;
      while (lastWhole > 0 && items[lastWhole - 1].seq === seq) lastWhole--;
      if (lastWhole > 0) {
        lines.length = lastWhole;
        cursor = items[lastWhole - 1].seq;
        cut = true;
        break;
      }
    }
    lines.push(text);
    used += text.length + 1;
  }
  if (cut) lines.push(`Output cut at about ${MAX_OUTPUT_CHARS} characters. For the next page pass cursor=${cursor}.`);
  else if (page.events.length >= limit) lines.push(`More events may follow. For the next page pass cursor=${cursor}.`);
  else lines.push(`End of the transcript so far. To check for new events later, pass cursor=${cursor}.`);
  return lines.join('\n');
}

function eventLimit(args: Record<string, unknown>): number {
  const value = args.limit ?? DEFAULT_EVENT_LIMIT;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_EVENT_LIMIT) {
    throw new Error(`limit must be an integer from 1 to ${MAX_EVENT_LIMIT}`);
  }
  return value;
}

function capped(text: string, hint: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return `${text.slice(0, MAX_OUTPUT_CHARS)}\n\nOutput cut at ${MAX_OUTPUT_CHARS} of ${text.length} characters. ${hint}`;
}

export const SESSIONS = [
  defineTool(
    'list_sessions',
    'List sessions (agent workspaces on a branch) in a workspace. Archived sessions are hidden unless include_archived is true.',
    { ...workspaceSchema, include_archived: booleanSchema },
    [],
    { readOnlyHint: true },
    async (ownerId, args) => {
      const params = new URLSearchParams({ workspaceId: await resolveWorkspace(ownerId, args) });
      if (args.include_archived !== undefined) {
        params.set('includeArchived', String(bool(args, 'include_archived')));
      }
      return linesOrNone(await callApi<Workbench[]>(ownerId, 'GET', `/workbenches?${params}`), sessionLine);
    },
    FEATURE
  ),
  defineTool(
    'get_session',
    'Get one session: status, runtime, repository, branch, pull request, and its chats with their ids and status.',
    sessionIdSchema,
    ['session_id'],
    { readOnlyHint: true },
    async (ownerId, args) => sessionDetail(await loadSession(ownerId, requireId(args, 'session_id'))),
    FEATURE
  ),
  defineTool(
    'create_session',
    'Start a cloud session on a repository. It runs in a sandbox and works on a new branch, an existing branch, or the head of a pull request. An optional prompt becomes the first message.',
    {
      ...workspaceSchema,
      repository_id: textSchema,
      space_id: { type: 'string', description: 'Start in this team space and use your home workspace.' },
      repository_full_name: { type: 'string', description: 'Repository owner/name in the space. Use when it is not in one of your workspaces.' },
      agent: { type: 'string', enum: ['claude', 'codex'], description: 'Fixed for the life of the session.' },
      model: textSchema,
      prompt: { type: 'string', description: 'The first message.' },
      branch: { type: 'string', description: 'An existing branch to check out. Default: a new branch.' },
      base_branch: { type: 'string', description: "Default: the repository's default branch." },
      pull_request_id: { type: 'string', description: 'Start from this pull request’s branch.' },
      name: { type: 'string', description: 'Lowercase letters, digits and hyphens. A name in use gets `-2`, `-3` and so on.' },
      internet_access: booleanSchema,
      auto_create_pr: booleanSchema,
    },
    ['agent'],
    { openWorldHint: true },
    async (ownerId, args, ctx) => {
      const agent = str(args.agent);
      if (agent !== 'claude' && agent !== 'codex') throw new Error('agent must be "claude" or "codex"');
      const spaceId = str(args.space_id);
      if (spaceId) {
        let repoFullName = str(args.repository_full_name);
        const repositoryId = str(args.repository_id);
        if (repositoryId) {
          const workspaces = await callApi<Workspace[]>(ownerId, 'GET', '/workspaces');
          const found = workspaces.flatMap((workspace) => workspace.repos).find((repo) => repo.id === repositoryId);
          if (!found) throw new Error('repository_id was not found in your workspaces.');
          if (repoFullName && repoFullName.toLowerCase() !== found.name.toLowerCase()) {
            throw new Error('repository_id and repository_full_name must name the same repository.');
          }
          repoFullName = found.name;
        }
        if (!repoFullName) throw new Error('repository_id or repository_full_name is required.');
        if (str(args.pull_request_id) || args.auto_create_pr !== undefined) {
          throw new Error('pull_request_id and auto_create_pr are not supported in a space.');
        }
        const requestedWorkspace = str(args.workspace_id);
        if (requestedWorkspace) {
          const teams = await callApi<Array<{ homeWorkspaceId: string | null; spaces: Array<{ id: string }> }>>(ownerId, 'GET', '/teams');
          const team = teams.find((item) => item.spaces.some((space) => space.id === spaceId));
          if (team && requestedWorkspace !== team.homeWorkspaceId) {
            throw new Error('workspace_id must be your home workspace for this team.');
          }
        }
        const reserved = ctx?.session ? await reserveSessionCreate(ctx.session) : null;
        if (reserved?.threadId) throw new Error('A thread cannot start a session in a space.');
        const created = await callApi<CreateSpaceSessionResponse>(ownerId, 'POST', `/spaces/${encodeURIComponent(spaceId)}/sessions`, {
          repoFullName, agent,
          ...(str(args.model) ? { model: str(args.model) } : {}),
          ...(str(args.prompt) ? { prompt: str(args.prompt) } : {}),
          ...(str(args.name) ? { name: str(args.name) } : {}),
          ...(str(args.base_branch) ? { baseBranch: str(args.base_branch) } : {}),
          ...(str(args.branch) ? { branch: str(args.branch) } : {}),
          ...(args.internet_access !== undefined ? { internetAccess: bool(args, 'internet_access') } : {}),
        });
        if (ctx?.session) {
          await recordSessionSpawn(created.workbench.id, ctx.session);
          await announceSessionSpawn(ctx.session.workbenchId, created.workbench.id);
        }
        return sessionDetail(created.workbench);
      }
      const body: Record<string, unknown> = {
        workspaceId: await resolveWorkspace(ownerId, args),
        repositoryId: requireId(args, 'repository_id'),
        runtime: 'sandbox',
        agent,
      };
      for (const [arg, field] of [
        ['model', 'model'],
        ['prompt', 'prompt'],
        ['branch', 'branch'],
        ['base_branch', 'baseBranch'],
        ['pull_request_id', 'fromPullRequestId'],
        ['name', 'name'],
      ] as const) {
        if (str(args[arg])) body[field] = str(args[arg]);
      }
      if (args.internet_access !== undefined) body.internetAccess = bool(args, 'internet_access');
      if (args.auto_create_pr !== undefined) body.autoCreatePr = bool(args, 'auto_create_pr');
      // A session starting sessions: limited in depth, and the
      // child records its parent so its own token knows its depth. A session
      // a thread starts belongs to that thread.
      const reserved = ctx?.session ? await reserveSessionCreate(ctx.session) : null;
      if (reserved?.threadId) body.threadId = reserved.threadId;
      const created = await callApi<Workbench>(ownerId, 'POST', '/workbenches', body);
      if (ctx?.session) {
        await recordSessionSpawn(created.id, ctx.session);
        await announceSessionSpawn(ctx.session.workbenchId, created.id);
      }
      return sessionDetail(created);
    },
    FEATURE
  ),
  defineTool(
    'list_thread_sessions',
    "List the sessions of a thread, newest first: status, repository, branch, chat status and pull request. From a thread, thread_id defaults to the thread itself.",
    { thread_id: { type: 'string', description: 'The thread id. Default: the calling thread.' } },
    [],
    { readOnlyHint: true },
    async (ownerId, args, ctx) => {
      const threadId = str(args.thread_id) ?? ctx?.session?.workbenchId;
      if (!threadId) throw new Error('thread_id is required');
      const rows = await callApi<Workbench[]>(ownerId, 'GET', `/workbenches/${encodeURIComponent(threadId)}/sessions`);
      return linesOrNone(rows, threadSessionLine);
    },
    FEATURE
  ),
  defineTool(
    'send_session_message',
    'Send a message to a session chat. The agent starts a turn, or the message waits if a turn is running.',
    {
      ...chatTargetSchema,
      text: textSchema,
      plan_mode: booleanSchema,
      model: textSchema,
      effort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh', 'max'] },
    },
    ['text'],
    { openWorldHint: true },
    async (ownerId, args, ctx) =>
      sandboxOnly(async () => {
        const text = requireId(args, 'text');
        const chatId = await resolveChat(ownerId, args);
        if (await targetsSelf(ctx, args, chatId)) throw new Error(SELF_MESSAGE);
        const body: Record<string, unknown> = { text };
        if (args.plan_mode !== undefined) body.planMode = bool(args, 'plan_mode');
        if (str(args.model)) body.model = str(args.model);
        if (str(args.effort)) body.effort = str(args.effort);
        const result = await callApi<{ queued: boolean }>(
          ownerId,
          'POST',
          `/workbenches/chats/${encodeURIComponent(chatId)}/messages`,
          body
        );
        return result.queued
          ? `Message queued on chat ${chatId}. It runs when the current turn ends.`
          : `Message sent. A turn started on chat ${chatId}.`;
      }),
    FEATURE
  ),
  defineTool(
    'list_accounts',
    "List the workspace's Claude and Codex subscriptions: label, usage, and whether one is rate limited. Also shows which account this session, or each session of this thread, runs on. Never shows secrets.",
    {
      workspace_id: { type: 'string', description: 'The workspace. Default: the only workspace.' },
      session_id: { type: 'string', description: 'Show this session and, for a thread, its sessions. Default: the calling session.' },
    },
    [],
    { readOnlyHint: true },
    async (ownerId, args, ctx) => {
      const sessions = await accountSessions(ownerId, args, ctx);
      const workspaceId = str(args.workspace_id) ?? sessions[0]?.workspaceId ?? (await resolveWorkspace(ownerId, args));
      const data = await callApi<FleetAccountsResponse>(
        ownerId,
        'GET',
        `/cloud-providers/selfhosted/accounts?workspaceId=${encodeURIComponent(workspaceId)}`
      );
      const lines: string[] = [];
      for (const agent of ['claude', 'codex'] as const) {
        const accounts = data.accounts.filter((a) => a.agent === agent);
        if (accounts.length === 0) continue;
        lines.push(`${ACCOUNT_AGENT_LABEL[agent]} accounts (Talyn tries them in this order):`);
        for (const a of accounts) {
          lines.push(`  ${a.id}  "${a.label}"  ${a.over ? '[not usable now]' : '[usable]'}  ${accountUsageText(a)}`);
        }
      }
      if (lines.length === 0) return 'No Claude or Codex accounts are connected.';
      if (sessions.length > 0) {
        lines.push('', 'Sessions:');
        for (const wb of sessions) {
          const id = wb.settings?.fleetAccountId;
          const label = data.accounts.find((a) => a.id === id)?.label;
          const mine = wb.id === ctx?.session?.workbenchId ? ' (this session)' : '';
          lines.push(`  ${wb.id}  "${wb.title || wb.name}"${mine}  ${wb.agent}  account: ${id ? `${label ? `"${label}" ` : ''}${id}` : 'not chosen yet'}`);
        }
      }
      return lines.join('\n');
    },
    FEATURE
  ),
  defineTool(
    'set_session_account',
    "Choose the Claude or Codex account a session uses from its NEXT turn. It does not stop a running turn. Talyn still moves to another account at turn start when the chosen one is rate limited.",
    {
      session_id: { type: 'string', description: 'The session. Default: the calling session.' },
      account_id: { type: 'string', description: 'An account id from talyn_list_accounts. It must be an account of the session\'s agent.' },
    },
    ['account_id'],
    { idempotentHint: true },
    async (ownerId, args, ctx) =>
      sandboxOnly(async () => {
        const accountId = requireId(args, 'account_id');
        const self = ctx?.session?.workbenchId;
        const sessionId = str(args.session_id) ?? self;
        if (!sessionId) throw new Error('session_id is required');
        if (self && sessionId !== self) {
          const target = await loadSession(ownerId, sessionId);
          if (target.threadId !== self) throw new Error('A session can change its own account, or the account of a session in its thread.');
        }
        const wb = await callApi<Workbench>(ownerId, 'PUT', `/workbenches/${encodeURIComponent(sessionId)}/account`, { accountId });
        return `Session ${wb.id} will use account ${accountId} from its next turn.`;
      }),
    FEATURE
  ),
  defineTool(
    'resize_session',
    "Move a session to a sandbox of another size, for example when a build or test runs out of memory or is slow. It never stops a running turn: Talyn moves the session when the current turn ends, or at its next turn start. Files, branches, uncommitted changes and the conversation carry over. Running processes and terminals stop. The fleet can refuse a size over the account's limit: then the session keeps its sandbox and its transcript says why.",
    {
      session_id: { type: 'string', description: 'The session. Default: the calling session.' },
      size: { type: 'string', enum: RESIZE_SIZES, description: RESIZE_SIZES_TEXT },
      reason: { type: 'string', description: 'Why, in one sentence. The person sees it in the transcript.' },
      remember_for_repository: { type: 'boolean', description: "Also make this size the repository's default for new sessions." },
      continue_with: {
        type: 'string',
        description: 'A message Talyn sends to the session after this turn, so the work goes on in the new sandbox. The move happens before that turn starts.',
      },
    },
    ['size'],
    { idempotentHint: true },
    async (ownerId, args, ctx) =>
      sandboxOnly(async () => {
        const size = requireId(args, 'size');
        const self = ctx?.session?.workbenchId;
        const sessionId = str(args.session_id) ?? self;
        if (!sessionId) throw new Error('session_id is required');
        if (self && sessionId !== self) {
          const target = await loadSession(ownerId, sessionId);
          if (target.threadId !== self) throw new Error('A session can resize itself, or a session in its thread.');
        }
        const body: Record<string, unknown> = { size };
        if (str(args.reason)) body.reason = str(args.reason);
        if (args.remember_for_repository !== undefined) body.rememberForRepository = bool(args, 'remember_for_repository');
        if (str(args.continue_with)) body.continueWith = str(args.continue_with);
        const result = await callApi<SessionResizeResult>(
          ownerId,
          'PUT',
          `/workbenches/${encodeURIComponent(sessionId)}/sandbox-size`,
          body
        );
        return resizeText(sessionId, result, sessionId === self);
      }),
    FEATURE
  ),
  defineTool(
    'restart_session',
    "Restart a session on a fresh sandbox of the same size. Use it when an MCP server that the workspace connected after the sandbox started is missing from your tools: a sandbox gets its MCP servers only when it is created. It never stops a running turn: Talyn restarts the session when the current turn ends, or at its next turn start. Files, branches, uncommitted changes and the conversation carry over. Running processes and terminals stop.",
    {
      session_id: { type: 'string', description: 'The session. Default: the calling session.' },
      reason: { type: 'string', description: 'Why, in one sentence. The person sees it in the transcript.' },
      continue_with: {
        type: 'string',
        description: 'A message Talyn sends to the session after this turn, so the work goes on in the new sandbox. The restart happens before that turn starts.',
      },
    },
    [],
    { idempotentHint: true },
    async (ownerId, args, ctx) =>
      sandboxOnly(async () => {
        const self = ctx?.session?.workbenchId;
        const sessionId = str(args.session_id) ?? self;
        if (!sessionId) throw new Error('session_id is required');
        if (self && sessionId !== self) {
          const target = await loadSession(ownerId, sessionId);
          if (target.threadId !== self) throw new Error('A session can restart itself, or a session in its thread.');
        }
        const body: Record<string, unknown> = {};
        if (str(args.reason)) body.reason = str(args.reason);
        if (str(args.continue_with)) body.continueWith = str(args.continue_with);
        const result = await callApi<SessionRestartResult>(
          ownerId,
          'POST',
          `/workbenches/${encodeURIComponent(sessionId)}/restart`,
          body
        );
        return restartText(sessionId, result, sessionId === self);
      }),
    FEATURE
  ),
  defineTool(
    'session_timing',
    "Show where a session's turns spent their time: tests, installs, builds, Docker and services, waiting (sleep and polling loops), git, reading files, other tool calls, and model time. Also lists the slowest calls. Use it to find slow work to avoid in your next turns.",
    {
      session_id: { type: 'string', description: 'The session. Default: the calling session. A session can read itself and the sessions of its thread.' },
    },
    [],
    { readOnlyHint: true },
    async (ownerId, args, ctx) => {
      const sessionId = await threadScopedSession(ownerId, args, ctx, 'read the time report of');
      const timing = await callApi<WorkbenchTiming>(ownerId, 'GET', `/workbenches/${encodeURIComponent(sessionId)}/timing`);
      return timingText(timing);
    },
    FEATURE
  ),
  defineTool(
    'session_sandbox_status',
    "Show the state of a session's sandbox in plain words: starting, running, idle (and when it goes to sleep), asleep, asleep in storage, waking, moving, lost or failed. Also shows the fleet host, size and resources, how the box started (the image it booted, the wait for a free sandbox, the clone or checkout, the setup and each Setup list step, the last wake, and how the start compares with the repository's median), what runs now (a turn, queued messages, a wait for a free sandbox, the setup script or another script), when the work was last saved and what is not pushed, and the last problem. Read-only.",
    {
      session_id: { type: 'string', description: 'The session. Default: the calling session. A session can read itself and the sessions of its thread.' },
    },
    [],
    { readOnlyHint: true },
    async (ownerId, args, ctx) => {
      const sessionId = await threadScopedSession(ownerId, args, ctx, 'read the sandbox status of');
      const status = await callApi<WorkbenchSandboxStatus>(ownerId, 'GET', `/workbenches/${encodeURIComponent(sessionId)}/sandbox-status`);
      return sandboxStatusText(status);
    },
    FEATURE
  ),
  defineTool(
    'record_setup_step',
    `Add a setup step to this session's repository, so later sessions and the repository's sandbox image have it ready. Record only a step that every session on this repository needs: the dependency install, or a toolchain or CLI that the normal build, test or lint uses, for example \`cargo install sqlx-cli\` in a repository with sqlx migrations. Never record a step for one task, such as a browser for one test, a database or service for one script, or a one-off tool. One shell command per step. Talyn refuses a step that holds a secret, pipes a downloaded script into a shell (except the official rustup, uv and pnpm installers), sends data out, or pushes code. A new step is suggested in the repository's Setup list. It runs on new boxes only when a person accepts it, or when at least ${SETUP_STEP_MIN_SESSIONS} sessions and ${Math.round(SETUP_STEP_LIVE_SHARE * 100)}% of the repository's sessions of the last ${SETUP_STEP_WINDOW_DAYS} days need it. An install step goes into the image. A step that fails on two boxes in a row stops. Docker starts on demand, so never record a Docker start. A person can dismiss any learned step.`,
    {
      command: { type: 'string', description: 'One shell command, as you ran it. No secrets.' },
      why: { type: 'string', description: 'Why later sessions need this step.' },
      session_id: { type: 'string', description: 'The session whose repository gets the step. Default: the calling session.' },
    },
    ['command', 'why'],
    { idempotentHint: true },
    async (ownerId, args, ctx) =>
      sandboxOnly(async () => {
        const command = requireId(args, 'command');
        const why = requireId(args, 'why');
        const sessionId = await threadScopedSession(ownerId, args, ctx, 'record a setup step for');
        const wb = await loadSandboxSession(ownerId, sessionId);
        if (wb.kind === 'thread' || !wb.repositoryId) {
          throw new Error('A thread has no repository, so it has no setup. Record the step from a session on the repository.');
        }
        const result = await callApi<RecordSetupStepResult>(
          ownerId,
          'POST',
          `/repositories/${encodeURIComponent(wb.repositoryId)}/setup-recipe/steps`,
          { command, why, sessionId: wb.id }
        );
        const lines = result.steps.map(
          (s) => `  ${s.id}  ${RECORDED_STATUS[s.state]}  [${s.kind}, ${s.phase === 'install' ? 'image' : 'box'}]  ${s.command}${s.stateReason ? `\n    ${s.stateReason}` : ''}`
        );
        return [`Added to the Setup list of ${wb.repoFullName}. An active step runs on new boxes after the repository's own setup:`, ...lines].join('\n');
      }),
    FEATURE
  ),
  defineTool(
    'get_session_transcript',
    'Read a chat transcript as text, oldest first. Output is capped; follow the cursor in the last line for the next page.',
    {
      ...chatTargetSchema,
      cursor: {
        type: 'integer',
        minimum: 0,
        description: 'Return events after this sequence number. Default 0.',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: MAX_EVENT_LIMIT,
        default: DEFAULT_EVENT_LIMIT,
        description: 'Events per page.',
      },
    },
    [],
    { readOnlyHint: true },
    async (ownerId, args) => {
      const limit = eventLimit(args);
      const cursor = args.cursor ?? 0;
      if (typeof cursor !== 'number' || !Number.isInteger(cursor) || cursor < 0) {
        throw new Error('cursor must be a non-negative integer');
      }
      // A local session keeps its events too, so reading never needs the sandbox check.
      let chatId = str(args.chat_id);
      if (!chatId) {
        const sessionId = requireId(args, 'session_id');
        chatId = (await loadSession(ownerId, sessionId)).chats?.[0]?.id;
        if (!chatId) throw new Error(`Session ${sessionId} has no open chat.`);
      }
      const params = new URLSearchParams({ after: String(cursor), limit: String(limit) });
      return renderTranscript(
        await callApi<{ events: WorkbenchEvent[]; cursor: number }>(
          ownerId,
          'GET',
          `/workbenches/chats/${encodeURIComponent(chatId)}/events?${params}`
        ),
        limit
      );
    },
    FEATURE
  ),
  defineTool(
    'cancel_session_turn',
    'Stop the turn that is running in a session chat. The transcript stays.',
    chatTargetSchema,
    [],
    { destructiveHint: true, idempotentHint: true },
    async (ownerId, args, ctx) =>
      sandboxOnly(async () => {
        const chatId = await resolveChat(ownerId, args);
        if (await targetsSelf(ctx, args, chatId)) throw new Error(SELF_CANCEL);
        await callApi(ownerId, 'POST', `/workbenches/chats/${encodeURIComponent(chatId)}/cancel`);
        return `Chat ${chatId}: cancel requested.`;
      }),
    FEATURE
  ),
  defineTool(
    'get_session_changes',
    'List the files a session changed against its base branch, with added and removed line counts.',
    sessionIdSchema,
    ['session_id'],
    { readOnlyHint: true },
    async (ownerId, args) =>
      sandboxOnly(async () => {
        const id = requireId(args, 'session_id');
        await loadSandboxSession(ownerId, id);
        const changes = await callApi<WorkbenchChanges>(ownerId, 'GET', `/workbenches/${encodeURIComponent(id)}/changes`);
        const lines = changes.files.map(
          (f) =>
            `${f.path}  ${f.status}${f.oldPath ? ` (from ${f.oldPath})` : ''}  ${f.binary ? 'binary' : `+${f.added}/-${f.removed}`}`
        );
        const asOf = changes.snapshotAt ? `As of ${changes.snapshotAt} (sandbox asleep; Talyn's stored copy).\n` : '';
        return lines.length
          ? `${asOf}${lines.join('\n')}\nhead: ${changes.headSha}  base: ${changes.base}`
          : `${asOf}No changes.`;
      }),
    FEATURE
  ),
  defineTool(
    'get_session_diff',
    'Get the unified diff of a session against its base branch. Pass path to read one file. Large diffs are cut. ' +
      'A sleeping sandbox answers from the copy Talyn stored, or from GitHub when the work is all pushed. Pass live=true to wake it and read it now.',
    {
      ...sessionIdSchema,
      path: { type: 'string', description: 'Limit the diff to this file.' },
      live: { type: 'boolean', description: 'Read the sandbox now, and wake it if it sleeps. Default false.' },
    },
    ['session_id'],
    { readOnlyHint: true },
    async (ownerId, args) =>
      sandboxOnly(async () => {
        const id = requireId(args, 'session_id');
        await loadSandboxSession(ownerId, id);
        const params = new URLSearchParams();
        if (str(args.path)) params.set('path', str(args.path)!);
        if (args.live !== undefined && bool(args, 'live')) params.set('live', '1');
        const query = params.toString();
        const diff = await callApi<WorkbenchDiff>(
          ownerId,
          'GET',
          `/workbenches/${encodeURIComponent(id)}/diff${query ? `?${query}` : ''}`
        );
        const asOf = diff.source === 'stored'
          ? `As of ${diff.snapshotAt} (sandbox asleep; Talyn's stored copy).\n`
          : diff.source === 'github'
            ? `From GitHub, ${diff.mergeBase?.slice(0, 8)}..${diff.headSha?.slice(0, 8)} (sandbox asleep).\n`
            : '';
        if (!diff.patch) return `${asOf}No diff.`;
        return asOf + capped(diff.patch, 'Pass path to read one file at a time. Use talyn_get_session_changes to list the files.');
      }),
    FEATURE
  ),
  defineTool(
    'open_session_pull_request',
    "Commit and push a session's work, then open a pull request. Links the existing pull request if the branch already has one.",
    {
      ...sessionIdSchema,
      title: textSchema,
      body: textSchema,
      base: { type: 'string', description: "Default: the session's base branch." },
      draft: booleanSchema,
      commit_message: { type: 'string', description: 'Used when there are uncommitted changes. Default: the title.' },
    },
    ['session_id', 'title'],
    { openWorldHint: true },
    async (ownerId, args) =>
      sandboxOnly(async () => {
        const id = requireId(args, 'session_id');
        await loadSandboxSession(ownerId, id);
        const body: Record<string, unknown> = { title: requireId(args, 'title') };
        for (const [arg, field] of [
          ['body', 'body'],
          ['base', 'base'],
          ['commit_message', 'commitMessage'],
        ] as const) {
          if (typeof args[arg] === 'string') body[field] = args[arg];
        }
        if (args.draft !== undefined) body.draft = bool(args, 'draft');
        const result = await callApi<CreateWorkbenchPullRequestResult>(
          ownerId,
          'POST',
          `/workbenches/${encodeURIComponent(id)}/pull-request`,
          body
        );
        return `${result.existing ? 'Linked the open pull request' : 'Opened pull request'} #${result.pullRequest.number}  ${result.pullRequest.url}`;
      }),
    FEATURE
  ),
  defineTool(
    'run_session_script',
    "Start one of the session's named scripts (from its setup or run config) in the sandbox.",
    { ...sessionIdSchema, name: { type: 'string', description: 'The script name.' } },
    ['session_id', 'name'],
    { openWorldHint: true },
    async (ownerId, args) =>
      sandboxOnly(async () => {
        const id = requireId(args, 'session_id');
        const name = requireId(args, 'name');
        await loadSandboxSession(ownerId, id);
        await callApi(ownerId, 'POST', `/workbenches/${encodeURIComponent(id)}/scripts/${encodeURIComponent(name)}`);
        return `Script ${name} started.`;
      }),
    FEATURE
  ),
  defineTool(
    'stop_session_script',
    'Stop a script that is running in a session.',
    { ...sessionIdSchema, name: { type: 'string', description: 'The script name.' } },
    ['session_id', 'name'],
    { idempotentHint: true },
    async (ownerId, args) =>
      sandboxOnly(async () => {
        const id = requireId(args, 'session_id');
        const name = requireId(args, 'name');
        await loadSandboxSession(ownerId, id);
        await callApi(ownerId, 'POST', `/workbenches/${encodeURIComponent(id)}/scripts/${encodeURIComponent(name)}/stop`);
        return `Script ${name} stopped.`;
      }),
    FEATURE
  ),
  defineTool(
    'archive_session',
    'Archive a session. It leaves the default list and its sandbox stops. Restore it to use it again. Inside a session, archiving that same session happens after the current reply ends.',
    sessionIdSchema,
    ['session_id'],
    { destructiveHint: true, idempotentHint: true },
    async (ownerId, args, ctx) => {
      const id = requireId(args, 'session_id');
      const path = `/workbenches/${encodeURIComponent(id)}/archive`;
      // Archiving now would cancel the turn that asked and delete its box.
      if (await targetsSelf(ctx, args)) {
        const wb = await callApi<Workbench>(ownerId, 'POST', path, { afterTurn: true });
        return wb.archivedAt ? sessionLine(wb) : SELF_ARCHIVE_DEFERRED;
      }
      return sessionLine(await callApi<Workbench>(ownerId, 'POST', path));
    },
    FEATURE
  ),
  defineTool(
    'restore_session',
    'Restore an archived session. To start a failed session again, use talyn_retry_session.',
    sessionIdSchema,
    ['session_id'],
    { idempotentHint: true, openWorldHint: true },
    async (ownerId, args, ctx) =>
      sandboxOnly(async () => {
        if (await targetsSelf(ctx, args)) throw new Error(SELF_RESTORE);
        return sessionLine(
          await callApi<Workbench>(
            ownerId,
            'POST',
            `/workbenches/${encodeURIComponent(requireId(args, 'session_id'))}/restore`
          )
        );
      }),
    FEATURE
  ),
  defineTool(
    'retry_session',
    'Restart a session that failed, or one that is stuck while it starts, on a new sandbox. The old sandbox is deleted. A session that is ready or archived is refused.',
    sessionIdSchema,
    ['session_id'],
    { destructiveHint: true, openWorldHint: true },
    async (ownerId, args, ctx) =>
      sandboxOnly(async () => {
        if (await targetsSelf(ctx, args)) throw new Error(SELF_RETRY);
        return sessionLine(
          await callApi<Workbench>(
            ownerId,
            'POST',
            `/workbenches/${encodeURIComponent(requireId(args, 'session_id'))}/retry`
          )
        );
      }),
    FEATURE
  ),
];
