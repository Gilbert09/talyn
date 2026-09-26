import type { AgentEvent } from '@talyn/shared';
import type { FleetEvent } from './client.js';

/**
 * Reading a fleet run's event log, as pure functions over an array.
 *
 * Extracted from the task poller so a caller with no `tasks` row can use it.
 * The code-review pipeline is that caller: its units are not tasks, so it holds
 * no transcript and reads a run's tail straight from the fleet's own durable
 * log (`FleetClient.getEvents(id, after)`) at the moment the run settles.
 *
 * Everything here is a pure function of its arguments on purpose. The task
 * poller keeps its in-memory transcript and calls these against it; the review
 * poller calls the same functions against events it has only just fetched. One
 * definition of "what did the agent finally say", two ways of getting the
 * events to ask it about.
 */

/**
 * Unwrap the fleet's envelope into the shape the transcript renderer reads.
 *
 * The fleet WRAPS each event as `{type, subtype, raw, guestSeq}`, where `raw` is
 * the Agent SDK message itself and the outer `type`/`subtype` are copies fleetd
 * probed out of it so it can index without parsing the payload.
 *
 * `AgentEvent` — what every other provider produces and what the renderer reads
 * — carries the SDK message AT THE TOP LEVEL: `message`, `content`, `result`.
 * Spreading the wrapper put all of that one level down under `raw`, so a
 * transcript looked structurally fine and rendered as nothing: a task sat on
 * "Claude is thinking..." while 47 events were already in Postgres.
 *
 * Worth stating plainly, because the symptom was indistinguishable from the
 * three other causes chased before it (a tailnet MTU black hole, NUL bytes the
 * jsonb column refused, a stale fleet build). Every layer reported success and
 * the payload was present at every hop. Only the shape was wrong, and nothing
 * type-checks a jsonb column.
 *
 * Falls back to the event itself when there is no `raw`, so an older fleet that
 * does not wrap still ingests rather than producing empty entries. The host's
 * synthetic `task_started` / `task_complete` markers take the same path: they
 * carry no `raw`, pass through whole, and the renderer skips types it does not
 * know — tolerated, never fatal.
 */
export function toAgentEvent(ev: FleetEvent): AgentEvent {
  const wrapper = ev.event as { raw?: unknown } | undefined;
  const payload = (wrapper?.raw ?? ev.event ?? {}) as object;
  return { ...payload, seq: ev.seq } as AgentEvent;
}

/**
 * The text of an `assistant` transcript event, flattened.
 *
 * Content is an array of blocks; only `text` blocks are prose. Joined rather
 * than first-only because a single assistant turn is often several blocks and
 * anything we look for at the end — a sentinel, a JSON payload — sits at the
 * very end of the last one. A block boundary falling mid-line is exactly how a
 * streamed message hides a marker from a naive reader.
 */
export function assistantText(event: AgentEvent): string | null {
  const content = event.message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const text = content
    .map((block) => {
      if (!block || typeof block !== 'object') return '';
      const b = block as { type?: unknown; text?: unknown };
      return b.type === 'text' && typeof b.text === 'string' ? b.text : '';
    })
    .join('');
  return text.length > 0 ? text : null;
}

/**
 * The agent's last word, walking backwards.
 *
 * A `result` event's string is the agent server's own summary and is preferred
 * when present; otherwise the last assistant turn that actually said something.
 * Backwards rather than forwards because the thing every caller wants is at the
 * end: the needs-human sentinel, or the review's JSON block.
 *
 * Returns null for an empty or silent transcript, and null means UNKNOWN. No
 * caller may read it as "the agent had nothing to report" — for the review
 * pipeline that distinction is the difference between a failed unit and a clean
 * bill of health.
 */
export function finalTextFromEvents(events: readonly AgentEvent[]): string | null {
  if (!events.length) return null;
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.type === 'result' && typeof event.result === 'string') {
      return event.result;
    }
    if (event.type === 'assistant') {
      const text = assistantText(event);
      if (text) return text;
    }
  }
  return null;
}
