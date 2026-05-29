import { describe, it, expect } from 'vitest';
import { AcpConverter, type AcpLogEntry } from '../services/posthogCode/acpConverter.js';
import { parseSseFrame } from '../services/posthogCode/streamer.js';

// Helpers to build ACP entries tersely.
function sessionUpdate(update: Record<string, unknown>): AcpLogEntry {
  return { type: 'notification', notification: { method: 'session/update', params: { update } } };
}
function posthog(method: string, params: Record<string, unknown>): AcpLogEntry {
  return { type: 'notification', notification: { method: `_posthog/${method}`, params } };
}

describe('AcpConverter — agent text streaming', () => {
  it('streams text chunks as message_start + deltas, then finalises on flush', () => {
    const c = new AcpConverter();
    const a = c.push(sessionUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello ' } }));
    const b = c.push(sessionUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'world' } }));
    const done = c.flush();

    // First chunk: message_start then a text_delta. Second chunk: one more delta.
    expect(a.map((e) => e.type)).toEqual(['stream_event', 'stream_event']);
    expect((a[0].event as { type: string }).type).toBe('message_start');
    expect((a[1].event as { delta: { text: string } }).delta.text).toBe('Hello ');
    expect(b).toHaveLength(1);
    expect((b[0].event as { delta: { text: string } }).delta.text).toBe('world');

    // flush emits the canonical assistant event with the full text and the
    // SAME message id the deltas were tagged with, so the renderer clears
    // its streaming tail.
    expect(done).toHaveLength(1);
    expect(done[0].type).toBe('assistant');
    const msg = done[0].message as { id: string; content: Array<{ type: string; text: string }> };
    const startId = (a[0].event as { message: { id: string } }).message.id;
    expect(msg.id).toBe(startId);
    expect(msg.content).toEqual([{ type: 'text', text: 'Hello world' }]);
  });

  it('maps a full agent_message to a single assistant text event on push (no deltas)', () => {
    const c = new AcpConverter();
    const out = c.push(sessionUpdate({ sessionUpdate: 'agent_message', content: { type: 'text', text: 'Done.' } }));
    // A full (non-chunk) message is complete — it lands immediately as a
    // settled assistant event with no live stream_events.
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe('assistant');
    expect(c.flush()).toEqual([]);
    const content = (out[0].message as { content: Array<{ text: string }> }).content;
    expect(content[0].text).toBe('Done.');
  });

  it('flush is a no-op when there is no active stream or only empty text', () => {
    const c = new AcpConverter();
    expect(c.flush()).toEqual([]);
    c.push(sessionUpdate({ sessionUpdate: 'agent_message_chunk', content: { text: '' } }));
    expect(c.flush()).toEqual([]);
  });
});

describe('AcpConverter — thinking', () => {
  it('accumulates thought chunks into an assistant thinking block on flush', () => {
    const c = new AcpConverter();
    c.push(sessionUpdate({ sessionUpdate: 'agent_thought_chunk', content: { text: 'Let me ' } }));
    const live = c.push(sessionUpdate({ sessionUpdate: 'agent_thought_chunk', content: { text: 'think.' } }));
    // No live stream_events for thinking (renderer has no thinking delta path).
    expect(live).toEqual([]);
    const done = c.flush();
    expect(done).toHaveLength(1);
    const content = (done[0].message as { content: Array<{ type: string; thinking: string }> }).content;
    expect(content[0]).toEqual({ type: 'thinking', thinking: 'Let me think.' });
  });

  it('switching from text to thinking flushes the text block first', () => {
    const c = new AcpConverter();
    c.push(sessionUpdate({ sessionUpdate: 'agent_message_chunk', content: { text: 'hi' } }));
    const out = c.push(sessionUpdate({ sessionUpdate: 'agent_thought_chunk', content: { text: 'hmm' } }));
    // The kind switch finalises the pending text as an assistant event.
    const assistant = out.find((e) => e.type === 'assistant');
    expect(assistant).toBeDefined();
    const content = (assistant!.message as { content: Array<{ type: string; text: string }> }).content;
    expect(content[0]).toEqual({ type: 'text', text: 'hi' });
  });
});

