import { gunzip } from 'zlib';
import { promisify } from 'util';
import {
  claudeProjectSlug,
  claudeSessionToEvents,
  isClaudeSessionId,
  shellQuote,
  type WorkbenchImportHeader,
  type WorkbenchImportResult,
} from '@talyn/shared';
import { refreshDiffStat } from './changes.js';
import { emitWorkbenchChat } from './emit.js';
import { WorkbenchError } from './errors.js';
import { recordWorkbenchEvent, repoDirFor, runCapture } from './sandboxRuntime.js';
import { shellPath, writeSandboxFiles } from './sandboxFiles.js';
import { startQueuedIfIdle } from './turns.js';
import { appendEvents, claimChatForImport, getWorkbench, rowToChat, updateChat, type ChatRow, type WorkbenchRow } from './store.js';

/**
 * Continue a local Claude Code conversation in a fresh sandbox session. The
 * body framing and the size limit are in `claudeSessionImport.ts` (shared).
 */

const gunzipAsync = promisify(gunzip);

export const IMPORT_DIR = '~/.talyn/import';
const MAX_HEADER_BYTES = 16 * 1024;
/**
 * The largest conversation after gunzip. About four times the largest real
 * one seen (58 MB); it bounds a gzip bomb, not a real conversation.
 */
export const MAX_IMPORTED_SESSION_BYTES = 256 * 1024 * 1024;
/** Events per insert. One statement per batch; 500 keeps a statement to a few MB. */
const EVENT_BATCH = 500;
const IMPORTING_MESSAGE = 'Importing the conversation';

export type ImportStep = 'upload' | 'fetch' | 'checkout' | 'apply' | 'session' | 'transcript';

/** The exit code the box script uses for each step that can fail. */
export const IMPORT_EXIT_CODES: Record<number, ImportStep> = { 10: 'fetch', 11: 'checkout', 12: 'apply', 13: 'session' };

const STEP_COPY: Record<ImportStep, string> = {
  upload: 'Could not copy the files into the sandbox.',
  fetch: 'Could not fetch the base commit in the sandbox. Push your default branch, then try again.',
  checkout: 'Could not check out the base commit in the sandbox.',
  apply: 'Could not apply your changes in the sandbox.',
  session: 'Could not save the conversation in the sandbox.',
  transcript: 'Could not save the conversation in Talyn.',
};

export interface ParsedImport {
  header: WorkbenchImportHeader;
  session: Buffer;
  patch: Buffer;
}

const bad = (message: string) => new WorkbenchError(message, 400, 'bad_import');
const isGzip = (b: Buffer) => b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b;
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const isPath = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= 4096 && !/[\0\r\n]/.test(v);

/** Split and check an upload body. Throws a 400 that says what is wrong. */
export function parseImportBody(body: Buffer): ParsedImport {
  const newline = body.subarray(0, MAX_HEADER_BYTES + 1).indexOf(0x0a);
  if (newline < 0) throw bad('The upload has no header line.');
  let raw: unknown;
  try {
    raw = JSON.parse(body.subarray(0, newline).toString('utf8'));
  } catch {
    throw bad('The upload header is not JSON.');
  }
  const h = (raw ?? {}) as Partial<WorkbenchImportHeader>;
  if (h.agent !== 'claude') throw bad('Only Claude Code conversations can be imported.');
  if (!isClaudeSessionId(h.sessionId)) throw bad('sessionId must be a UUID.');
  if (typeof h.base !== 'string' || !/^[0-9a-f]{40}$/.test(h.base)) throw bad('base must be a 40-character commit SHA.');
  if (!isPath(h.cwd) || !isPath(h.root)) throw bad('cwd and root must be folder paths.');
  if (!isCount(h.sessionBytes) || !isCount(h.patchBytes) || h.sessionBytes === 0) {
    throw bad('sessionBytes and patchBytes must be byte counts.');
  }
  const rest = body.subarray(newline + 1);
  if (rest.length !== h.sessionBytes + h.patchBytes) throw bad('The upload is not the size its header says.');
  const session = rest.subarray(0, h.sessionBytes);
  const patch = rest.subarray(h.sessionBytes);
  if (!isGzip(session) || (patch.length > 0 && !isGzip(patch))) throw bad('The conversation and the patch must be gzip data.');
  return {
    header: {
      agent: 'claude',
      sessionId: h.sessionId,
      cwd: h.cwd,
      root: h.root,
      base: h.base,
      sessionBytes: h.sessionBytes,
      patchBytes: h.patchBytes,
    },
    session,
    patch,
  };
}

