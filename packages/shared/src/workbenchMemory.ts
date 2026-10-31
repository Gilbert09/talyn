/**
 * Workspace memory: short notes that agents and people save, so a later
 * session knows what an earlier one learned. A session gets an INDEX of the
 * entries in its scope (name, type, scope, description) and reads a body with
 * `talyn_memory_read` only when it needs it.
 *
 * Stored in `workspace_memories` (migration 0096). A forget is a soft delete,
 * so a person can restore the entry.
 */

/** Where an entry applies: every session of the workspace, one repository, or one thread. */
export type MemoryScope = 'workspace' | 'repository' | 'thread';
export const MEMORY_SCOPES: readonly MemoryScope[] = ['workspace', 'repository', 'thread'];

/**
 * What kind of note it is. The same four kinds Claude Code uses for its own
 * memory, so an agent knows them already.
 */
export type MemoryType = 'user' | 'feedback' | 'project' | 'reference';
export const MEMORY_TYPES: readonly MemoryType[] = ['user', 'feedback', 'project', 'reference'];

/** Who wrote the entry. */
export type MemorySource =
  | { kind: 'user' }
  | { kind: 'session'; workbenchId: string; chatId?: string; turn?: number }
  | { kind: 'auto' };

/** An entry without its body, as a list returns it. */
export interface MemoryEntrySummary {
  id: string;
  workspaceId: string;
  scope: MemoryScope;
  repositoryId: string | null;
  threadId: string | null;
  type: MemoryType;
  name: string;
  description: string;
  bytes: number;
  source: MemorySource;
  createdAt: string;
  updatedAt: string;
  forgottenAt: string | null;
}

export interface MemoryEntry extends MemoryEntrySummary {
  body: string;
}

/** `POST /workbenches/memory`: create, or update the live entry with the same scope target and name. */
export interface PutMemoryInput {
  workspaceId: string;
  scope: MemoryScope;
  repositoryId?: string | null;
  threadId?: string | null;
  type: MemoryType;
  name: string;
  description: string;
  body: string;
  /** Only `{ kind: 'session', ... }` for a session of the same workspace. Default `{ kind: 'user' }`. */
  source?: MemorySource;
}

/** `PUT /workbenches/memory/:id`. The scope does not change; send the fields to change. */
export interface UpdateMemoryInput {
  type?: MemoryType;
  name?: string;
  description?: string;
  body?: string;
}

export interface PutMemoryResult {
  entry: MemoryEntry;
  outcome: 'created' | 'updated';
}

/** `GET /workbenches/memory` filters. With no `scope`, a repository or thread id means "visible from there". */
export interface ListMemoryQuery {
  workspaceId: string;
  scope?: MemoryScope;
  repositoryId?: string;
  threadId?: string;
  /** Case-insensitive match on name, description and body. */
  q?: string;
  includeForgotten?: boolean;
  includeBody?: boolean;
}

// A name is one short line in the index; 64 characters keeps it a label, not a sentence.
export const MAX_MEMORY_NAME_CHARS = 64;
// The description is what the agent reads in every turn's index, so it stays one short sentence.
export const MAX_MEMORY_DESCRIPTION_CHARS = 200;
// A body is read on demand. 8 KiB (about 2,000 tokens) is a full note; more is a document, not a memory.
export const MAX_MEMORY_BODY_BYTES = 8 * 1024;
// The index cap holds about 200 typical entries. 500 leaves room for repository and thread
// entries that one session does not see, and still bounds the rows of one workspace.
export const MAX_LIVE_MEMORIES_PER_WORKSPACE = 500;
// Same cap as the recovery recap (agentRecap.ts): about 6,000 tokens, which leaves room for the prompt and tools.
export const MAX_MEMORY_INDEX_BYTES = 24 * 1024;

const utf8Bytes = (value: string): number => new TextEncoder().encode(value).length;

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export type MemoryValidation<T> = { ok: true; value: T } | { ok: false; error: string; code: string; status: number };

export function memoryBodyTooLargeMessage(bytes: number): string {
  const kb = Math.ceil(bytes / 1024);
  return `A memory body can be at most 8 KB; this one is ${kb} KB. Keep the note short, or split it into entries.`;
}

export function memoryLimitMessage(): string {
  return `This workspace has ${MAX_LIVE_MEMORIES_PER_WORKSPACE} memory entries, which is the limit. Forget some entries first.`;
}

function bad(error: string): { ok: false; error: string; code: string; status: number } {
  return { ok: false, error, code: 'bad_memory', status: 400 };
}

type CheckError = { error: string; tooLarge?: boolean };

