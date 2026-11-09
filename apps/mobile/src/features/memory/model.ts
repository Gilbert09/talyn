import {
  MAX_LIVE_MEMORIES_PER_WORKSPACE, MAX_MEMORY_BODY_BYTES, MAX_MEMORY_DESCRIPTION_CHARS, MAX_MEMORY_NAME_CHARS, validateMemoryInput,
  validateMemoryUpdate,
  type ListMemoryQuery, type MemoryEntry, type MemoryEntrySummary, type MemoryReviewRun, type MemoryScope, type MemorySource,
  type MemoryType, type PutMemoryInput, type UpdateMemoryInput,
} from '@talyn/shared';

export const MEMORY_TITLE_DESCRIPTION = 'Notes that sessions save as they learn, and notes you add. Every session, task and review reads them.';
export const MEMORY_INTRO = 'Notes that sessions read before they work. A session sees the workspace notes and the notes of its repository.';
export const MEMORY_EMPTY = 'Sessions save notes here as they learn about your work. You can add your own too.';
export const SESSION_MEMORY_DETAIL = 'Sessions read these notes and save new ones. When it is off, sessions do not use memory. You can still edit the notes here.';
export const MEMORY_REVIEW_DETAIL = 'Talyn starts a thread that merges notes that overlap and settles notes that disagree. Each review uses your agent subscription. Talyn skips a review when no note changed.';
export const SEARCH_DELAY_MS = 250;

export const MEMORY_TYPE_LABEL: Record<MemoryType, string> = {
  user: 'User',
  feedback: 'Feedback',
  project: 'Project',
  reference: 'Reference',
};

/** "3d ago": coarse on purpose, like web. */
export function ago(iso: string, now = Date.now()): string {
  const min = Math.floor(Math.max(0, now - new Date(iso).getTime()) / 60_000);
  if (!Number.isFinite(min)) return '';
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  // 360 to 364 days is 12 months but under a year; web reads "0y ago" there.
  return months < 12 ? `${months}mo ago` : `${Math.max(1, Math.floor(days / 365))}y ago`;
}

type RepoRef = { id: string; fullName: string };

/** "Workspace", the repository's name, or "Thread". */
export function memoryScopeLabel(entry: { scope: MemoryScope; repositoryId?: string | null }, repositories: readonly RepoRef[]): string {
  if (entry.scope === 'workspace') return 'Workspace';
  if (entry.scope === 'thread') return 'Thread';
  return repositories.find((repo) => repo.id === entry.repositoryId)?.fullName ?? 'Repository';
}

/** Who wrote the entry. A session carries its id, so the app can open it. */
export function memorySourceLabel(source: MemorySource): { text: string; workbenchId?: string } {
  if (source.kind === 'session') return { text: 'Saved by a session', ...(source.workbenchId ? { workbenchId: source.workbenchId } : {}) };
  if (source.kind === 'auto') return { text: 'Saved automatically' };
  return { text: 'Added by you' };
}

export interface MemoryGroup { key: string; label: string; mono: boolean; entries: MemoryEntrySummary[] }

/** The workspace group, then each repository by name, then threads. Empty groups are left out. */
export function groupMemories(entries: readonly MemoryEntrySummary[] | null | undefined, repositories: readonly RepoRef[]): MemoryGroup[] {
  const workspace: MemoryGroup = { key: 'workspace', label: 'Workspace', mono: false, entries: [] };
  const byRepo = new Map<string, MemoryGroup>();
  const threads: MemoryGroup = { key: 'thread', label: 'Threads', mono: false, entries: [] };
  for (const entry of entries ?? []) {
    if (entry.scope === 'workspace') workspace.entries.push(entry);
    else if (entry.scope === 'thread') threads.entries.push(entry);
    else {
      const key = entry.repositoryId ?? '';
      let group = byRepo.get(key);
      if (!group) {
        group = { key: `repo:${key}`, label: memoryScopeLabel(entry, repositories), mono: true, entries: [] };
        byRepo.set(key, group);
      }
      group.entries.push(entry);
    }
  }
  const repoGroups = [...byRepo.values()].sort((a, b) => a.label.localeCompare(b.label));
  return [workspace, ...repoGroups, threads].filter((group) => group.entries.length > 0);
}

export function liveCountOf(entries: readonly MemoryEntrySummary[]): number {
  return entries.filter((entry) => !entry.forgottenAt).length;
}

/** "12 of 500", and whether the workspace is at the limit. */
export function memoryCount(liveCount: number | null): { label: string; full: boolean } | null {
  if (liveCount === null) return null;
  return { label: `${liveCount} of ${MAX_LIVE_MEMORIES_PER_WORKSPACE}`, full: liveCount >= MAX_LIVE_MEMORIES_PER_WORKSPACE };
}

export function memoryListQuery(workspaceId: string, search: string, showForgotten: boolean): ListMemoryQuery {
  return { workspaceId, ...(search ? { q: search } : {}), ...(showForgotten ? { includeForgotten: true } : {}) };
}

export function emptyMemoryMessage(search: string): string {
  return search ? `No notes match "${search}".` : MEMORY_EMPTY;
}