/** Where `claude --resume` finds the conversation in the box: the project folder of the repo directory. */
export function boxSessionPath(repoDir: string, sessionId: string): string {
  return `~/.claude/projects/${claudeProjectSlug(repoDir)}/${sessionId}.jsonl`;
}

/**
 * The box side, after the gz files are in `IMPORT_DIR`: the session branch at
 * the base commit, the patch applied on top as working-tree changes, and the
 * conversation where Claude Code looks for it. Each step exits with its own
 * code (`IMPORT_EXIT_CODES`); the import folder is removed either way.
 */
export function importScript(input: { base: string; branch: string; repoDir: string; sessionId: string }): string {
  const imp = shellPath(IMPORT_DIR);
  const target = boxSessionPath(input.repoDir, input.sessionId);
  const dir = shellPath(target.slice(0, target.lastIndexOf('/')));
  const file = shellPath(target);
  const tmp = shellPath(`${target}.talyn-tmp`);
  const base = shellQuote(input.base);
  return [
    'set -u',
    `imp=${imp}`,
    'trap \'rm -rf -- "$imp"\' EXIT',
    `if ! git cat-file -e ${shellQuote(`${input.base}^{commit}`)} 2>/dev/null; then`,
    `  git fetch --quiet origin ${base} || exit 10`,
    'fi',
    `git checkout --quiet -B ${shellQuote(input.branch)} ${base} || exit 11`,
    'if [ -f "$imp/changes.patch.gz" ]; then',
    '  gunzip -c "$imp/changes.patch.gz" > "$imp/changes.patch" || exit 12',
    '  if [ -s "$imp/changes.patch" ]; then',
    '    git apply --binary --whitespace=nowarn "$imp/changes.patch" || exit 12',
    '  fi',
    'fi',
    `mkdir -p ${dir} || exit 13`,
    `gunzip -c "$imp/session.jsonl.gz" > ${tmp} || exit 13`,
    `mv -f ${tmp} ${file} || exit 13`,
  ].join('\n');
}

export function importFailure(step: ImportStep, detail?: string): WorkbenchError {
  const tail = detail?.trim().split('\n').slice(-3).join(' ').slice(-300);
  return new WorkbenchError(`${STEP_COPY[step]}${tail ? ` ${tail}` : ''}`, 502, `import_failed_${step}`);
}

/** The chat an import goes into: the session must be fresh, so no chat has run a turn. */
export function importTargetChat(chats: ChatRow[]): ChatRow {
  if (chats.some((c) => c.turnCount > 0 || c.status === 'running')) {
    throw new WorkbenchError('Only a new session with no messages yet can continue a conversation.', 409, 'not_fresh');
  }
  const open = chats.find((c) => !c.closedAt);
  if (!open) throw new WorkbenchError('This session has no open chat.', 409, 'not_fresh');
  return open;
}

/**
 * Copy the conversation and the changes into the box, then store Talyn's copy
 * of the transcript. The chat is claimed first, so a message sent meanwhile
 * queues and runs after the import. A failure releases the chat and names the
 * step; the session stays usable.
 */
