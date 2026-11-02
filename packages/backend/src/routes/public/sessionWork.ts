import type { WorkbenchAgent } from '@talyn/shared';
import { IdParams, Session, SessionList } from '../../schemas/public/resources.js';
import {
  ActionReceipt,
  ContinueAsThreadBody,
  CreatePreviewLinkBody,
  CreatePullRequestBody,
  FileContent,
  FileList,
  GetChangesQuery,
  GetDiffQuery,
  GetFileQuery,
  ListScriptsQuery,
  PreviewLink,
  PreviewList,
  PromptActionBody,
  PullRequestReceipt,
  ResizeReceipt,
  ResizeSessionBody,
  Script,
  ScriptList,
  ScriptOutput,
  ScriptParams,
  SessionChanges,
  SessionDiff,
  SessionReadiness,
  SessionTiming,
} from '../../schemas/public/sessionWork.js';
import { PageQuery } from '../../schemas/public/common.js';
import { z } from '../../schemas/public/zod.js';
import { previewOrigin, previewBaseDomain } from '../../services/preview/previewHost.js';
import { effectivePreview } from '../../services/preview/repoPreview.js';
import { authorizeWorkspace, refuseLocalRuntime } from '../../services/public/authorize.js';
import { decodeCursor, pageOf } from '../../services/public/cursor.js';
import { PublicApiError, notFound } from '../../services/public/errors.js';
import { toPublicSession } from '../../services/public/projections.js';
import { getSessionQuery, openChatsQuery } from '../../services/public/queries.js';
import {
  toPublicChanges,
  toPublicPreview,
  toPublicPreviewLink,
  toPublicReadiness,
  toPublicScript,
  toPublicScripts,
  toPublicTiming,
} from '../../services/public/workProjections.js';
import {
  authorizedWorkbench,
  getScriptRunQuery,
  listPreviewHostsQuery,
  listScriptRunsQuery,
  listThreadSessionsQuery,
  repositorySettingsOf,
} from '../../services/public/workQueries.js';
import { runWorkbenchAction } from '../../services/workbenches/actions.js';
import { refuseThread } from '../../services/workbenches/errors.js';
import { createWorkbenchPullRequest } from '../../services/workbenches/pullRequest.js';
import { workbenchReadiness } from '../../services/workbenches/readiness.js';
import {
  createSessionPreviewLink,
  listSessionFiles,
  readSessionChanges,
  readSessionConfig,
  readSessionDiff,
  readSessionFile,
  resizeSession,
  startSessionScript,
  stopSessionScript,
} from '../../services/workbenches/sessionOps.js';
import { isThread } from '../../services/workbenches/store.js';
import { continueAsThread } from '../../services/workbenches/threads.js';
import { getWorkbenchTiming } from '../../services/workbenches/turnInsights.js';
import { definePublicRoute, type PublicRoute } from './define.js';

/** A session with its open chats, read after a change so the answer is what is stored. */
async function sessionWithChats(id: string) {
  const [row] = await getSessionQuery(id);
  if (!row) throw notFound('session');
  return toPublicSession(row, await openChatsQuery(id));
}

async function scriptState(sessionId: string, name: string) {
  const [run] = await getScriptRunQuery(sessionId, name);
  return toPublicScript(sessionId, name, run);
}

const ThreadSessionsQuery = z.object(PageQuery).strict();

/**
 * The work inside a session: its changes, diff and files, its scripts and
 * previews, the pull request actions, threads, timing and resize.
 *
 * Reads that need the sandbox wake it. The changes list and the scripts list
 * do not: they answer from what Talyn stored unless the caller sends
 * `live=true`.
 */
