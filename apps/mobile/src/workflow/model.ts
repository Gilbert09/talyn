import { buildBlocks, type Workbench, type WorkbenchChat, type WorkbenchEvent } from '@talyn/shared';
import type { PRRow, WorkbenchEventsPage } from '@talyn/client/native';

export const SCHEMA_VERSION = 1;
export const EVENT_LIMIT = 1200;
export const EVENT_BYTES = 2_000_000;
export const PAGE_SIZE = 200;
export const ROW_TEXT_LIMIT = 16000;
export interface Scope { environment: string; user: string; workspace: string }
export type Entity = 'sessions' | 'threads' | 'attention' | 'workbench' | 'children' | 'readiness' | 'pr' | 'timeline' | 'transcript';
export const cacheKey = (scope: Scope, entity: Entity, id = '') =>
  JSON.stringify(['mobile', SCHEMA_VERSION, scope.environment, scope.user, scope.workspace, entity, id]);
export const sameScope = (a: Scope | null, b: Scope | null) => a === b || Boolean(a && b &&
  a.environment === b.environment && a.user === b.user && a.workspace === b.workspace);
export type LoadState = 'idle' | 'loading' | 'ready' | 'error' | 'offline' | 'unauthorized' | 'deleted';
/**
 * `stale` means a background refetch is owed. Screens keep showing `data` while it runs and never block on it.
 * `version` grows with each successful fetch, so a screen can wait for one fetch that started after it opened.
 */
export interface Resource<T> { status: LoadState; data?: T; stale: boolean; refreshing: boolean; updatedAt?: number; version?: number }
export const EMPTY_RESOURCE: Resource<never> = Object.freeze({ status: 'idle', stale: true, refreshing: false });
export function failureState(error: unknown): LoadState {
  const status = (error as { status?: number } | null)?.status;
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 404 || status === 410) return 'deleted';
  return 'error';
}
export type DeliveryStatus = 'idle' | 'sending' | 'queued' | 'sent' | 'failed' | 'unknown';
export interface Delivery { status: DeliveryStatus; checked: boolean; attempt: number }
export const EMPTY_DELIVERY: Delivery = Object.freeze({ status: 'idle', checked: false, attempt: 0 });
export type DeliveryAction = { type: 'start' } | { type: 'ack'; queued: boolean } | { type: 'failed' } |
  { type: 'unknown' } | { type: 'reconciled' };
export function deliveryReducer(state: Delivery, action: DeliveryAction): Delivery {
  switch (action.type) {
    case 'start': return { status: 'sending', checked: false, attempt: state.attempt + 1 };
    case 'ack': return { ...state, status: action.queued ? 'queued' : 'sent', checked: true };
    case 'failed': return { ...state, status: 'failed', checked: true };
    case 'unknown': return { ...state, status: 'unknown', checked: false };
    case 'reconciled': return { ...state, checked: true };
  }
}
export function canStartSend(delivery: Delivery, manualRetry: boolean) {
  if (delivery.status === 'sending') return false;
  if (delivery.status === 'failed') return manualRetry;
  if (delivery.status === 'unknown') return manualRetry && delivery.checked;
  return true;
}
export const deliveryLabel = (state: DeliveryStatus) => ({ idle: '', sending: 'Sending', queued: 'Queued on server',
  sent: 'Sent', failed: 'Failed', unknown: 'Delivery unknown' })[state];
export function explicitSendFailure(error: unknown) {
  const status = (error as { status?: number } | null)?.status;
  return status !== undefined && status >= 400 && status < 500 && status !== 408;
}

export interface Transcript {
  events: WorkbenchEvent[];
  cursor: number;
  oldest: number | null;
  hasOlder: boolean;
  gap: boolean;
  trimmed: boolean;
}
export const emptyTranscript = (): Transcript => ({ events: [], cursor: 0, oldest: null, hasOlder: false, gap: false, trimmed: false });
export function mergeEvents(chatId: string, current: Transcript, incoming: WorkbenchEvent[], mode: 'live' | 'rest' | 'older' = 'live', page?: WorkbenchEventsPage): Transcript {
  const bySeq = new Map(current.events.map((item) => [item.seq, item]));
  for (const item of incoming) {
    if (item.chatId === chatId && Number.isSafeInteger(item.seq) && item.seq > 0) bySeq.set(item.seq, item);
  }
  let events = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  let cursor = current.cursor;
  // The first backward page establishes an intentional history boundary.
  if (!current.events.length && mode === 'rest' && page?.oldestSeq != null) cursor = page.oldestSeq - 1;
  for (const item of events) if (item.seq === cursor + 1) cursor = item.seq;
  const gap = events.some((item) => item.seq > cursor);
  let bytes = 0;
  const retained: WorkbenchEvent[] = [];
  const ordered = mode === 'older' ? events : [...events].reverse();
  for (const item of ordered) {
    const size = JSON.stringify(item).length * 2;
    if (retained.length >= EVENT_LIMIT || bytes + size > EVENT_BYTES) break;
    retained.push(item); bytes += size;
  }
  const trimmed = retained.length < events.length;
  events = mode === 'older' ? retained : retained.reverse();
  return { events, cursor, oldest: events[0]?.seq ?? null, gap,
    hasOlder: mode === 'older' || !current.events.length ? page?.hasOlder === true || trimmed : current.hasOlder || trimmed,
    trimmed: current.trimmed || trimmed };
}

