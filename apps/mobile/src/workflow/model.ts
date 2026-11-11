import type { Workbench, WorkbenchChat, WorkbenchEvent } from '@talyn/shared';
import type { PRRow, WorkbenchEventsPage } from '@talyn/client/native';

import { eventSize, slimEvent } from './slim';

export const SCHEMA_VERSION = 1;
export const PAGE_SIZE = 200;
/** The most events one backward page may hold while it reaches back to the start of a turn. */
export const PAGE_CEILING = 400;
export const ROW_TEXT_LIMIT = 16000;
export interface Scope { environment: string; user: string; workspace: string }
/** `attention` holds every open PR of the workspace, as web's one PR store; the three PR pages filter it. */
export type Entity = 'sessions' | 'threads' | 'attention' | 'workbench' | 'children' | 'readiness' | 'pr' | 'timeline' | 'transcript'
  | 'features' | 'repositories' | 'providers' | 'workspace' | 'environments' | 'codeReview' | 'prDescription' | 'prFiles' | 'prReviews';
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

/**
 * Transcript window. Events are slimmed when they arrive (`slim.ts`), and the window is
 * budgeted on the slimmed size, so a multi-hour session normally fits whole.
 *
 * When a cap applies, events go from the side away from the reader. The newest events are
 * never dropped: reading older history stops at the budget (`limited`) instead.
 */
export const EVENT_LIMIT = 12_000;
/** Estimated bytes of slimmed events (`eventSize`). */
export const EVENT_BYTES = 24_000_000;
/** While the reader is in older history, live events may grow the window this much past the budget before the oldest go. */
export const READING_SLACK = 1.5;
/** A jump to the newest message releases older events past this count, keeping `RELEASE_KEEP`. They load again on scroll. */
export const RELEASE_AT = 2_000;
export const RELEASE_KEEP = 1_000;

export interface Transcript {
  /** Oldest first, each one slimmed. */
  events: WorkbenchEvent[];
  /** Estimated bytes of `events`. Kept as events come and go, never recounted. */
  bytes: number;
  /** The highest seq with every seq before it held, from the history boundary. */
  cursor: number;
  oldest: number | null;
  /** Older events exist on the server that this window does not hold. */
  hasOlder: boolean;
  gap: boolean;
  /** A REST page set the history boundary. Socket events alone do not. */
  anchored: boolean;
  /** The window is full while the reader is in older history, so no older page can load. A jump to the newest message clears it. */
  limited: boolean;
  /** The last older page failed. Loading stops until the reader asks again. */
  olderFailed: boolean;
}
export const emptyTranscript = (): Transcript => ({ events: [], bytes: 0, cursor: 0, oldest: null, hasOlder: false, gap: false,
  anchored: false, limited: false, olderFailed: false });
export type MergeMode = 'live' | 'rest' | 'older';
/** Where the reader is. Decides which side of the window gives way. */
export type Reading = 'newest' | 'older';

const sum = (events: WorkbenchEvent[], from = 0, to = events.length) => {
  let total = 0;
  for (let index = from; index < to; index++) total += eventSize(events[index]);
  return total;
};
/** The first index whose seq is above `seq`. */
function firstAbove(events: WorkbenchEvent[], seq: number) {
  let low = 0; let high = events.length;
  while (low < high) { const mid = (low + high) >> 1; if (events[mid].seq > seq) high = mid; else low = mid + 1; }
  return low;
}
/** Two sorted runs as one, `fresh` winning on an equal seq. `held` itself when `fresh` adds or changes nothing. */
function mergeSorted(held: WorkbenchEvent[], fresh: WorkbenchEvent[]) {
  const out: WorkbenchEvent[] = [];
  let a = 0; let b = 0; let changed = false;
  while (a < held.length || b < fresh.length) {
    if (b >= fresh.length || (a < held.length && held[a].seq < fresh[b].seq)) out.push(held[a++]);
    else {
      if (a < held.length && held[a].seq === fresh[b].seq) { if (held[a] !== fresh[b]) changed = true; a++; } else changed = true;
      out.push(fresh[b++]);
    }
  }
  return changed ? out : held;
}
/** Valid events of this chat, slimmed, sorted and unique by seq (the last copy wins). */
function incomingEvents(chatId: string, incoming: WorkbenchEvent[]) {
  const valid: WorkbenchEvent[] = [];
  let sorted = true;
  for (const item of incoming) {
    if (item?.chatId !== chatId || !Number.isSafeInteger(item.seq) || item.seq <= 0) continue;
    const slim = slimEvent(item);
    const last = valid[valid.length - 1];
    if (last && slim.seq <= last.seq) sorted = false;
    valid.push(slim);
  }
  if (sorted) return valid;
  const bySeq = new Map(valid.map((item) => [item.seq, item]));
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}
/** True when the window has no room for another event of its average size. */
export const windowFull = (t: Transcript) => t.events.length >= EVENT_LIMIT ||
  t.bytes + (t.events.length ? t.bytes / t.events.length : 0) > EVENT_BYTES;

