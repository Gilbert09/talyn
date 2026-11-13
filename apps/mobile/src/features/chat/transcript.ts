import {
  PLAN_APPROVED_MESSAGE, buildBlocks, findTurnPlan, groupToolRuns, isClaudeInterruptionEvent, mergeToolBlocks, messageTrigger, messageTriggerText,
  stripAutoPrBlock, stripPlanBlocks, type AgentEvent, type GroupedBlock, type ThreadSessionEvent, type ToolBlock,
  type ToolGroupBlock, type WorkbenchEvent,
} from '@talyn/shared';

import { ROW_TEXT_LIMIT } from '../../workflow/model';
import { slimTools } from '../../workflow/slim';
import { eventAttachments, type MessageImage } from './attachments';

type SystemBlock = Extract<GroupedBlock, { kind: 'system' }>;
export type PlanState = 'open' | 'approved' | 'past';
interface Base { key: string; timestamp: string | null }
/** One row of the conversation list. Rows are oldest first. */
export type TranscriptRow = Base & (
  | { kind: 'user'; text: string; attachments: number; files: MessageImage[] }
  | { kind: 'text'; text: string; streaming: boolean }
  | { kind: 'thinking'; text: string }
  /** `partial`: the window holds only a preview of the call or its result. */
  | { kind: 'tool'; tool: ToolBlock; partial: boolean }
  /** `partial`: the tool ids inside the group the window holds only a preview of. */
  | { kind: 'tool_group'; group: ToolGroupBlock; partial: readonly string[] }
  | { kind: 'permission'; toolName: string; toolInput: unknown; status: 'pending' | 'allowed' | 'denied' | 'auto_allowed'; persist: boolean }
  | { kind: 'system'; text: string; subtype?: string; url?: string; isError: boolean;
    pullRequest?: SystemBlock['pullRequest']; thread?: ThreadSessionEvent }
  | { kind: 'failed'; text: string }
  | { kind: 'stopped' }
  | { kind: 'plan'; plan: string; state: PlanState }
  | { kind: 'queued'; text: string; fromTalyn: boolean }
  /** Events that could not be turned into rows. The rest of the conversation still shows. */
  | { kind: 'broken' }
);

/** True for text the harness added, such as a launched skill's instructions. Mirrors web. */
function injected(event: AgentEvent) {
  return event.type === 'user' && event.talyn_user_message !== true && (event.isSynthetic === true || event.isMeta === true);
}
/** The text of a user message event, or null for any other event. Mirrors web `userMessageText`. */
export function userMessageText(event: AgentEvent): string | null {
  if (event.type === 'talyn_user_message' && typeof event.text === 'string') return event.text;
  if (event.type !== 'user' || injected(event)) return null;
  const content = event.message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const texts: string[] = [];
  for (const block of content) {
    const part = block as { type?: unknown; text?: unknown };
    if (part?.type === 'tool_result') return null;
    if (part?.type === 'text' && typeof part.text === 'string') texts.push(part.text);
  }
  return texts.length ? texts.join('\n') : null;
}
function eventFiles(event: AgentEvent): MessageImage[] {
  const talyn = event.talyn as { attachments?: unknown } | undefined;
  return eventAttachments(talyn?.attachments ?? event.talyn_attachments);
}
const timeOf = (entry: WorkbenchEvent) => {
  const raw = entry.createdAt ?? entry.event.timestamp;
  return typeof raw === 'string' && Number.isFinite(Date.parse(raw)) ? raw : null;
};

interface Turn { turn: number; user: { text: string; seq: number; at: string | null; files: MessageImage[] } | null; events: AgentEvent[]; times: Map<number, string | null> }
/** Split one turn's events at each new user message, like web `splitTurns`. */
function splitTurns(turn: number, events: WorkbenchEvent[], interruption: (entry: WorkbenchEvent) => boolean): Turn[] {
  const turns: Turn[] = [];
  let current: Turn | null = null;
  for (const entry of events) {
    // Claude's "[Request interrupted…]" user echo reads as a system line in the turn it stopped.
    const interrupted = interruption(entry);
    const event: AgentEvent = interrupted ? { seq: entry.seq, type: 'system', subtype: 'talyn_interruption' } as AgentEvent : { ...entry.event, seq: entry.seq };
    // A turn Talyn started for a trigger (a wake-up, a job exit, a pull request retry) is a system line, as on web.
    const text = interrupted || messageTrigger(event.talyn) ? null : userMessageText(event);
    if (!current || (text !== null && current.user !== null)) {
      current = { turn, user: null, events: [], times: new Map() };
      turns.push(current);
    }
    if (text !== null && current.user === null && current.events.length === 0) {
      current.user = { text, seq: entry.seq, at: timeOf(entry), files: eventFiles(entry.event) };
    } else {
      current.events.push(event);
      current.times.set(entry.seq, timeOf(entry));
    }
  }
  return turns;
}

