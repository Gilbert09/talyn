import { describe, it, expect } from 'vitest';
import { lastFlowEventIsTurnComplete } from '../services/posthogCode/poller.js';
import type { AcpLogEntry } from '../services/posthogCode/acpConverter.js';

const note = (method: string, update?: Record<string, unknown>): AcpLogEntry => ({
  type: 'notification',
  notification: { method, params: update ? { update } : {} },
});
const su = (sessionUpdate: string): AcpLogEntry => note('session/update', { sessionUpdate });

describe('lastFlowEventIsTurnComplete', () => {
  it('returns true when the tail ends on turn_complete (skipping trailing keepalives)', () => {
    // Mirrors a real idle tail: agent_message → usage → turn_complete →
    // later lone console heartbeats.
    const entries = [
      su('agent_message'),
      su('usage_update'),
      note('_posthog/usage_update'),
      note('_posthog/turn_complete'),
      note('_posthog/console'),
      note('_posthog/console'),
    ];
    expect(lastFlowEventIsTurnComplete(entries)).toBe(true);
  });

  it('returns true for task_complete', () => {
    expect(lastFlowEventIsTurnComplete([su('agent_message'), note('_posthog/task_complete')])).toBe(true);
  });

  it('returns false when the last real event is an in-flight tool call', () => {
    // A long silent tool: tool_call then streaming rawInput updates, no end.
    const entries = [
      note('_posthog/turn_complete'), // an earlier turn ended…
      su('tool_call'),
      su('tool_call_update'), // …but a new tool is mid-flight
      note('_posthog/console'),
    ];
    expect(lastFlowEventIsTurnComplete(entries)).toBe(false);
  });

  it('returns false when the agent stalled mid-message (no turn_complete)', () => {
    expect(lastFlowEventIsTurnComplete([su('tool_call_update'), su('agent_message')])).toBe(false);
  });

  it('returns false when the tail errored', () => {
    expect(lastFlowEventIsTurnComplete([note('_posthog/turn_complete'), su('tool_call'), note('_posthog/error')])).toBe(false);
  });

  it('returns false for an empty or marker-less tail', () => {
    expect(lastFlowEventIsTurnComplete([])).toBe(false);
    expect(lastFlowEventIsTurnComplete([note('_posthog/console'), note('_posthog/progress')])).toBe(false);
  });
});