describe('AcpConverter — tool calls', () => {
  it('maps tool_call to an assistant tool_use, flushing pending text first', () => {
    const c = new AcpConverter();
    c.push(sessionUpdate({ sessionUpdate: 'agent_message_chunk', content: { text: 'Running ls' } }));
    const out = c.push(
      sessionUpdate({ sessionUpdate: 'tool_call', toolCallId: 'call-1', title: 'Bash', rawInput: { command: 'ls' } }),
    );
    const types = out.map((e) => e.type);
    expect(types).toContain('assistant');
    const toolUseEvent = out[out.length - 1];
    const block = (toolUseEvent.message as { content: Array<{ type: string; id: string; name: string; input: unknown }> }).content[0];
    expect(block).toEqual({ type: 'tool_use', id: 'call-1', name: 'Bash', input: { command: 'ls' } });
  });

  it.each([
    ['completed', false],
    ['failed', true],
    ['error', true],
  ])('maps a %s tool_call_update to a user tool_result (is_error=%s)', (status, isError) => {
    const c = new AcpConverter();
    const out = c.push(
      sessionUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status, rawOutput: 'file.txt' }),
    );
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe('user');
    const block = (out[0].message as { content: Array<{ type: string; tool_use_id: string; content: string; is_error: boolean }> }).content[0];
    expect(block).toEqual({ type: 'tool_result', tool_use_id: 'call-1', content: 'file.txt', is_error: isError });
  });

  it('ignores intermediate (in_progress) tool_call_updates', () => {
    const c = new AcpConverter();
    expect(c.push(sessionUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 'x', status: 'in_progress' }))).toEqual([]);
  });

  it('stringifies object tool output', () => {
    const c = new AcpConverter();
    const out = c.push(sessionUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 'c', status: 'completed', rawOutput: { rows: 2 } }));
    const block = (out[0].message as { content: Array<{ content: string }> }).content[0];
    expect(block.content).toBe('{"rows":2}');
  });
});

describe('AcpConverter — _posthog side channels', () => {
  it.each([
    ['warn', true],
    ['error', true],
    ['info', false],
    ['debug', false],
  ])('console level %s surfaced=%s', (level, surfaced) => {
    const c = new AcpConverter();
    const out = c.push(posthog('console', { level, message: 'msg' }));
    if (surfaced) {
      expect(out).toHaveLength(1);
      expect(out[0].type).toBe('system');
      expect(out[0].subtype).toBe('stderr');
      expect((out[0] as { text: string }).text).toBe(`${level}: msg`);
    } else {
      expect(out).toEqual([]);
    }
  });

  it('emits system events for sandbox stdout and stderr', () => {
    const c = new AcpConverter();
    const out = c.push(posthog('sandbox_output', { stdout: 'out', stderr: 'err' }));
    expect(out.map((e) => (e as { text: string }).text)).toEqual(['out', 'err']);
    expect(out.every((e) => e.type === 'system')).toBe(true);
  });

  it('maps _posthog/error to a system event', () => {
    const c = new AcpConverter();
    const out = c.push(posthog('error', { message: 'boom' }));
    expect(out).toHaveLength(1);
    expect((out[0] as { text: string }).text).toBe('error: boom');
  });

  it('turn_complete flushes the active block', () => {
    const c = new AcpConverter();
    c.push(sessionUpdate({ sessionUpdate: 'agent_message_chunk', content: { text: 'partial' } }));
    const out = c.push(posthog('turn_complete', {}));
    expect(out.some((e) => e.type === 'assistant')).toBe(true);
  });
});

describe('AcpConverter — robustness', () => {
  it('ignores entries with no method or unknown methods', () => {
    const c = new AcpConverter();
    expect(c.push({})).toEqual([]);
    expect(c.push({ notification: {} })).toEqual([]);
    expect(c.push({ notification: { method: 'session/new', params: {} } })).toEqual([]);
    expect(c.push(sessionUpdate({ sessionUpdate: 'available_commands_update' }))).toEqual([]);
  });

  it.each([
    ['string content', 'plain'],
    ['object content', { type: 'text', text: 'plain' }],
    ['array content', [{ type: 'text', text: 'pl' }, { type: 'text', text: 'ain' }]],
  ])('extracts text from %s', (_label, content) => {
    const c = new AcpConverter();
    const out = c.push(sessionUpdate({ sessionUpdate: 'agent_message', content }));
    const text = (out[0].message as { content: Array<{ text: string }> }).content[0].text;
    expect(text).toBe('plain');
  });

  it('emits a user text block for user_message, flushing agent text first', () => {
    const c = new AcpConverter();
    c.push(sessionUpdate({ sessionUpdate: 'agent_message_chunk', content: { text: 'agent says' } }));
    const out = c.push(sessionUpdate({ sessionUpdate: 'user_message', content: { text: 'hi' } }));
    expect(out.find((e) => e.type === 'assistant')).toBeDefined();
    const user = out.find((e) => e.type === 'user');
    expect((user!.message as { content: Array<{ text: string }> }).content[0].text).toBe('hi');
  });
});

describe('parseSseFrame', () => {
  it('parses event, id, and a single data line', () => {
    expect(parseSseFrame('event: keepalive\ndata: {"type":"keepalive"}')).toEqual({
      eventName: 'keepalive',
      eventId: '',
      data: '{"type":"keepalive"}',
    });
  });

  it('joins multiple data lines with newlines and captures the id', () => {
    const frame = 'id: 1700-0\ndata: {"a":1,\ndata: "b":2}';
    const { eventName, eventId, data } = parseSseFrame(frame);
    expect(eventName).toBe('');
    expect(eventId).toBe('1700-0');
    expect(data).toBe('{"a":1,\n"b":2}');
    expect(JSON.parse(data)).toEqual({ a: 1, b: 2 });
  });

  it('strips only a single leading space after data:', () => {
    expect(parseSseFrame('data:  two-spaces').data).toBe(' two-spaces');
  });
});