const labels: Record<string, string> = {
  ready: 'Ready', provisioning: 'Starting', moving: 'Moving', error: 'Error', archived: 'Archived', archiveError: 'Archive failed',
  idle: 'Idle', running: 'Running', awaiting_input: 'Response needed',
  open: 'Open', closed: 'Closed', merged: 'Merged', approved: 'Approved', APPROVED: 'Approved',
  REVIEW_REQUIRED: 'Review required', CHANGES_REQUESTED: 'Changes requested',
  CLEAN: 'Clean', BLOCKED: 'Blocked', BEHIND: 'Behind', DIRTY: 'Conflicts', DRAFT: 'Draft', HAS_HOOKS: 'Hooks pending', UNSTABLE: 'Unstable',
  MERGEABLE: 'Mergeable', CONFLICTING: 'Conflicts', UNKNOWN: 'Unknown',
  failing_optional: 'Optional checks failing', failing_required: 'Required checks failing', needs_human: 'Human action needed',
  testing: 'Testing', passed: 'Passed', pending_failure: 'Failure pending', failed: 'Failed', ejected: 'Ejected', cancelled: 'Cancelled', rejected: 'Rejected', not_submitted: 'Not submitted', not_ready: 'Not ready',
  allowed: 'Allowed', denied: 'Denied', auto_allowed: 'Allowed automatically',
  passing: 'Passing', failing: 'Failing', pending: 'Pending', none: 'No checks',
  queued: 'Queued', awaiting_ci: 'Waiting for CI', awaiting_review: 'Waiting for review',
  automerge_armed: 'Auto-merge armed', awaiting_external: 'Waiting for external queue', awaiting_stack: 'Waiting for stack',
  fixing: 'Fixing', merging: 'Merging', blocked: 'Blocked', blocked_manual: 'Human action needed', removed: 'Removed',
};
export const statusLabel = (value: unknown) => typeof value === 'string' ? labels[value] ?? 'Unknown' : 'Unknown';
const domainLabel = (states: readonly string[], value: unknown) => typeof value === 'string' && states.includes(value) ? statusLabel(value) : 'Unknown';
export const ciLabel = (value: unknown) => domainLabel(['none', 'passing', 'running', 'failing_optional', 'failing_required', 'needs_human'], value);
export const queueLabel = (value: unknown) => domainLabel(['queued', 'awaiting_ci', 'awaiting_review', 'automerge_armed', 'awaiting_external', 'awaiting_stack', 'fixing', 'merging', 'blocked', 'blocked_manual', 'merged', 'removed'], value);
export const externalLabel = (value: unknown) => domainLabel(['not_submitted', 'not_ready', 'queued', 'testing', 'passed', 'pending_failure', 'failed', 'ejected', 'cancelled', 'rejected', 'merged'], value);
export const workbenchTitle = (item: Workbench) => item.title?.trim() || item.name;
export const workbenchKind = (item: Workbench) => item.kind ?? 'session';
export const humanGate = (item: Workbench) => item.chats?.some((chat) => chat.status === 'awaiting_input') === true;
/** Newest first by creation, then id. Not by last change, so rows do not move while sessions work. */
export const compareWorkbenches = (a: Pick<Workbench, 'createdAt' | 'id'>, b: Pick<Workbench, 'createdAt' | 'id'>) =>
  b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id);
