/**
 * Continuing a local Claude Code conversation in a sandbox session.
 *
 * The desktop reads `~/.claude/projects/<slug>/<sessionId>.jsonl` and the
 * user's uncommitted work, and uploads both to `POST /workbenches/:id/import`.
 * The box gets a copy of the file, so `claude --resume <sessionId>` continues
 * the same conversation there. Talyn's own transcript is built from the same
 * file by {@link claudeSessionToEvents}.
 *
 * # The upload body
 *
 * One `application/octet-stream` body:
 *
 *     <header JSON, one line>\n<gzipped session jsonl><gzipped patch>
 *
 * The header is a {@link WorkbenchImportHeader}; `sessionBytes` and
 * `patchBytes` are the lengths of the two gzip parts, so the parts need no
 * separator and the body has exactly one valid reading.
 */
import type { WorkbenchChat } from './workbench.js';

/**
 * The largest upload. Every Claude Code conversation on a heavy user's machine
 * (21k files, the largest 58 MB) gzips to about a third, so 20 MB; this leaves
 * room for a patch. Writing it into the box costs one exec per 288 KiB (4 env
 * chunks of 96 KiB base64, see `sandboxFiles.ts`), about 90 execs at this size.
 * A larger upload is refused, never cut.
 */
export const WORKBENCH_IMPORT_MAX_BYTES = 24 * 1024 * 1024;

/**
 * The longest text kept from one tool result or tool input string in Talyn's
 * copy of the transcript. The box gets the whole file; Talyn's copy is for
 * reading, a collapsed tool row shows a few lines, and a transcript page of
 * 2000 events must stay a few MB.
 */
export const IMPORTED_TOOL_TEXT_MAX_CHARS = 16_000;

export interface WorkbenchImportHeader {
  agent: 'claude';
  /** The conversation's id: its file name, and what `claude --resume` takes. */
  sessionId: string;
  /** The folder Claude Code ran in on the user's machine. */
  cwd: string;
  /** The git checkout's top folder. `cwd` is this folder or below it. */
  root: string;
  /** The commit the patch applies to. It exists on the remote. */
  base: string;
  sessionBytes: number;
  patchBytes: number;
}

/** Where an imported chat came from. Drives one hidden line in each turn's system prompt. */
export interface WorkbenchImportedFrom {
  agent: 'claude';
  cwd: string;
  root: string;
  /** ISO time of the import. */
  at: string;
}