const clip = (text: string) => text.length > ROW_TEXT_LIMIT ? text.slice(0, ROW_TEXT_LIMIT) : text;
const NONE: readonly string[] = Object.freeze([]);

/** The rows of one turn without its plan, which depends on the next turn. */
function turnRows(chatId: string, turn: Turn, partial: ReadonlySet<string>): TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  if (turn.user) rows.push({ key: `${chatId}:${turn.user.seq}.user`, kind: 'user', text: clip(turn.user.text), timestamp: turn.user.at, attachments: turn.user.files.length, files: turn.user.files });
  if (!turn.events.length) return rows;
  const cancelled = turn.events.some((event) => event.type === 'result' && event.subtype === 'cancelled');
  for (const block of groupToolRuns(mergeToolBlocks(buildBlocks(turn.events)))) {
    const key = `${chatId}:${block.key}`;
    const seq = Number(block.key.replace(/^(group-|perm-)/, '').split('.')[0]);
    const timestamp = turn.times.get(seq) ?? null;
    switch (block.kind) {
      case 'text': {
        const text = stripPlanBlocks(stripAutoPrBlock(block.text)).trim();
        if (text) rows.push({ key, timestamp, kind: 'text', text: clip(text), streaming: block.key.startsWith('stream-') });
        break;
      }
      case 'thinking': if (block.text.trim()) rows.push({ key, timestamp, kind: 'thinking', text: clip(block.text) }); break;
      case 'tool': rows.push({ key, timestamp, kind: 'tool', tool: block, partial: partial.has(block.toolId) }); break;
      case 'tool_group': {
        const ids = partial.size ? block.tools.filter((tool) => partial.has(tool.toolId)).map((tool) => tool.toolId) : NONE;
        rows.push({ key, timestamp, kind: 'tool_group', group: block, partial: ids.length ? ids : NONE });
        break;
      }
      case 'permission': rows.push({ key, timestamp, kind: 'permission', toolName: block.toolName, toolInput: block.toolInput, status: block.status, persist: Boolean(block.persist) }); break;
      // A wake-up, a job exit or a pull request retry: one short line, as on web.
      case 'system': rows.push({ key, timestamp, kind: 'system', text: clip(block.trigger ? messageTriggerText(block.trigger) : block.text), subtype: block.subtype, url: block.url, isError: Boolean(block.isError),
        pullRequest: block.pullRequest, thread: block.thread }); break;
      case 'result':
        if (cancelled) rows.push({ key, timestamp, kind: 'stopped' });
        else if (block.isError) rows.push({ key, timestamp, kind: 'failed', text: clip(block.summary.trim() || 'The agent stopped unexpectedly.') });
        break;
    }
  }
  return rows;
}

/** One turn's share of the conversation: its rows, and what its plan needs from its neighbours. */
interface Segment { rows: TranscriptRow[]; plan: string | null; turn: number; userSeq: number | null; userText: string | null }
interface Group { entries: WorkbenchEvent[]; segments: Segment[] }

function sameEntries(a: WorkbenchEvent[], b: WorkbenchEvent[]) {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return false;
  return true;
}
const sameTool = (a: ToolBlock, b: ToolBlock) => a.key === b.key && a.toolId === b.toolId && a.name === b.name && a.input === b.input &&
  a.output === b.output && a.isError === b.isError && a.stopped === b.stopped && a.settled === b.settled;
const sameJson = (a: unknown, b: unknown) => a === b || (typeof a === 'object' && typeof b === 'object' && JSON.stringify(a) === JSON.stringify(b));
/** True when two rows draw the same. Lets an unchanged row keep its object, so its memoised view does not render again. */
export function sameRow(a: TranscriptRow, b: TranscriptRow): boolean {
  if (a === b) return true;
  if (a.kind !== b.kind || a.key !== b.key || a.timestamp !== b.timestamp) return false;
  if (a.kind === 'tool' && b.kind === 'tool') return a.partial === b.partial && sameTool(a.tool, b.tool);
  if (a.kind === 'tool_group' && b.kind === 'tool_group') {
    const x = a.group; const y = b.group;
    return x.summary === y.summary && x.running === y.running && x.isError === y.isError && x.failedCount === y.failedCount &&
      x.lastFailed === y.lastFailed && x.children.length === y.children.length && sameJson(a.partial, b.partial) &&
      x.children.every((child, index) => {
        const other = y.children[index];
        if (child.kind === 'tool' || other.kind === 'tool') return child.kind === 'tool' && other.kind === 'tool' && sameTool(child, other);
        return child.key === other.key && child.text === other.text;
      });
  }
  const left = a as unknown as Record<string, unknown>; const right = b as unknown as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((key) => sameJson(left[key], right[key]));
}

