import { describe, it, expect } from 'vitest';
import {
  isManagedSessionTerminal,
  isManagedRunSuccess,
} from '../services/claudeCode/poller.js';

describe('isManagedSessionTerminal', () => {
  it('is NOT terminal while running', () => {
    expect(isManagedSessionTerminal({ status: 'running', stop_reason: { type: 'end_turn' } })).toBe(false);
  });

  it('is NOT terminal for a not-yet-started session (idle, no stop_reason)', () => {
    expect(isManagedSessionTerminal({ status: 'idle' })).toBe(false);
    expect(isManagedSessionTerminal({ status: 'idle', stop_reason: null })).toBe(false);
  });

  it('is NOT terminal while paused mid-turn (vendor resumes pause_turn itself)', () => {
    expect(isManagedSessionTerminal({ status: 'idle', stop_reason: { type: 'pause_turn' } })).toBe(false);
  });

  // The regression: a finished run idle with ANY real stop_reason must finalize,
  // not just `end_turn` — that narrow check left runs stuck `in_progress`.
  it.each(['end_turn', 'stop_sequence', 'max_tokens', 'refusal', 'tool_use', 'something_new'])(
    'is terminal when idle with stop_reason %s',
    (type) => {
      expect(isManagedSessionTerminal({ status: 'idle', stop_reason: { type } })).toBe(true);
    },
  );
});

describe('isManagedRunSuccess', () => {
  it('succeeds when a PR was opened, regardless of stop reason', () => {
    expect(isManagedRunSuccess('max_tokens', true)).toBe(true);
    expect(isManagedRunSuccess('refusal', true)).toBe(true);
    expect(isManagedRunSuccess(null, true)).toBe(true);
  });

  it('succeeds on a normal stop with no PR (nothing to do is still success)', () => {
    expect(isManagedRunSuccess('end_turn', false)).toBe(true);
    expect(isManagedRunSuccess('stop_sequence', false)).toBe(true);
  });

  it('fails on an abnormal stop with no PR', () => {
    expect(isManagedRunSuccess('max_tokens', false)).toBe(false);
    expect(isManagedRunSuccess('refusal', false)).toBe(false);
    expect(isManagedRunSuccess(null, false)).toBe(false);
  });
});
