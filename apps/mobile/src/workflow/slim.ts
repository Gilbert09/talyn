import type { AgentEvent, WorkbenchEvent } from '@talyn/shared';

/**
 * Transcript events are made smaller when they arrive, so a long session fits in memory.
 *
 * Message text (agent text, thinking, the person's messages) is kept whole up to
 * `MESSAGE_TEXT_CAP`. Tool inputs and results are cut to a preview. The full
 * call and result load again on demand (`fullTool` in `features/chat/fullTool.ts`).
 * Web keeps whole events; a phone cannot, because one session can hold hundreds of
 * megabytes of tool output.
 */

/** Characters kept of one text, thinking or user message block. The row shows at most `ROW_TEXT_LIMIT` of it. */
export const MESSAGE_TEXT_CAP = 64_000;
/** Characters kept of one string in a tool input or result. */
export const TOOL_TEXT_CAP = 4_000;
/** Characters kept of one tool input or result in total, over all of its strings. */
export const TOOL_BUDGET = 12_000;
/** Items kept of one array inside a tool input or result. */
const TOOL_ITEMS = 200;
/** Deeper values in a tool input or result are dropped. */
const MAX_DEPTH = 16;
/** Estimated bytes for one key, number or bracket, used for the window budget. */
const OVERHEAD = 8;

/** Set on an event that lost part of a tool call or result. `tools` holds the tool ids. */
export const SLIM_MARK = 'talyn_mobile_slim';
export interface SlimMark { tools: string[] }

interface Clip { left: number; cut: boolean; size: number }
const sizes = new WeakMap<WorkbenchEvent, number>();

/** A string kept to `cap` characters and the budget that is left. */
function clipString(value: string, cap: number, clip: Clip): string {
  const keep = Math.max(0, Math.min(cap, clip.left));
  clip.size += Math.min(value.length, keep) + 2;
  if (value.length <= keep) { clip.left -= value.length; return value; }
  clip.left -= keep; clip.cut = true;
  return value.slice(0, keep);
}

/** Any JSON value with each string cut to `cap` and the whole cut to the budget. Unchanged values keep their identity. */
function clipValue(value: unknown, cap: number, clip: Clip, items: number, depth = 0): unknown {
  if (typeof value === 'string') return clipString(value, cap, clip);
  if (value === null || typeof value !== 'object') { clip.size += OVERHEAD; return value; }
  if (depth >= MAX_DEPTH) { clip.cut = true; clip.size += OVERHEAD; return null; }
  if (Array.isArray(value)) {
    clip.size += OVERHEAD;
    if (value.length > items) clip.cut = true;
    let changed = value.length > items;
    const out = value.slice(0, items).map((item) => {
      const next = clipValue(item, cap, clip, items, depth + 1);
      if (next !== item) changed = true;
      return next;
    });
    return changed ? out : value;
  }
  const record = value as Record<string, unknown>;
  // Image data is never drawn from an event. Attachments load through their own route.
  if (record.type === 'image' && record.source && typeof record.source === 'object') {
    clip.cut = true; clip.size += OVERHEAD;
    const { source, ...rest } = record;
    return { ...rest, source: { type: (source as { type?: unknown }).type ?? 'omitted' } };
  }
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(record)) {
    clip.size += key.length + OVERHEAD;
    const next = clipValue(record[key], cap, clip, items, depth + 1);
    if (next !== record[key]) changed = true;
    out[key] = next;
  }
  return changed ? out : value;
}

const textClip = (): Clip => ({ left: Number.POSITIVE_INFINITY, cut: false, size: 0 });
const toolClip = (): Clip => ({ left: TOOL_BUDGET, cut: false, size: 0 });