/**
 * Merge events into the window. Idempotent: merging held events again changes nothing.
 * Appending live events and prepending an older page cost the size of the new events only.
 */
export function mergeEvents(chatId: string, current: Transcript, incoming: WorkbenchEvent[], mode: MergeMode = 'live',
  page?: WorkbenchEventsPage, reading: Reading = 'newest'): Transcript {
  const fresh = incomingEvents(chatId, incoming);
  const held = current.events;
  let events: WorkbenchEvent[];
  let bytes = current.bytes;
  if (!fresh.length) events = held;
  else if (!held.length) { events = fresh; bytes = sum(fresh); }
  else if (fresh[0].seq > held[held.length - 1].seq) { events = held.concat(fresh); bytes += sum(fresh); }
  else if (fresh[fresh.length - 1].seq < held[0].seq) { events = fresh.concat(held); bytes += sum(fresh); }
  else { events = mergeSorted(held, fresh); if (events !== held) bytes = sum(events); }

  let cursor = current.cursor;
  // The first backward page establishes an intentional history boundary.
  if (!held.length && mode === 'rest' && page?.oldestSeq != null) cursor = page.oldestSeq - 1;
  for (let index = firstAbove(events, cursor); index < events.length && events[index].seq === cursor + 1; index++) cursor = events[index].seq;

  let hasOlder = current.hasOlder;
  if (mode === 'older' || (mode === 'rest' && !current.anchored)) hasOlder = page?.hasOlder === true;
  let limited = current.limited;
  let drop = 0;
  if (mode === 'older') {
    // The newest events stay. The page gives way, oldest first, and never the events already held.
    const added = held.length ? firstAbove(events, held[0].seq - 1) : events.length;
    let count = events.length; let size = bytes;
    while (drop < added && (count > EVENT_LIMIT || size > EVENT_BYTES)) { size -= eventSize(events[drop]); count--; drop++; }
    if (drop) limited = true;
  } else {
    const slack = reading === 'older' ? READING_SLACK : 1;
    if (events.length > EVENT_LIMIT * slack || bytes > EVENT_BYTES * slack) {
      let count = events.length; let size = bytes;
      // Down to the plain budget, so the window does not trim on every live event.
      while (count > 1 && (count > EVENT_LIMIT || size > EVENT_BYTES)) { size -= eventSize(events[drop]); count--; drop++; }
      limited = false;
    }
  }
  if (drop) { bytes -= sum(events, 0, drop); events = events.slice(drop); hasOlder = true; }
  const unchanged = events === held && cursor === current.cursor && hasOlder === current.hasOlder && limited === current.limited &&
    (mode === 'live' || current.anchored) && !(mode === 'older' && current.olderFailed);
  if (unchanged) return current;
  return { events, bytes, cursor, oldest: events[0]?.seq ?? null, gap: events.length > 0 && events[events.length - 1].seq > cursor, hasOlder,
    anchored: current.anchored || mode !== 'live', limited, olderFailed: mode === 'older' ? false : current.olderFailed };
}

/** Release older events after the reader returns to the newest message. They load again when the reader scrolls up. */
export function releaseOlder(current: Transcript): Transcript {
  if (current.events.length <= RELEASE_AT && !current.limited) return current;
  const drop = Math.max(0, current.events.length - RELEASE_KEEP);
  const events = current.events.slice(drop);
  return { ...current, events, bytes: current.bytes - sum(current.events, 0, drop), oldest: events[0]?.seq ?? null,
    hasOlder: current.hasOlder || drop > 0, limited: false, olderFailed: false };
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
  queued: 'Queued', awaiting_ci: 'Waiting for CI', waiting_ci: 'Waiting for CI', awaiting_review: 'Waiting for review',
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