/**
 * Builds conversation rows, oldest first, and keeps what it built. Mirrors web `WorkbenchTranscript`:
 * each turn is the user's message, then the agent's blocks with tool calls paired with their
 * results and runs of calls grouped. A completed turn's result is hidden; a failed one shows its
 * reason. A plan follows its turn.
 *
 * A turn whose events are the same objects as last time reuses its rows, and a rebuilt row that
 * draws the same keeps its old object. A socket event costs the work of its own turn only.
 */
export class TranscriptRowCache {
  private chatId: string | null = null;
  private groups = new Map<number, Group>();
  private previous = new Map<string, TranscriptRow>();
  private interruptions = new WeakMap<WorkbenchEvent, boolean>();
  private interrupted = (entry: WorkbenchEvent) => {
    let known = this.interruptions.get(entry);
    if (known === undefined) {
      try { known = isClaudeInterruptionEvent(entry.event); } catch { known = false; }
      this.interruptions.set(entry, known);
    }
    return known;
  };

  rows(chatId: string, events: WorkbenchEvent[]): TranscriptRow[] {
    if (chatId !== this.chatId) { this.chatId = chatId; this.groups.clear(); this.previous.clear(); }
    // Consecutive events of one turn. An interruption belongs to the turn it stopped.
    const runs: Array<{ turn: number; entries: WorkbenchEvent[] }> = [];
    let lastTurn: number | null = null;
    for (const entry of events) {
      const turn: number = this.interrupted(entry) ? lastTurn ?? entry.turn : entry.turn;
      lastTurn = turn;
      const run = runs[runs.length - 1];
      if (run && run.turn === turn) run.entries.push(entry); else runs.push({ turn, entries: [entry] });
    }
    const groups = new Map<number, Group>();
    const segments: Segment[] = [];
    for (const run of runs) {
      const first = run.entries[0].seq;
      let group = this.groups.get(first);
      if (!group || !sameEntries(group.entries, run.entries)) group = { entries: run.entries, segments: this.segments(chatId, run.turn, run.entries) };
      groups.set(first, group);
      segments.push(...group.segments);
    }
    this.groups = groups;

    const rows: TranscriptRow[] = [];
    const seen = new Set<string>();
    const next = new Map<string, TranscriptRow>();
    const push = (row: TranscriptRow) => {
      let key = row.key; let n = 1;
      while (seen.has(key)) key = `${row.key}~${n++}`;
      seen.add(key);
      let item = key === row.key ? row : { ...row, key };
      const old = this.previous.get(key);
      if (old && sameRow(old, item)) item = old;
      next.set(key, item); rows.push(item);
    };
    segments.forEach((segment, index) => {
      segment.rows.forEach(push);
      if (segment.plan === null) return;
      const following = segments[index + 1];
      const state: PlanState = !following ? 'open' : following.userText === PLAN_APPROVED_MESSAGE ? 'approved' : 'past';
      push({ key: `${chatId}:${segment.turn}.${segment.userSeq ?? index}.plan`, timestamp: null, kind: 'plan', plan: clip(segment.plan), state });
    });
    this.previous = next;
    return rows;
  }

  private segments(chatId: string, turn: number, entries: WorkbenchEvent[]): Segment[] {
    try {
      const partial = new Set<string>();
      for (const entry of entries) for (const id of slimTools(entry.event)) partial.add(id);
      return splitTurns(turn, entries, this.interrupted).map((item) => ({
        rows: turnRows(chatId, item, partial), plan: item.events.length ? findTurnPlan(item.events) ?? null : null,
        turn: item.turn, userSeq: item.user?.seq ?? null, userText: item.user?.text ?? null,
      }));
    } catch {
      // One unreadable turn shows as a notice. The rest of the conversation still draws.
      return [{ rows: [{ key: `${chatId}:${entries[0].seq}.broken`, timestamp: null, kind: 'broken' }], plan: null, turn, userSeq: null, userText: null }];
    }
  }
}

/** The conversation as rows, oldest first. See `TranscriptRowCache`. */
export function transcriptRows(chatId: string, events: WorkbenchEvent[]): TranscriptRow[] {
  return new TranscriptRowCache().rows(chatId, events);
}

/** What a screen reader says for a row. */
export function rowLabel(row: TranscriptRow): string {
  switch (row.kind) {
    case 'user': return `You said: ${row.text}`;
    case 'text': return `Agent said: ${row.text}`;
    case 'thinking': return 'Agent thinking';
    case 'failed': return `Turn failed. ${row.text}`;
    case 'stopped': return 'Stopped';
    case 'queued': return `${row.fromTalyn ? 'From Talyn' : 'Queued'}: ${row.text}`;
    case 'system': return row.text;
    case 'plan': return 'Plan';
    case 'permission': return `Permission for ${row.toolName}`;
    case 'tool': return `Tool ${row.tool.name}`;
    case 'tool_group': return row.group.summary;
    case 'broken': return 'Part of this conversation could not be shown.';
  }
}