/** The line under the review setting, or null with no review yet. */
export function reviewLine(run: MemoryReviewRun | undefined, now = Date.now()): { text: string; workbenchId?: string } | null {
  if (!run) return null;
  if (run.status === 'failed') return { text: `Last review failed: ${run.error ?? 'unknown error'}` };
  if (run.status === 'starting') return { text: 'A review is starting' };
  return { text: `Last review: ${ago(run.createdAt, now)}`, ...(run.workbenchId ? { workbenchId: run.workbenchId } : {}) };
}

// ---------------------------------------------------------------------------
// The editor
// ---------------------------------------------------------------------------

export const WORKSPACE_TARGET = 'workspace';
export const WORKSPACE_TARGET_LABEL = 'Every session in this workspace';

export interface MemoryDraft { target: string; type: MemoryType; name: string; description: string; body: string }

export function memoryDraftOf(entry?: MemoryEntry | null): MemoryDraft {
  return { target: entry?.scope === 'repository' && entry.repositoryId ? entry.repositoryId : WORKSPACE_TARGET,
    type: entry?.type ?? 'project', name: entry?.name ?? '', description: entry?.description ?? '', body: entry?.body ?? '' };
}

export function targetLabel(target: string, repositories: readonly RepoRef[]): string {
  return target === WORKSPACE_TARGET ? WORKSPACE_TARGET_LABEL : repositories.find((repo) => repo.id === target)?.fullName ?? 'Repository';
}

const byteLength = (text: string) => new TextEncoder().encode(text).length;
const kb = (bytes: number) => `${(bytes / 1024).toFixed(1)} KB`;

export interface MemoryFieldCounts {
  name: { label: string; over: boolean };
  description: { label: string; over: boolean };
  body: { label: string; over: boolean };
}

/** The counters beside each field, like web. Names and descriptions count trimmed characters; the note counts bytes. */
export function memoryFieldCounts(draft: Pick<MemoryDraft, 'name' | 'description' | 'body'>): MemoryFieldCounts {
  const name = draft.name.trim().length;
  const description = draft.description.trim().length;
  const bytes = byteLength(draft.body);
  return {
    name: { label: `${name} / ${MAX_MEMORY_NAME_CHARS}`, over: name > MAX_MEMORY_NAME_CHARS },
    description: { label: `${description} / ${MAX_MEMORY_DESCRIPTION_CHARS}`, over: description > MAX_MEMORY_DESCRIPTION_CHARS },
    body: { label: `${kb(bytes)} of ${kb(MAX_MEMORY_BODY_BYTES)}`, over: bytes > MAX_MEMORY_BODY_BYTES },
  };
}

/** Only the fields that changed. An empty patch means nothing to save. */
export function memoryUpdatePatch(original: MemoryEntry, draft: MemoryDraft): UpdateMemoryInput {
  const patch: UpdateMemoryInput = {};
  if (draft.name !== original.name) patch.name = draft.name;
  if (draft.type !== original.type) patch.type = draft.type;
  if (draft.description !== original.description) patch.description = draft.description;
  if (draft.body !== original.body) patch.body = draft.body;
  return patch;
}

export function memoryCreateInput(workspaceId: string, draft: MemoryDraft): PutMemoryInput {
  const workspace = draft.target === WORKSPACE_TARGET;
  return { workspaceId, scope: workspace ? 'workspace' : 'repository', ...(workspace ? {} : { repositoryId: draft.target }),
    type: draft.type, name: draft.name, description: draft.description, body: draft.body };
}

export type MemorySaveRequest =
  | { kind: 'none' }
  | { kind: 'invalid'; error: string }
  | { kind: 'create'; input: PutMemoryInput }
  | { kind: 'update'; patch: UpdateMemoryInput };

/** What Save does, after the same shared checks the server runs. */
export function memorySaveRequest(workspaceId: string, original: MemoryEntry | null, draft: MemoryDraft): MemorySaveRequest {
  if (original) {
    const patch = memoryUpdatePatch(original, draft);
    if (Object.keys(patch).length === 0) return { kind: 'none' };
    const checked = validateMemoryUpdate(patch);
    return checked.ok ? { kind: 'update', patch } : { kind: 'invalid', error: checked.error };
  }
  const input = memoryCreateInput(workspaceId, draft);
  const checked = validateMemoryInput(input);
  return checked.ok ? { kind: 'create', input } : { kind: 'invalid', error: checked.error };
}

export function memoryDirty(original: MemoryEntry | null, draft: MemoryDraft): boolean {
  if (original) return Object.keys(memoryUpdatePatch(original, draft)).length > 0;
  return Boolean(draft.name.trim() || draft.description.trim() || draft.body.trim());
}

export function sameNameMessage(name: string): string {
  return `Updated the entry "${name}", which had the same name`;
}

/** Replace one entry of a list in place, or add it at the end. */
export function upsertSummary(list: readonly MemoryEntrySummary[], entry: MemoryEntrySummary | MemoryEntry): MemoryEntrySummary[] {
  const { body: _body, ...summary } = entry as MemoryEntry;
  return list.some((item) => item.id === summary.id) ? list.map((item) => item.id === summary.id ? summary : item) : [...list, summary];
}
