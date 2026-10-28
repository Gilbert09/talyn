import {
  buildBlocks,
  describeTool,
  extractToolText,
  type AgentEvent,
  type CreateWorkbenchPullRequestResult,
  type Workbench,
  type WorkbenchChanges,
  type WorkbenchChat,
  type WorkbenchEvent,
} from '@talyn/shared';
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
      const content = event.message?.content;
      const text = Array.isArray(content)
        ? content
            .map((part) => (part as { text?: unknown }).text)
            .filter((t): t is string => typeof t === 'string')
            .join('\n')
        : '';
      if (text) items.push({ seq, text: `user: ${text}` });
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
        if (block.text) items.push({ seq, text: `[system] ${block.text}` });
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
      agent: { type: 'string', enum: ['claude', 'codex'], description: 'Fixed for the life of the session.' },
      model: textSchema,
      prompt: { type: 'string', description: 'The first message.' },
      branch: { type: 'string', description: 'An existing branch to check out. Default: a new branch.' },
      base_branch: { type: 'string', description: "Default: the repository's default branch." },
      pull_request_id: { type: 'string', description: 'Start from this pull request’s branch.' },
      name: { type: 'string', description: 'Lowercase letters, digits and hyphens.' },
      internet_access: booleanSchema,
      auto_create_pr: booleanSchema,
    },
    ['repository_id', 'agent'],
    { openWorldHint: true },
    async (ownerId, args) => {
      const agent = str(args.agent);
      if (agent !== 'claude' && agent !== 'codex') throw new Error('agent must be "claude" or "codex"');
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
      return sessionDetail(await callApi<Workbench>(ownerId, 'POST', '/workbenches', body));
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
    async (ownerId, args) =>
      sandboxOnly(async () => {
        const text = requireId(args, 'text');
        const chatId = await resolveChat(ownerId, args);
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
    async (ownerId, args) =>
      sandboxOnly(async () => {
        const chatId = await resolveChat(ownerId, args);
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
        return lines.length
          ? `${lines.join('\n')}\nhead: ${changes.headSha}  base: ${changes.base}`
          : 'No changes.';
      }),
    FEATURE
  ),
  defineTool(
    'get_session_diff',
    'Get the unified diff of a session against its base branch. Pass path to read one file. Large diffs are cut.',
    { ...sessionIdSchema, path: { type: 'string', description: 'Limit the diff to this file.' } },
    ['session_id'],
    { readOnlyHint: true },
    async (ownerId, args) =>
      sandboxOnly(async () => {
        const id = requireId(args, 'session_id');
        await loadSandboxSession(ownerId, id);
        const params = new URLSearchParams();
        if (str(args.path)) params.set('path', str(args.path)!);
        const query = params.toString();
        const { patch } = await callApi<{ patch: string }>(
          ownerId,
          'GET',
          `/workbenches/${encodeURIComponent(id)}/diff${query ? `?${query}` : ''}`
        );
        if (!patch) return 'No diff.';
        return capped(patch, 'Pass path to read one file at a time. Use talyn_get_session_changes to list the files.');
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
    'Archive a session. It leaves the default list and its sandbox stops. Restore it to use it again.',
    sessionIdSchema,
    ['session_id'],
    { destructiveHint: true, idempotentHint: true },
    async (ownerId, args) =>
      sessionLine(
        await callApi<Workbench>(
          ownerId,
          'POST',
          `/workbenches/${encodeURIComponent(requireId(args, 'session_id'))}/archive`
        )
      ),
    FEATURE
  ),
  defineTool(
    'restore_session',
    'Restore an archived session, or retry one that failed to start.',
    sessionIdSchema,
    ['session_id'],
    { idempotentHint: true, openWorldHint: true },
    async (ownerId, args) =>
      sandboxOnly(async () =>
        sessionLine(
          await callApi<Workbench>(
            ownerId,
            'POST',
            `/workbenches/${encodeURIComponent(requireId(args, 'session_id'))}/restore`
          )
        )
      ),
    FEATURE
  ),
];