export function selectWorkbenches(items: Workbench[], kind: 'session' | 'thread', workspace: string) {
  return items.filter((item) => item.workspaceId === workspace && workbenchKind(item) === kind && !item.archivedAt)
    .sort(compareWorkbenches);
}
/** Replace a row in place, keeping embedded chats when the update omits them. Missing rows are inserted in order. */
export function upsertWorkbench(items: Workbench[], item: Workbench, belongs: boolean): Workbench[] {
  const index = items.findIndex((value) => value.id === item.id);
  if (!belongs) return index === -1 ? items : items.filter((value) => value.id !== item.id);
  const merged = index === -1 ? item : { ...item, chats: item.chats ?? items[index].chats };
  if (index !== -1) { const next = items.slice(); next[index] = merged; return next; }
  return [...items, merged].sort(compareWorkbenches);
}
/** Replace one chat inside a workbench row. Returns the same row when the chat is not part of it. */
export function withChat(item: Workbench, chat: WorkbenchChat): Workbench {
  if (item.id !== chat.workbenchId) return item;
  const chats = item.chats ?? [];
  const index = chats.findIndex((value) => value.id === chat.id);
  return { ...item, chats: index === -1 ? [...chats, chat] : chats.map((value) => value.id === chat.id ? chat : value) };
}
export interface RepoGroup { repo: string; items: Workbench[] }
/** Rows grouped by repository, the newest group first, like the web sidebar. Rows without a repository share one group. */
export function groupByRepository(items: Workbench[]): RepoGroup[] {
  const groups = new Map<string, Workbench[]>();
  for (const item of items) {
    const key = item.repoFullName || '';
    const list = groups.get(key);
    if (list) list.push(item); else groups.set(key, [item]);
  }
  return [...groups.entries()].map(([repo, list]) => ({ repo, items: [...list].sort(compareWorkbenches) }))
    .sort((a, b) => compareWorkbenches(a.items[0], b.items[0]) || a.repo.localeCompare(b.repo));
}
export function needsAttention(row: PRRow) {
  return row.state === 'open' && (row.reviewRequested && !row.reviewHiddenAt || Boolean(row.summary.humanGates?.length) ||
    Boolean(row.autoMergeState?.needsHuman) || row.mergeQueue?.status === 'blocked_manual' ||
    row.authored && (row.summary.effectiveReviewDecision === 'CHANGES_REQUESTED' || row.summary.reviewDecision === 'CHANGES_REQUESTED' || row.summary.ciStatus === 'failing_required'));
}
export function stackLabel(row: PRRow) {
  if (row.mergeQueue?.stackParentNumber) return `Based on #${row.mergeQueue.stackParentNumber}`;
  if (row.mergeQueue?.stackCoveredBy) return `Covered by #${row.mergeQueue.stackCoveredBy}`;
  const stack = row.summary.stack;
  if (stack === null) return 'Standalone';
  if (stack && Number.isInteger(stack.position) && Number.isInteger(stack.size) && stack.position > 0 && stack.size >= stack.position) return `${stack.position} of ${stack.size}`;
  return 'Unknown';
}
export function canCompose(item: Workbench | undefined, chat: WorkbenchChat | undefined) {
  return Boolean(item && chat && item.status === 'ready' && !item.archivedAt && ['idle', 'running', 'awaiting_input', 'error'].includes(chat.status));
}

export interface TranscriptRow { key: string; author: 'You' | 'Agent' | 'System'; text: string; timestamp: string | null; streaming: boolean }
export function transcriptRows(chatId: string, events: WorkbenchEvent[]): TranscriptRow[] {
  const normalized = events.map((item) => ({ ...item.event, seq: item.seq }));
  const bySeq = new Map(events.map((item) => [item.seq, item.event]));
  const rows: TranscriptRow[] = [];
  for (const block of buildBlocks(normalized)) {
    const seq = Number(block.key.split('.')[0]);
    const event = bySeq.get(seq);
    const rawTime = event?.timestamp;
    const timestamp = typeof rawTime === 'string' && Number.isFinite(Date.parse(rawTime)) ? rawTime : null;
    let text: string;
    if (block.kind === 'text' || block.kind === 'thinking' || block.kind === 'system') text = block.text;
    else if (block.kind === 'result') text = block.isError ? `Turn failed. ${block.summary}` : block.summary || 'Turn complete';
    else if (block.kind === 'permission') text = block.status === 'pending' ? 'A permission request needs the desktop or web app.' : `Permission: ${statusLabel(block.status)}`;
    else if (block.kind === 'tool_use') text = `Tool: ${block.name}`;
    else text = block.stopped ? 'Tool interrupted' : block.isError ? 'Tool failed' : 'Tool result';
    const system = block.kind !== 'text' && block.kind !== 'thinking' || Boolean(event?.talyn);
    rows.push({ key: `${chatId}:${block.key}`, author: system ? 'System' : event?.type === 'user' ? 'You' : 'Agent',
      text: text.slice(0, ROW_TEXT_LIMIT), timestamp, streaming: block.key.startsWith('stream-') });
  }
  for (const item of events) {
    if (item.event.type !== 'user' || item.event.talyn) continue;
    const content = item.event.message?.content;
    const text = typeof content === 'string' ? content : Array.isArray(content)
      ? content.filter((part) => part?.type === 'text' && typeof part.text === 'string').map((part) => part.text).join('\n') : '';
    if (!text || text.startsWith('[Request interrupted')) continue;
    rows.push({ key: `${chatId}:${item.seq}.user`, author: 'You', text: text.slice(0, ROW_TEXT_LIMIT),
      timestamp: typeof item.event.timestamp === 'string' ? item.event.timestamp : null, streaming: false });
  }
  return rows.sort((a, b) => {
    const seq = (row: TranscriptRow) => row.key.includes(':stream-') ? Infinity : Number(row.key.slice(chatId.length + 1).split('.')[0]);
    return seq(a) - seq(b);
  });
}
