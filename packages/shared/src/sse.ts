// Server-sent-event framing, shared by everything that speaks it.
//
// Three parties now handle the same stream: the fleet client reading a run's
// transcript from fleetd, the admin API proxying that stream on to a browser,
// and the browser reading it. Three hand-rolled buffer-and-split loops is three
// chances to disagree about what a frame is — and the disagreement surfaces as
// "the transcript stops halfway" rather than as an exception, because a
// half-parsed SSE stream looks exactly like a quiet one.
//
// The wire format is deliberately narrow here: `data:` lines carry JSON, blank
// lines separate frames, and anything else is a comment. The fleet and admin
// streams emit nothing else. The public API's transcript stream also sends
// `id:` and `event:` lines (see `formatSseEventFrame` below). No endpoint sends
// a multi-line `data:`, so these parsers implement what we use rather than the
// whole spec.

/** Frames are separated by a blank line. */
const FRAME_SEPARATOR = '\n\n';
const DATA_PREFIX = 'data: ';

/**
 * A keepalive comment.
 *
 * Idle SSE connections get reaped by intermediaries — Railway's edge does it,
 * and so does fleetd's own upstream. A comment is the cheapest thing that keeps
 * a connection accounted for while carrying no data, and because it is not a
 * `data:` line every parser here ignores it for free.
 */
export const SSE_KEEPALIVE_FRAME = ': ping\n\n';

/** Serialize one JSON payload as an SSE frame. The only writer we have. */
export function formatSseFrame(payload: unknown): string {
  return `${DATA_PREFIX}${JSON.stringify(payload)}${FRAME_SEPARATOR}`;
}

export interface SseJsonParser<T> {
  /**
   * Feed a decoded chunk. Returns every complete frame the buffer now holds —
   * possibly none, possibly several, since chunk boundaries and frame
   * boundaries are unrelated.
   */
  push(chunk: string): T[];
}

/**
 * A stateful parser that turns a stream of text chunks into JSON payloads.
 *
 * A malformed frame is DROPPED, not thrown. Every consumer of this has a slower
 * but authoritative path underneath — the fleet poller holds the same cursor,
 * and the browser can refetch the range — so killing the stream over one bad
 * frame trades a recoverable gap for an unrecoverable one.
 */
export function createSseJsonParser<T = unknown>(): SseJsonParser<T> {
  let buffer = '';
  return {
    push(chunk: string): T[] {
      buffer += chunk;
      const out: T[] = [];
      let sep: number;
      while ((sep = buffer.indexOf(FRAME_SEPARATOR)) !== -1) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + FRAME_SEPARATOR.length);
        for (const line of frame.split('\n')) {
          if (!line.startsWith(DATA_PREFIX)) continue;
          try {
            out.push(JSON.parse(line.slice(DATA_PREFIX.length)) as T);
          } catch {
            // See the docblock: a bad frame is a gap, not a failure.
          }
        }
      }
      return out;
    },
  };
}

/**
 * One named, numbered frame: the public API's transcript stream. `id` is what
 * an EventSource sends back as `Last-Event-ID` when it connects again.
 */
export interface SseEventFrame<T = unknown> {
  id?: string;
  event?: string;
  data: T;
}

/** Serialize a frame with optional `id:` and `event:` lines. */
export function formatSseEventFrame(frame: SseEventFrame): string {
  const lines: string[] = [];
  if (frame.id !== undefined) lines.push(`id: ${frame.id}`);
  if (frame.event !== undefined) lines.push(`event: ${frame.event}`);
  lines.push(`${DATA_PREFIX}${JSON.stringify(frame.data)}`);
  return `${lines.join('\n')}${FRAME_SEPARATOR}`;
}

/**
 * A parser that keeps `id:` and `event:`. A frame with no `data:` line (a
 * keepalive comment) gives nothing. A frame with bad JSON is dropped, as in
 * {@link createSseJsonParser}.
 */
export function createSseEventParser<T = unknown>(): { push(chunk: string): SseEventFrame<T>[] } {
  let buffer = '';
  return {
    push(chunk: string): SseEventFrame<T>[] {
      buffer += chunk;
      const out: SseEventFrame<T>[] = [];
      let sep: number;
      while ((sep = buffer.indexOf(FRAME_SEPARATOR)) !== -1) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + FRAME_SEPARATOR.length);
        let id: string | undefined;
        let event: string | undefined;
        let data: string | undefined;
        for (const line of frame.split('\n')) {
          if (line.startsWith('id: ')) id = line.slice(4);
          else if (line.startsWith('event: ')) event = line.slice(7);
          else if (line.startsWith(DATA_PREFIX)) data = line.slice(DATA_PREFIX.length);
        }
        if (data === undefined) continue;
        try {
          out.push({
            ...(id !== undefined ? { id } : {}),
            ...(event !== undefined ? { event } : {}),
            data: JSON.parse(data) as T,
          });
        } catch {
          // A bad frame is a gap, not a failure.
        }
      }
      return out;
    },
  };
}