function checkName(name: unknown): string | CheckError {
  if (typeof name !== 'string' || !name.trim()) return { error: 'name is required' };
  const value = name.trim();
  if (value.length > MAX_MEMORY_NAME_CHARS) {
    return { error: `name can be at most ${MAX_MEMORY_NAME_CHARS} characters; this one is ${value.length}.` };
  }
  if (CONTROL_CHARS.test(value)) return { error: 'name must be one line of text' };
  return value;
}

function checkDescription(description: unknown): string | CheckError {
  if (typeof description !== 'string' || !description.trim()) return { error: 'description is required' };
  const value = description.trim();
  if (value.length > MAX_MEMORY_DESCRIPTION_CHARS) {
    return {
      error: `description can be at most ${MAX_MEMORY_DESCRIPTION_CHARS} characters; this one is ${value.length}.`,
    };
  }
  if (CONTROL_CHARS.test(value)) return { error: 'description must be one line of text' };
  return value;
}

function checkType(type: unknown): MemoryType | CheckError {
  if (!MEMORY_TYPES.includes(type as MemoryType)) {
    return { error: `type must be one of: ${MEMORY_TYPES.join(', ')}` };
  }
  return type as MemoryType;
}

type BodyCheck = { body: string; bytes: number } | CheckError;

function checkBody(body: unknown): BodyCheck {
  if (typeof body !== 'string' || !body.trim()) return { error: 'body is required' };
  const bytes = utf8Bytes(body);
  if (bytes > MAX_MEMORY_BODY_BYTES) return { error: memoryBodyTooLargeMessage(bytes), tooLarge: true };
  return { body, bytes };
}

const isError = (v: unknown): v is CheckError =>
  typeof v === 'object' && v !== null && 'error' in v;

function bodyError(check: CheckError) {
  return check.tooLarge
    ? { ok: false as const, error: check.error, code: 'memory_too_large', status: 413 }
    : bad(check.error);
}

export interface ValidMemoryInput {
  scope: MemoryScope;
  repositoryId: string | null;
  threadId: string | null;
  type: MemoryType;
  name: string;
  description: string;
  body: string;
  bytes: number;
}

/** Check a create. The caller still checks that the repository or thread is in the workspace. */
export function validateMemoryInput(input: unknown): MemoryValidation<ValidMemoryInput> {
  if (!input || typeof input !== 'object') return bad('A memory entry is required');
  const raw = input as Partial<PutMemoryInput>;
  if (!MEMORY_SCOPES.includes(raw.scope as MemoryScope)) {
    return bad(`scope must be one of: ${MEMORY_SCOPES.join(', ')}`);
  }
  const scope = raw.scope as MemoryScope;
  const repositoryId = typeof raw.repositoryId === 'string' && raw.repositoryId ? raw.repositoryId : null;
  const threadId = typeof raw.threadId === 'string' && raw.threadId ? raw.threadId : null;
  if (scope === 'workspace' && (repositoryId || threadId)) {
    return bad('A workspace entry has no repositoryId or threadId');
  }
  if (scope === 'repository' && (!repositoryId || threadId)) {
    return bad('A repository entry needs a repositoryId and no threadId');
  }
  if (scope === 'thread' && !threadId) return bad('A thread entry needs a threadId');

  const type = checkType(raw.type);
  if (isError(type)) return bad(type.error);
  const name = checkName(raw.name);
  if (isError(name)) return bad(name.error);
  const description = checkDescription(raw.description);
  if (isError(description)) return bad(description.error);
  const body = checkBody(raw.body);
  if (isError(body)) return bodyError(body);
  return { ok: true, value: { scope, repositoryId, threadId, type, name, description, ...body } };
}

/** Check an update. Only the fields that are present; at least one. */
export function validateMemoryUpdate(
  input: unknown,
): MemoryValidation<{ type?: MemoryType; name?: string; description?: string; body?: string; bytes?: number }> {
  if (!input || typeof input !== 'object') return bad('Send the fields to change');
  const raw = input as UpdateMemoryInput;
  const out: { type?: MemoryType; name?: string; description?: string; body?: string; bytes?: number } = {};
  if (raw.type !== undefined) {
    const type = checkType(raw.type);
    if (isError(type)) return bad(type.error);
    out.type = type;
  }
  if (raw.name !== undefined) {
    const name = checkName(raw.name);
    if (isError(name)) return bad(name.error);
    out.name = name;
  }
  if (raw.description !== undefined) {
    const description = checkDescription(raw.description);
    if (isError(description)) return bad(description.error);
    out.description = description;
  }
  if (raw.body !== undefined) {
    const body = checkBody(raw.body);
    if (isError(body)) return bodyError(body);
    out.body = body.body;
    out.bytes = body.bytes;
  }
  if (Object.keys(out).length === 0) return bad('Send at least one of: type, name, description, body');
  return { ok: true, value: out };
}

