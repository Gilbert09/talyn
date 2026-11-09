import {
  PLAN_APPROVED_MESSAGE, buildBlocks, findTurnPlan, groupToolRuns, isClaudeInterruptionEvent, mergeToolBlocks,
  stripAutoPrBlock, stripPlanBlocks, type AgentEvent, type GroupedBlock, type ThreadSessionEvent, type ToolBlock,
  type ToolGroupBlock, type WorkbenchEvent,
} from '@talyn/shared';

import { ROW_TEXT_LIMIT } from '../../workflow/model';
import { eventAttachments, type MessageImage } from './attachments';

type SystemBlock = Extract<GroupedBlock, { kind: 'system' }>;
export type PlanState = 'open' | 'approved' | 'past';
interface Base { key: string; timestamp: string | null }
/** One row of the conversation list. Rows are oldest first. */
export type TranscriptRow = Base & (
  | { kind: 'user'; text: string; attachments: number; files: MessageImage[] }
  | { kind: 'text'; text: string; streaming: boolean }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool'; tool: ToolBlock }
  | { kind: 'tool_group'; group: ToolGroupBlock }
  | { kind: 'permission'; toolName: string; toolInput: unknown; status: 'pending' | 'allowed' | 'denied' | 'auto_allowed'; persist: boolean }
  | { kind: 'system'; text: string; subtype?: string; url?: string; isError: boolean;
    pullRequest?: SystemBlock['pullRequest']; thread?: ThreadSessionEvent }
  | { kind: 'failed'; text: string }
  | { kind: 'stopped' }
  | { kind: 'plan'; plan: string; state: PlanState }
  | { kind: 'queued'; text: string; fromTalyn: boolean }
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
/** Split events into turns, each led by the user's message, like web `splitTurns`. */
function splitTurns(events: WorkbenchEvent[]): Turn[] {
  const turns: Turn[] = [];
  let current: Turn | null = null;
  let lastTurn: number | null = null;
  for (const entry of events) {
    // Claude's "[Request interrupted…]" user echo reads as a system line in the turn it stopped.
    const interruption = isClaudeInterruptionEvent(entry.event);
    const turn: number = interruption ? lastTurn ?? entry.turn : entry.turn;
    lastTurn = turn;
    const event: AgentEvent = interruption ? { seq: entry.seq, type: 'system', subtype: 'talyn_interruption' } as AgentEvent : { ...entry.event, seq: entry.seq };
    const text = interruption ? null : userMessageText(event);
    if (!current || current.turn !== turn || (text !== null && current.user !== null)) {
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

/**
 * The conversation as rows, oldest first. Mirrors web `WorkbenchTranscript`:
 * each turn is the user's message, then the agent's blocks with tool calls
 * paired with their results and runs of calls grouped. A completed turn's
 * result is hidden; a failed one shows its reason. A plan follows its turn.
 */
export function transcriptRows(chatId: string, events: WorkbenchEvent[]): TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  const seen = new Set<string>();
  const push = (row: TranscriptRow) => {
    let key = row.key; let n = 1;
    while (seen.has(key)) key = `${row.key}~${n++}`;
    seen.add(key); rows.push(key === row.key ? row : { ...row, key });
  };
  const turns = splitTurns(events);
  turns.forEach((turn, index) => {
    if (turn.user) push({ key: `${chatId}:${turn.user.seq}.user`, kind: 'user', text: clip(turn.user.text), timestamp: turn.user.at, attachments: turn.user.files.length, files: turn.user.files });
    if (!turn.events.length) return;
    const cancelled = turn.events.some((event) => event.type === 'result' && event.subtype === 'cancelled');
    for (const block of groupToolRuns(mergeToolBlocks(buildBlocks(turn.events)))) {
      const key = `${chatId}:${block.key}`;
      const seq = Number(block.key.replace(/^(group-|perm-)/, '').split('.')[0]);
      const timestamp = turn.times.get(seq) ?? null;
      switch (block.kind) {
        case 'text': {
          const text = stripPlanBlocks(stripAutoPrBlock(block.text)).trim();
          if (text) push({ key, timestamp, kind: 'text', text: clip(text), streaming: block.key.startsWith('stream-') });
          break;
        }
        case 'thinking': if (block.text.trim()) push({ key, timestamp, kind: 'thinking', text: clip(block.text) }); break;
        case 'tool': push({ key, timestamp, kind: 'tool', tool: block }); break;
        case 'tool_group': push({ key, timestamp, kind: 'tool_group', group: block }); break;
        case 'permission': push({ key, timestamp, kind: 'permission', toolName: block.toolName, toolInput: block.toolInput, status: block.status, persist: Boolean(block.persist) }); break;
        case 'system': push({ key, timestamp, kind: 'system', text: clip(block.text), subtype: block.subtype, url: block.url, isError: Boolean(block.isError),
          pullRequest: block.pullRequest, thread: block.thread }); break;
        case 'result':
          if (cancelled) push({ key, timestamp, kind: 'stopped' });
          else if (block.isError) push({ key, timestamp, kind: 'failed', text: clip(block.summary.trim() || 'The agent stopped unexpectedly.') });
          break;
      }
    }
    const plan = findTurnPlan(turn.events);
    if (plan) {
      const next = turns[index + 1];
      const state: PlanState = !next ? 'open' : next.user?.text === PLAN_APPROVED_MESSAGE ? 'approved' : 'past';
      push({ key: `${chatId}:${turn.turn}.${turn.user?.seq ?? index}.plan`, timestamp: null, kind: 'plan', plan: clip(plan), state });
    }
  });
  return rows;
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
  }
}