export const sessionWorkRoutes: PublicRoute[] = [
  // ---- Changes, diff and files ----

  definePublicRoute({
    method: 'get',
    path: '/sessions/{id}/changes',
    operationId: 'getSessionChanges',
    summary: 'List changed files',
    description:
      'The files the session changed, with line counts. A sleeping sandbox answers from the copy Talyn stored when it last read the sandbox, ' +
      'and `snapshot_at` says when that was. Send `live=true` to read the sandbox now; that wakes it. ' +
      'A sleeping sandbox with no stored copy answers 409 `snapshot_unavailable`.',
    tag: 'Session work',
    scope: 'sessions:read',
    sessions: true,
    params: IdParams,
    query: GetChangesQuery,
    responses: { 200: { description: 'The changed files.', schema: SessionChanges } },
    async handler({ params, query, token }) {
      const { row } = await authorizedWorkbench(token, params.id);
      const changes = await readSessionChanges(row, { live: query.live === true, wakeWithoutSnapshot: false });
      return { status: 200, body: toPublicChanges(row.id, changes) };
    },
  }),

  definePublicRoute({
    method: 'get',
    path: '/sessions/{id}/diff',
    operationId: 'getSessionDiff',
    summary: 'Read the diff',
    description: 'A unified diff of the whole session, or of one file with `path`. Reads the sandbox, and wakes it if it sleeps.',
    tag: 'Session work',
    scope: 'sessions:read',
    sessions: true,
    params: IdParams,
    query: GetDiffQuery,
    responses: { 200: { description: 'The diff.', schema: SessionDiff } },
    async handler({ params, query, token }) {
      const { row } = await authorizedWorkbench(token, params.id);
      const { patch } = await readSessionDiff(row, query.path, query.scope);
      return {
        status: 200,
        body: { object: 'diff', session_id: row.id, path: query.path ?? null, scope: query.scope ?? 'combined', patch },
      };
    },
  }),

  definePublicRoute({
    method: 'get',
    path: '/sessions/{id}/files',
    operationId: 'listSessionFiles',
    summary: 'List files',
    description: 'Every file in the repository checkout, tracked and untracked. Files that git ignores are left out. Wakes the sandbox.',
    tag: 'Session work',
    scope: 'sessions:read',
    sessions: true,
    params: IdParams,
    responses: { 200: { description: 'The paths.', schema: FileList } },
    async handler({ params, token }) {
      const { row } = await authorizedWorkbench(token, params.id);
      const { paths } = await listSessionFiles(row);
      return { status: 200, body: { object: 'file_list', session_id: row.id, paths } };
    },
  }),

  definePublicRoute({
    method: 'get',
    path: '/sessions/{id}/files/content',
    operationId: 'getSessionFile',
    summary: 'Read a file',
    description:
      'One file as it is in the sandbox now. Text comes back as UTF-8, a binary file as base64. ' +
      'A file over 4 MiB answers 413 `file_too_large`. Wakes the sandbox.',
    tag: 'Session work',
    scope: 'sessions:read',
    sessions: true,
    params: IdParams,
    query: GetFileQuery,
    responses: { 200: { description: 'The file.', schema: FileContent } },
    async handler({ params, query, token }) {
      const { row } = await authorizedWorkbench(token, params.id);
      const file = await readSessionFile(row, query.path);
      return {
        status: 200,
        body: { object: 'file_content', session_id: row.id, path: query.path, encoding: file.binary ? 'base64' : 'utf8', content: file.content },
      };
    },
  }),

  // ---- Scripts ----

  definePublicRoute({
    method: 'get',
    path: '/sessions/{id}/scripts',
    operationId: 'listSessionScripts',
    summary: 'List scripts',
    description:
      'The setup, run and archive scripts of the session and their state. By default only the scripts that have run, with no wake. ' +
      'With `live=true`, also every script the config defines (`.talyn/settings.toml` or Conductor), with its command; that wakes the sandbox.',
    tag: 'Session work',
    scope: 'sessions:read',
    sessions: true,
    params: IdParams,
    query: ListScriptsQuery,
    responses: { 200: { description: 'The scripts. Never paged.', schema: ScriptList } },
    async handler({ params, query, token }) {
      const { row } = await authorizedWorkbench(token, params.id);
      const runs = await listScriptRunsQuery(row.id);
      const config = query.live === true ? await readSessionConfig(row) : null;
      return { status: 200, body: { object: 'list', data: toPublicScripts(row.id, runs, config), has_more: false, next_cursor: null } };
    },
  }),

  definePublicRoute({
    method: 'post',
    path: '/sessions/{id}/scripts/{name}/start',
    operationId: 'startSessionScript',
    summary: 'Start a script',
    description:
      'Starts `setup`, `run` (the default run script), `archive`, or a named run script. Answers when the script has started. ' +
      'A script that is already running answers 409 `script_running`. Wakes the sandbox.',
    tag: 'Session work',
    scope: 'sessions:write',
    sessions: true,
    creates: true,
    params: ScriptParams,
    responses: { 200: { description: 'The script.', schema: Script } },
    async handler({ params, token }) {
      const { session, row } = await authorizedWorkbench(token, params.id);
      refuseLocalRuntime(session);
      await startSessionScript(row, params.name);
      return { status: 200, body: await scriptState(row.id, params.name) };
    },
  }),

  definePublicRoute({
    method: 'post',
    path: '/sessions/{id}/scripts/{name}/stop',
    operationId: 'stopSessionScript',
    summary: 'Stop a script',
    description: 'Stops the script in the sandbox. Stopping a script that does not run changes nothing.',
    tag: 'Session work',
    scope: 'sessions:write',
    sessions: true,
    params: ScriptParams,
    responses: { 200: { description: 'The script.', schema: Script } },
    async handler({ params, token }) {
      const { session, row } = await authorizedWorkbench(token, params.id);
      refuseLocalRuntime(session);
      await stopSessionScript(row, params.name);
      return { status: 200, body: await scriptState(row.id, params.name) };
    },
  }),

  definePublicRoute({
    method: 'get',
    path: '/sessions/{id}/scripts/{name}/output',
    operationId: 'getSessionScriptOutput',
    summary: "Read a script's output",
    description:
      'The end of what the script wrote, at most 64 KiB, from what Talyn stored. Does not wake the sandbox. ' +
      'Poll it while `status` is `running`. A script that has not run answers `not_started` with no output.',
    tag: 'Session work',
    scope: 'sessions:read',
    sessions: true,
    params: ScriptParams,
    responses: { 200: { description: 'The output.', schema: ScriptOutput } },
    async handler({ params, token }) {
      const { row } = await authorizedWorkbench(token, params.id);
      const [run] = await getScriptRunQuery(row.id, params.name);
      const state = toPublicScript(row.id, params.name, run);
      return {
        status: 200,
        body: {
          object: 'script_output',
          session_id: row.id,
          name: params.name,
          status: state.status,
          exit_code: state.exit_code,
          output: run?.output ?? '',
        },
      };
    },
  }),

  // ---- Previews ----

  definePublicRoute({
    method: 'get',
    path: '/sessions/{id}/previews',
    operationId: 'listSessionPreviews',
    summary: 'List preview ports',
    description:
      "The ports the repository's preview settings name, and every port that has a hosted preview link. Does not wake the sandbox. " +
      'To open one, make a link with POST /sessions/{id}/previews.',
    tag: 'Session work',
    scope: 'sessions:read',
    sessions: true,
    params: IdParams,
    responses: { 200: { description: 'The preview ports. Never paged.', schema: PreviewList } },
    async handler({ params, token }) {
      const { row } = await authorizedWorkbench(token, params.id);
      const repo = isThread(row) ? null : await repositorySettingsOf(row.repositoryId);
      const configured = repo ? effectivePreview(repo).ports : [];
      const domain = previewBaseDomain();
      const hosts = await listPreviewHostsQuery(row.id);
      const originOf = (port: number) => {
        const host = hosts.find((h) => h.port === port);
        return host && domain ? previewOrigin(`${host.id}-${port}.${domain}`) : null;
      };
      const data = configured.map((p) => toPublicPreview(row.id, p, originOf(p.port)));
      for (const host of hosts) {
        if (!configured.some((p) => p.port === host.port)) data.push(toPublicPreview(row.id, { port: host.port }, originOf(host.port)));
      }
      return { status: 200, body: { object: 'list', data, has_more: false, next_cursor: null } };
    },
  }),

  definePublicRoute({
    method: 'post',
    path: '/sessions/{id}/previews',
    operationId: 'createSessionPreviewLink',
    summary: 'Make a preview link',
    description:
      'A one-time sign-in link to a port of the sandbox on its own host. Open `url` in a browser within 10 minutes. ' +
      'The browser then gets a cookie for that host that lasts 12 hours. The link works once. ' +
      'Answers 404 `preview_links_unavailable` when this deployment has no preview domain.',
    tag: 'Session work',
    scope: 'sessions:write',
    sessions: true,
    creates: true,
    params: IdParams,
    body: CreatePreviewLinkBody,
    responses: { 201: { description: 'The link.', schema: PreviewLink } },
    async handler({ params, body, token }) {
      const { session, row } = await authorizedWorkbench(token, params.id);
      refuseLocalRuntime(session);
      const link = await createSessionPreviewLink(row, body.port, token.ownerId);
      return { status: 201, body: toPublicPreviewLink(row.id, link) };
    },
  }),

  // ---- Pull request actions ----

  definePublicRoute({
    method: 'post',
    path: '/sessions/{id}/pull_request',
    operationId: 'createSessionPullRequest',
    summary: 'Open a pull request',
    description:
      "Commits what is not committed, pushes the branch and opens a pull request on GitHub from the token owner's account. " +
      'When a pull request from the branch is already open, the session is linked to it and `existing` is true. ' +
      'Uses your GitHub rate limit.',
    tag: 'Session work',
    scope: 'sessions:write',
    sessions: true,
    creates: true,
    params: IdParams,
    body: CreatePullRequestBody,
    responses: {
      200: { description: 'A pull request was already open; the session is linked to it.', schema: PullRequestReceipt },
      201: { description: 'The pull request is open.', schema: PullRequestReceipt },
    },
    async handler({ params, body, token }) {
      const { session, row } = await authorizedWorkbench(token, params.id);
      refuseLocalRuntime(session);
      refuseThread(row);
      const result = await createWorkbenchPullRequest(row, {
        title: body.title,
        ...(body.body !== undefined ? { body: body.body } : {}),
        ...(body.base !== undefined ? { base: body.base } : {}),
        ...(body.draft !== undefined ? { draft: body.draft } : {}),
        ...(body.commit_message !== undefined ? { commitMessage: body.commit_message } : {}),
      });
      return {
        status: result.existing ? 200 : 201,
        body: {
          object: 'pull_request_receipt',
          session_id: row.id,
          number: result.pullRequest.number,
          url: result.pullRequest.url,
          existing: result.existing,
          session: await sessionWithChats(row.id),
        },
      };
    },
  }),

  ...(['fix_checks', 'resolve_conflicts'] as const).map((action) =>
    definePublicRoute({
      method: 'post',
      path: `/sessions/{id}/${action}`,
      operationId: action === 'fix_checks' ? 'fixSessionChecks' : 'resolveSessionConflicts',
      summary: action === 'fix_checks' ? 'Ask the agent to fix failing checks' : 'Ask the agent to resolve conflicts',
      description:
        (action === 'fix_checks'
          ? "Sends the agent the app's fix-checks prompt with the failing checks of the linked pull request. "
          : "Sends the agent the app's prompt to merge the base branch and resolve the conflicts. ") +
        'The message queues behind a running turn. A cloud task that works on the same pull request answers 409 `task_active`.',
      tag: 'Session work',
      scope: 'sessions:write',
      sessions: true,
      creates: true,
      params: IdParams,
      body: PromptActionBody,
      responses: { 202: { description: 'The prompt is sent.', schema: ActionReceipt } },
      async handler({ params, body, token }) {
        const { session, row } = await authorizedWorkbench(token, params.id);
        refuseLocalRuntime(session);
        refuseThread(row);
        const result = await runWorkbenchAction(row, action, body.chat_id);
        return { status: 202, body: { object: 'action_receipt', session_id: row.id, action, chat_id: result.chatId ?? null } };
      },
    }),
  ),

  definePublicRoute({
    method: 'post',
    path: '/sessions/{id}/merge',
    operationId: 'mergeSessionPullRequest',
    summary: "Merge the session's pull request",
    description:
      'Merges the linked pull request on GitHub with its merge method (squash by default). ' +
      'No linked pull request answers 409 `no_pull_request`; a refusal from GitHub answers 409 `merge_failed`. Uses your GitHub rate limit.',
    tag: 'Session work',
    scope: 'sessions:write',
    sessions: true,
    creates: true,
    params: IdParams,
    responses: { 200: { description: 'The pull request is merged.', schema: ActionReceipt } },
    async handler({ params, token }) {
      const { session, row } = await authorizedWorkbench(token, params.id);
      refuseLocalRuntime(session);
      refuseThread(row);
      await runWorkbenchAction(row, 'merge');
      return { status: 200, body: { object: 'action_receipt', session_id: row.id, action: 'merge', chat_id: null } };
    },
  }),

  // ---- Threads ----

  definePublicRoute({
    method: 'get',
    path: '/sessions/{id}/sessions',
    operationId: 'listThreadSessions',
    summary: "List a thread's sessions",
    description: 'The sessions a thread started, newest first, archived ones included. A session that is not a thread answers 409 `not_thread`.',
    tag: 'Threads',
    scope: 'sessions:read',
    sessions: true,
    params: IdParams,
    query: ThreadSessionsQuery,
    responses: { 200: { description: 'A page of sessions.', schema: SessionList } },
    async handler({ params, query, token }) {
      const { row } = await authorizedWorkbench(token, params.id);
      if (!isThread(row)) throw new PublicApiError(409, 'not_thread', 'This is a session, not a thread.');
      const rows = await listThreadSessionsQuery(row.id, decodeCursor(query.cursor), query.limit);
      const page = pageOf(rows, query.limit);
      return {
        status: 200,
        body: { object: 'list', data: page.rows.map((r) => toPublicSession(r)), has_more: page.hasMore, next_cursor: page.nextCursor },
      };
    },
  }),

  definePublicRoute({
    method: 'post',
    path: '/sessions/{id}/thread',
    operationId: 'continueSessionAsThread',
    summary: 'Continue a session as a thread',
    description:
      "Starts a thread whose first message recaps the session's chat. The session joins the thread. " +
      'Counts against the plan like a session started in the app.',
    tag: 'Threads',
    scope: 'sessions:write',
    sessions: true,
    creates: true,
    params: IdParams,
    body: ContinueAsThreadBody,
    responses: { 201: { description: 'The new thread. `kind` is `thread`.', schema: Session } },
    async handler({ params, body, token }) {
      const { session, row } = await authorizedWorkbench(token, params.id);
      refuseLocalRuntime(session);
      const thread = await continueAsThread(
        row,
        {
          ...(body.agent !== undefined ? { agent: body.agent as WorkbenchAgent } : {}),
          ...(body.model !== undefined ? { model: body.model } : {}),
          ...(body.prompt !== undefined ? { prompt: body.prompt } : {}),
        },
        { id: token.ownerId, email: token.email },
      );
      return { status: 201, body: await sessionWithChats(thread.id) };
    },
  }),

  // ---- Timing, resize, readiness ----

  definePublicRoute({
    method: 'get',
    path: '/sessions/{id}/timing',
    operationId: 'getSessionTiming',
    summary: 'Get where the time went',
    description: "Where the session's turns spent their time: model, tests, installs, builds and the rest. Read from stored turn reports.",
    tag: 'Session work',
    scope: 'sessions:read',
    sessions: true,
    params: IdParams,
    responses: { 200: { description: 'The timing summary.', schema: SessionTiming } },
    async handler({ params, token }) {
      const { row } = await authorizedWorkbench(token, params.id);
      return { status: 200, body: toPublicTiming(row.id, await getWorkbenchTiming(row.id)) };
    },
  }),

  definePublicRoute({
    method: 'post',
    path: '/sessions/{id}/resize',
    operationId: 'resizeSession',
    summary: 'Move the session to another sandbox size',
    description:
      'Moves the work to a sandbox of the new size when no turn runs, else after the running turn. ' +
      'With `continue_with`, the message goes to the chat and its turn starts on the new sandbox.',
    tag: 'Session work',
    scope: 'sessions:write',
    sessions: true,
    creates: true,
    params: IdParams,
    body: ResizeSessionBody,
    responses: { 200: { description: 'What happens next.', schema: ResizeReceipt } },
    async handler({ params, body, token }) {
      const { session, row } = await authorizedWorkbench(token, params.id);
      refuseLocalRuntime(session);
      const result = await resizeSession(
        row,
        {
          size: body.size,
          ...(body.reason !== undefined ? { reason: body.reason } : {}),
          ...(body.remember_for_repository !== undefined ? { rememberForRepository: body.remember_for_repository } : {}),
        },
        body.continue_with?.trim() ?? '',
      );
      return {
        status: 200,
        body: {
          object: 'resize_receipt',
          session_id: row.id,
          outcome: result.outcome,
          size: result.size,
          remembered_for_repository: result.rememberedForRepository,
          continued: result.continued,
        },
      };
    },
  }),

  definePublicRoute({
    method: 'get',
    path: '/workspaces/{id}/readiness',
    operationId: 'getSessionReadiness',
    summary: 'Check whether sessions can start',
    description:
      'Whether this workspace can start a sandbox session now, and with which agents. Each reason has a `code` and a message to show. ' +
      'Answers even when sessions are not available for the account: that is the reason `flag_off`.',
    tag: 'Sessions',
    scope: 'sessions:read',
    params: IdParams,
    responses: { 200: { description: 'The readiness.', schema: SessionReadiness } },
    async handler({ params, token }) {
      await authorizeWorkspace(token, params.id);
      const readiness = await workbenchReadiness(params.id, { id: token.ownerId, email: token.email });
      return { status: 200, body: toPublicReadiness(params.id, readiness) };
    },
  }),
];