/** One content block of an assistant or user message. */
function slimBlock(block: unknown, total: Clip, tools: Set<string>): unknown {
  if (!block || typeof block !== 'object' || Array.isArray(block)) return clipValue(block, MESSAGE_TEXT_CAP, total, Number.POSITIVE_INFINITY);
  const part = block as Record<string, unknown>;
  if (part.type === 'tool_use' || part.type === 'tool_result') {
    const clip = toolClip();
    const field = part.type === 'tool_use' ? 'input' : 'content';
    const id = String(part.type === 'tool_use' ? part.id ?? '' : part.tool_use_id ?? '');
    const next = clipValue(part[field], TOOL_TEXT_CAP, clip, TOOL_ITEMS);
    total.size += clip.size + 64;
    if (!clip.cut) return block;
    if (id) tools.add(id);
    return { ...part, [field]: next };
  }
  if (part.type === 'thinking') {
    // The signature is opaque, often several kilobytes, and never shown.
    const { signature: _signature, ...rest } = part;
    const next = clipValue(rest, MESSAGE_TEXT_CAP, total, Number.POSITIVE_INFINITY);
    return next === rest && _signature === undefined ? block : next;
  }
  return clipValue(block, MESSAGE_TEXT_CAP, total, Number.POSITIVE_INFINITY);
}

/** The event with large tool payloads cut, and its estimated size in bytes. */
function slimAgentEvent(event: AgentEvent): { event: AgentEvent; size: number } {
  const total = textClip();
  const tools = new Set<string>();
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(event)) {
    const value = event[key];
    let next: unknown;
    total.size += key.length + OVERHEAD;
    if (key === 'message' && value && typeof value === 'object' && Array.isArray((value as { content?: unknown }).content)) {
      const message = value as { content: unknown[] } & Record<string, unknown>;
      let contentChanged = false;
      const content = message.content.map((block) => {
        const slim = slimBlock(block, total, tools);
        if (slim !== block) contentChanged = true;
        return slim;
      });
      const { content: _content, ...rest } = message;
      const restNext = clipValue(rest, MESSAGE_TEXT_CAP, total, Number.POSITIVE_INFINITY) as Record<string, unknown>;
      next = contentChanged || restNext !== rest ? { ...restNext, content } : value;
    } else if (key === 'tool_input') {
      const clip = toolClip();
      next = clipValue(value, TOOL_TEXT_CAP, clip, TOOL_ITEMS);
      total.size += clip.size;
    } else {
      next = clipValue(value, MESSAGE_TEXT_CAP, total, Number.POSITIVE_INFINITY);
    }
    if (next !== value) changed = true;
    out[key] = next;
  }
  if (tools.size) { out[SLIM_MARK] = { tools: [...tools] } satisfies SlimMark; changed = true; }
  return { event: changed ? out as AgentEvent : event, size: total.size + 64 };
}

/** True once an event went through `slimEvent`. */
export const isSlim = (item: WorkbenchEvent) => sizes.has(item);

/**
 * The event as the transcript keeps it. Idempotent and cheap for an event that is already slim.
 * Returns the same object when nothing needed a cut, so held rows keep their identity.
 */
export function slimEvent(item: WorkbenchEvent): WorkbenchEvent {
  if (sizes.has(item)) return item;
  let slim = item;
  let size = OVERHEAD * 8 + (item.createdAt?.length ?? 0);
  try {
    const result = slimAgentEvent(item.event);
    size += result.size;
    if (result.event !== item.event) slim = { ...item, event: result.event };
  } catch {
    // An event that cannot be read is kept as a stub, so one bad event cannot hold the rest back.
    slim = { ...item, event: { seq: item.seq, type: 'system', subtype: 'talyn_mobile_unreadable' } as AgentEvent };
  }
  sizes.set(slim, size);
  return slim;
}

/** The estimated bytes one held event costs. */
export function eventSize(item: WorkbenchEvent): number {
  const known = sizes.get(item);
  if (known !== undefined) return known;
  return sizes.get(slimEvent(item)) ?? 0;
}

/** The tool ids of calls or results this event holds only in part. */
export function slimTools(event: AgentEvent): string[] {
  const mark = event[SLIM_MARK] as SlimMark | undefined;
  return Array.isArray(mark?.tools) ? mark.tools : [];
}
