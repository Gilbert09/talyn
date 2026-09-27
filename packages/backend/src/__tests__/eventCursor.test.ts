import { describe, it, expect } from 'vitest';
import type { AgentEvent } from '@talyn/shared';
import { assistantText, finalTextFromEvents, toAgentEvent } from '../services/selfHosted/eventCursor.js';

/**
 * "What did the agent finally say?"
 *
 * The case that matters most here is a REGRESSION, and it is worth naming
 * because it cost a whole feature's worth of runs. fleetd appends its own
 * terminal `result` event whose string describes the RUN — `the harness
 * completed the task (61 agent turn(s))` — and not one word the agent wrote.
 * That event is necessarily last, so a reader that preferred `result` never
 * looked at the message before it: every code review settled `unparseable`
 * whatever the agent produced, and a fleet run standing down with
 * `TALYN_NEEDS_HUMAN:` had its sentinel shadowed the same way.
 *
 * The rule these pin: the agent's own words win; `result` answers only when the
 * agent said nothing at all.
 */

const assistant = (text: string): AgentEvent =>
  ({ type: 'assistant', message: { content: [{ type: 'text', text }] } }) as unknown as AgentEvent;

const toolResult = (): AgentEvent =>
  ({ type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } }) as unknown as AgentEvent;

const result = (text: string): AgentEvent =>
  ({ type: 'result', result: text }) as unknown as AgentEvent;

/** Verbatim from the incident: three lenses, three sandboxes, this every time. */
const FLEETD_SUMMARY = 'the harness completed the task (61 agent turn(s))';

describe('finalTextFromEvents', () => {
  it("does not let fleetd's run summary shadow the agent's final message", () => {
    const events = [
      assistant('Let me look at the diff.'),
      toolResult(),
      assistant('Found three things.\n\nTALYN_REVIEW_FINDINGS:\n```json\n{"schema":1,"findings":[]}\n```'),
      result(FLEETD_SUMMARY),
    ];
    const text = finalTextFromEvents(events);
    expect(text).toContain('TALYN_REVIEW_FINDINGS:');
    expect(text).not.toBe(FLEETD_SUMMARY);
  });

  it('still answers with result when the agent never said anything', () => {
    // The SDK path, and the genuinely silent run. Dropping `result` entirely
    // would trade one blind spot for another.
    expect(finalTextFromEvents([toolResult(), result('the agent produced no output')])).toBe(
      'the agent produced no output'
    );
  });

  it('prefers the agent even when several result events follow it', () => {
    const events = [assistant('the real answer'), result('summary one'), result('summary two')];
    expect(finalTextFromEvents(events)).toBe('the real answer');
  });

  it('takes the LAST thing the agent said, not the first', () => {
    expect(finalTextFromEvents([assistant('early'), toolResult(), assistant('late')])).toBe('late');
  });

  it('skips an assistant turn that was only a tool call', () => {
    const toolOnly = {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'read', input: {} }] },
    } as unknown as AgentEvent;
    expect(finalTextFromEvents([assistant('the words'), toolOnly])).toBe('the words');
  });

  it.each([
    ['an empty log', [] as AgentEvent[]],
    ['a log with nothing quotable in it', [toolResult()]],
  ])('answers null for %s, which means UNKNOWN and never "found nothing"', (_label, events) => {
    // Load-bearing for the review pipeline: null is a failed unit, not a clean
    // bill of health. Inverting it turns a broken agent into a passing review.
    expect(finalTextFromEvents(events)).toBeNull();
  });
});

describe('assistantText', () => {
  it('joins every text block, so a marker split across blocks survives', () => {
    const event = {
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'TALYN_REVIEW' }, { type: 'text', text: '_FINDINGS:' }] },
    } as unknown as AgentEvent;
    expect(assistantText(event)).toBe('TALYN_REVIEW_FINDINGS:');
  });

  it('ignores non-text blocks and answers null when nothing is prose', () => {
    const event = {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'bash', input: {} }] },
    } as unknown as AgentEvent;
    expect(assistantText(event)).toBeNull();
  });
});

describe('toAgentEvent', () => {
  it("unwraps the fleet's envelope so the payload sits at the top level", () => {
    const unwrapped = toAgentEvent({
      seq: 7,
      event: { type: 'assistant', subtype: '', raw: { type: 'assistant', message: { content: [] } } },
    } as never);
    expect(unwrapped.seq).toBe(7);
    expect(unwrapped.message).toEqual({ content: [] });
  });

  it('passes an unwrapped event straight through, for an older fleet', () => {
    const unwrapped = toAgentEvent({ seq: 2, event: { type: 'result', result: 'x' } } as never);
    expect(unwrapped.type).toBe('result');
  });
});