export async function importClaudeSession(wb: WorkbenchRow, target: ChatRow, input: ParsedImport): Promise<WorkbenchImportResult> {
  const { header } = input;
  let sessionText: string;
  try {
    sessionText = (await gunzipAsync(input.session, { maxOutputLength: MAX_IMPORTED_SESSION_BYTES })).toString('utf8');
  } catch (err) {
    if ((err as { code?: string })?.code === 'ERR_BUFFER_TOO_LARGE') {
      throw new WorkbenchError('The conversation is too large to import.', 413, 'import_too_large');
    }
    throw bad('The conversation is not valid gzip data.');
  }
  const converted = claudeSessionToEvents(sessionText);

  const claimed = await claimChatForImport(target.id, IMPORTING_MESSAGE);
  if (!claimed) throw new WorkbenchError('This chat has already started.', 409, 'not_fresh');
  emitWorkbenchChat(claimed.workspaceId, rowToChat(claimed));
  const release = async () => {
    const row = await updateChat(target.id, { status: 'idle', statusMessage: null });
    if (row) emitWorkbenchChat(row.workspaceId, rowToChat(row));
    await startQueuedIfIdle(target.id).catch(() => false);
  };

  const repoDir = repoDirFor(wb);
  let step: ImportStep = 'upload';
  try {
    await writeSandboxFiles(
      wb,
      [
        { path: `${IMPORT_DIR}/session.jsonl.gz`, base64: input.session.toString('base64') },
        ...(input.patch.length > 0 ? [{ path: `${IMPORT_DIR}/changes.patch.gz`, base64: input.patch.toString('base64') }] : []),
      ],
      { before: `rm -rf -- ${shellPath(IMPORT_DIR)}`, timeoutMs: 120_000 },
    );
    const run = await runCapture(
      wb,
      importScript({ base: header.base, branch: wb.branch, repoDir, sessionId: header.sessionId }),
      { quiet: true, timeoutMs: 300_000 },
    );
    if (run.exitCode !== 0) {
      step = IMPORT_EXIT_CODES[run.exitCode ?? -1] ?? 'session';
      throw importFailure(step, run.stderr);
    }

    step = 'transcript';
    let stored = 0;
    for (let i = 0; i < converted.events.length; i += EVENT_BATCH) {
      stored += (await appendEvents(target.id, converted.events.slice(i, i + EVENT_BATCH))).length;
    }
    stored += (
      await appendEvents(target.id, [
        {
          turn: converted.turns,
          event: { type: 'system', subtype: 'talyn_imported', text: `Imported from a Claude Code conversation in ${header.cwd}.` },
        },
      ])
    ).length;

    const firstPrompt = converted.events.find((e) => (e.event.talyn as { kind?: string } | undefined)?.kind === 'user_message');
    const firstText = ((firstPrompt?.event.message as { content?: Array<{ text?: string }> } | undefined)?.content?.[0]?.text ?? '').trim();
    const row = await updateChat(target.id, {
      status: 'idle',
      statusMessage: null,
      turnCount: converted.turns,
      agentSessionId: header.sessionId,
      importedFrom: { agent: 'claude', cwd: header.cwd, root: header.root, at: new Date().toISOString() },
      ...(firstText ? { title: firstText.split('\n')[0].slice(0, 60) } : {}),
    });
    if (!row) throw new WorkbenchError('Chat not found', 404, 'not_found');
    emitWorkbenchChat(row.workspaceId, rowToChat(row));
    recordWorkbenchEvent(wb, 'claude_import', `${converted.turns} turns, ${stored} events`);
    void startQueuedIfIdle(target.id).catch(() => false);
    void getWorkbench(wb.id).then((fresh) => (fresh ? refreshDiffStat(fresh) : null)).catch(() => null);
    return { chat: rowToChat(row), events: stored, turns: converted.turns };
  } catch (err) {
    recordWorkbenchEvent(wb, 'claude_import', `failed at ${step}`, false);
    await release().catch(() => undefined);
    if (err instanceof WorkbenchError) throw err;
    console.warn(`[workbench] import into ${wb.id} failed at ${step}:`, err);
    throw importFailure(step);
  }
}