export interface WorkbenchImportResult {
  chat: WorkbenchChat;
  /** Transcript events stored. */
  events: number;
  /** User prompts in the conversation; the chat's turn count. */
  turns: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isClaudeSessionId(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

/**
 * The folder name Claude Code keeps a directory's conversations under:
 * every character that is not a letter or a digit becomes `-`.
 * `/Users/x/dev/a.b` → `-Users-x-dev-a-b`.
 */
export function claudeProjectSlug(dir: string): string {
  return dir.replace(/[^A-Za-z0-9]/g, '-');
}

/** The hidden system-prompt line for a turn in an imported chat. */
export function importedPathsNote(from: Pick<WorkbenchImportedFrom, 'root'>, repoDir: string): string {
  return (
    `This conversation started on the user's machine in ${from.root} and continues in a cloud sandbox in ${repoDir}. ` +
    `Paths under ${from.root} are now under ${repoDir}.`
  );
}

/** Text Claude Code writes into a user line that the person did not type. */
const INJECTED_PREFIX =
  /^\s*<(command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat|bash-input|bash-stdout|bash-stderr|task-notification|system-reminder|user-prompt-submit-hook)>/;

export function isInjectedClaudePrompt(text: string): boolean {
  return INJECTED_PREFIX.test(text);
}

type Json = Record<string, unknown>;

function parseLine(line: string): Json | null {
  if (!line.trim()) return null;
  try {
    const v: unknown = JSON.parse(line);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null;
  } catch {
    return null;
  }
}

/**
 * The text a person typed, when this jsonl line is a real prompt; else null.
 * Meta, sidechain, compact-summary, command and tool-result lines are not prompts.
 */
export function claudePromptText(line: Json): string | null {
  if (line.type !== 'user' || line.isMeta || line.isSidechain || line.isCompactSummary) return null;
  const content = (line.message as { content?: unknown } | undefined)?.content;
  if (typeof content === 'string') {
    return content.trim() && !isInjectedClaudePrompt(content) ? content : null;
  }
  if (!Array.isArray(content)) return null;
  const texts: string[] = [];
  let images = 0;
  for (const block of content as Array<{ type?: unknown; text?: unknown }>) {
    if (block?.type === 'tool_result') return null;
    if (block?.type === 'text' && typeof block.text === 'string') texts.push(block.text);
    if (block?.type === 'image') images++;
  }
  const text = texts.join('\n');
  if (text && isInjectedClaudePrompt(text)) return null;
  if (!text.trim() && images === 0) return null;
  const note = images > 0 ? `(${images === 1 ? 'An image' : `${images} images`} not shown.)` : '';
  return [text, note].filter(Boolean).join('\n\n');
}

function trimText(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… (${text.length - max} more characters not imported)`;
}

/** Long strings in a tool input, trimmed at any depth. */
function trimStrings(value: unknown, max: number, depth = 0): unknown {
  if (typeof value === 'string') return trimText(value, max);
  if (depth > 8 || !value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => trimStrings(v, max, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, trimStrings(v, max, depth + 1)]));
}

function toolResultContent(content: unknown, max: number): unknown {
  if (typeof content === 'string') return trimText(content, max);
  if (!Array.isArray(content)) return '';
  const out: unknown[] = [];
  for (const part of content as Array<{ type?: unknown; text?: unknown }>) {
    if (part?.type === 'text' && typeof part.text === 'string') out.push({ type: 'text', text: trimText(part.text, max) });
    else if (part?.type === 'image') out.push({ type: 'text', text: '(Image not shown.)' });
  }
  return out;
}

function assistantBlocks(content: unknown, max: number): unknown[] {
  if (!Array.isArray(content)) return [];
  const out: unknown[] = [];
  for (const b of content as Array<Json>) {
    if (b?.type === 'text' && typeof b.text === 'string' && b.text) out.push({ type: 'text', text: b.text });
    else if (b?.type === 'thinking' && typeof b.thinking === 'string' && b.thinking.trim()) {
      out.push({ type: 'thinking', thinking: trimText(b.thinking, max) });
    } else if (b?.type === 'tool_use') {
      out.push({ type: 'tool_use', id: b.id, name: b.name, input: trimStrings(b.input ?? {}, max) });
    }
  }
  return out;
}

/**
 * The lines of the conversation's current branch. A rewind or an edited
 * prompt leaves the abandoned lines in the file; `--resume` follows the
 * `parentUuid` chain back from the last message, so this does too. A chain
 * that breaks (a parent the file does not hold) falls back to every line.
 */
function currentBranch(lines: Json[]): Json[] {
  const isMessage = (l: Json) => (l.type === 'user' || l.type === 'assistant') && !l.isSidechain;
  const byUuid = new Map<string, Json>();
  for (const l of lines) if (typeof l.uuid === 'string') byUuid.set(l.uuid, l);
  let leaf: Json | undefined;
  for (let i = lines.length - 1; i >= 0 && !leaf; i--) if (isMessage(lines[i])) leaf = lines[i];
  if (!leaf || typeof leaf.uuid !== 'string' || lines.some((l) => isMessage(l) && typeof l.uuid !== 'string')) return lines;
  const keep = new Set<string>();
  let cur: Json | undefined = leaf;
  while (cur && typeof cur.uuid === 'string' && !keep.has(cur.uuid)) {
    keep.add(cur.uuid);
    const parent: unknown = cur.parentUuid ?? cur.logicalParentUuid;
    if (typeof parent !== 'string') return lines.filter((l) => !isMessage(l) || keep.has(l.uuid as string));
    cur = byUuid.get(parent);
  }
  return cur ? lines.filter((l) => !isMessage(l) || keep.has(l.uuid as string)) : lines;
}

export interface ClaudeSessionEvents {
  events: Array<{ turn: number; event: Record<string, unknown> }>;
  /** Real user prompts; each one starts a turn. */
  turns: number;
}

/**
 * A Claude Code conversation file as Talyn transcript events, in the shapes a
 * live sandbox turn stores: each prompt as a `user_message` event, then the
 * assistant's text, thinking and tool calls, and the tool results. Turn N
 * starts at the Nth prompt.
 *
 * Dropped: bookkeeping lines (summaries, file-history snapshots, attachments,
 * modes, titles, costs), meta and sidechain (subagent) lines, slash commands
 * and their output, system lines, images, and thinking signatures. Long tool
 * text is trimmed to `maxToolTextChars`.
 */
export function claudeSessionToEvents(
  input: string | readonly string[],
  opts: { maxToolTextChars?: number } = {},
): ClaudeSessionEvents {
  const max = opts.maxToolTextChars ?? IMPORTED_TOOL_TEXT_MAX_CHARS;
  const raw = typeof input === 'string' ? input.split('\n') : input;
  const parsed: Json[] = [];
  for (const line of raw) {
    const obj = parseLine(line);
    if (obj) parsed.push(obj);
  }

  const events: ClaudeSessionEvents['events'] = [];
  let turn = 0;
  for (const line of currentBranch(parsed)) {
    if (line.isSidechain || line.isMeta) continue;
    const sessionId = typeof line.sessionId === 'string' ? { session_id: line.sessionId } : {};
    if (line.type === 'user') {
      const prompt = claudePromptText(line);
      if (prompt !== null) {
        turn++;
        events.push({
          turn,
          event: {
            type: 'user',
            message: { role: 'user', content: [{ type: 'text', text: prompt }] },
            talyn: {
              kind: 'user_message',
              messageId: typeof line.uuid === 'string' ? line.uuid : `imported-${turn}`,
              imported: true,
            },
          },
        });
        continue;
      }
      const content = (line.message as { content?: unknown } | undefined)?.content;
      if (!Array.isArray(content)) continue;
      const results = (content as Json[])
        .filter((b) => b?.type === 'tool_result')
        .map((b) => ({
          type: 'tool_result',
          tool_use_id: b.tool_use_id,
          content: toolResultContent(b.content, max),
          is_error: b.is_error === true,
        }));
      if (results.length > 0) {
        events.push({ turn: Math.max(turn, 1), event: { type: 'user', ...sessionId, message: { role: 'user', content: results } } });
      }
      continue;
    }
    if (line.type === 'assistant') {
      const message = (line.message ?? {}) as Json;
      const content = assistantBlocks(message.content, max);
      if (content.length === 0) continue;
      events.push({
        turn: Math.max(turn, 1),
        event: {
          type: 'assistant',
          ...sessionId,
          message: {
            ...(typeof message.id === 'string' ? { id: message.id } : {}),
            role: 'assistant',
            ...(typeof message.model === 'string' ? { model: message.model } : {}),
            content,
            ...(message.usage && typeof message.usage === 'object' ? { usage: message.usage } : {}),
          },
        },
      });
    }
  }
  return { events, turns: turn };
}