/** The fields the index shows. */
export type MemoryIndexEntry = Pick<MemoryEntrySummary, 'name' | 'type' | 'scope' | 'description'>;

const INDEX_HEADER = [
  '# Talyn memory',
  '',
  'Notes that earlier sessions and people in this workspace saved. This is an index only.',
  'Read an entry with `talyn_memory_read` before you rely on it. Save new facts with `talyn_memory_write`.',
  '',
].join('\n');

/** For a task or a review run: it has no memory tools, so it reads the index and cannot change it. */
const READ_ONLY_INDEX_HEADER = [
  '# Talyn memory',
  '',
  'Memory from earlier sessions. You cannot change it in this run.',
  'This is an index of notes that people and earlier sessions in this workspace saved. ' +
    'If an entry does not agree with the repository, the repository is correct.',
  '',
].join('\n');

function indexLine(entry: MemoryIndexEntry): string {
  return `- ${entry.name} (${entry.type}, ${entry.scope}): ${entry.description}\n`;
}

function omittedLine(count: number, readOnly: boolean): string {
  const shown = `\n${count} more ${count === 1 ? 'entry is' : 'entries are'} not shown.`;
  return readOnly ? `${shown}\n` : `${shown} Use \`talyn_memory_search\` to find them.\n`;
}

/**
 * The Markdown index a session gets. Name, type, scope and description only,
 * never a body. Cut at `MAX_MEMORY_INDEX_BYTES`, with a last line that says
 * how many entries were left out. Empty when there are no entries.
 * `readOnly` is for a run without the memory tools: it names no tool.
 */
export function renderMemoryIndex(
  entries: readonly MemoryIndexEntry[],
  maxBytes: number = MAX_MEMORY_INDEX_BYTES,
  opts: { readOnly?: boolean } = {},
): string {
  if (entries.length === 0) return '';
  const readOnly = opts.readOnly === true;
  const omitted = (count: number) => omittedLine(count, readOnly);
  const lines = entries.map(indexLine);
  const sizes = lines.map(utf8Bytes);
  const total = sizes.reduce((sum, size) => sum + size, 0);
  let out = readOnly ? READ_ONLY_INDEX_HEADER : INDEX_HEADER;
  let used = utf8Bytes(out);
  if (used + total <= maxBytes) return out + lines.join('');
  for (let i = 0; i < lines.length; i++) {
    // Not every entry fits, so keep room for the line that says how many were left out.
    if (used + sizes[i] + utf8Bytes(omitted(lines.length - i - 1)) > maxBytes) {
      return out + omitted(lines.length - i);
    }
    out += lines[i];
    used += sizes[i];
  }
  return out;
}

/**
 * The transcript event a session's memory write or forget appends to its chat
 * (`type: 'talyn_memory'`). The UI draws it as a card.
 */
export interface MemoryChangeEvent {
  action: 'created' | 'updated' | 'forgotten';
  memoryId: string;
  name: string;
  memoryType: MemoryType;
  scope: MemoryScope;
}

const MEMORY_ACTIONS: readonly MemoryChangeEvent['action'][] = ['created', 'updated', 'forgotten'];

/** The change a `talyn_memory` event carries, or null when the event is malformed. */
export function parseMemoryChangeEvent(event: Record<string, unknown>): MemoryChangeEvent | null {
  const { action, memoryId, name, memoryType, scope } = event;
  if (!MEMORY_ACTIONS.includes(action as MemoryChangeEvent['action'])) return null;
  if (typeof memoryId !== 'string' || typeof name !== 'string') return null;
  if (!MEMORY_TYPES.includes(memoryType as MemoryType) || !MEMORY_SCOPES.includes(scope as MemoryScope)) return null;
  return {
    action: action as MemoryChangeEvent['action'],
    memoryId,
    name,
    memoryType: memoryType as MemoryType,
    scope: scope as MemoryScope,
  };
}

const ACTION_VERB: Record<MemoryChangeEvent['action'], string> = {
  created: 'Saved',
  updated: 'Updated',
  forgotten: 'Forgot',
};

/** One line for the transcript, e.g. `Saved repository memory "build command"`. */
export function memoryChangeText(change: MemoryChangeEvent): string {
  return `${ACTION_VERB[change.action]} ${change.scope} memory "${change.name}"`;
}
