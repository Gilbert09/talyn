import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../src/index.js';
import { claudePromptText, claudeSessionToEvents } from '../src/claudeSessionImport.js';
import { TURN_ENDED_WITH_OPEN_TOOL_NOTE, buildBlocks, isClaudeInterruptionText, mergeToolBlocks } from '../src/transcript.js';

const rejection = "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.";

const user = (seq: number, text: string): AgentEvent => ({
  seq, type: 'user', message: { role: 'user', content: [{ type: 'text', text }] },
});

const tool = (seq: number): AgentEvent => ({
  seq, type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tool-1', name: 'Edit', input: { file_path: 'a.ts' } }] },
});

const result = (seq: number, content: unknown, isError = true): AgentEvent => ({
  seq, type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content, is_error: isError }] },
});

describe('Claude Code interruption markers', () => {
  it.each(['[Request interrupted by user]', '[Request interrupted by user for tool use]'])(
    'shows one quiet line for the live marker %s', (marker) => {
      const blocks = buildBlocks([user(1, marker), user(2, marker)]);
      expect(blocks).toEqual([{ kind: 'system', key: '1.interrupted', text: 'Interrupted', subtype: 'talyn_interruption' }]);
    },
  );

  it('settles a rejected live tool without the canned error and collapses the following marker', () => {
    const blocks = buildBlocks([tool(1), result(2, rejection), user(3, '[Request interrupted by user for tool use]')]);
    const merged = mergeToolBlocks(blocks);
    expect(merged.filter((block) => block.kind === 'system')).toHaveLength(1);
    expect(merged[0]).toMatchObject({ kind: 'tool', name: 'Edit', settled: true, stopped: true, isError: false, output: '' });
    expect(JSON.stringify(merged)).not.toContain(rejection);
  });

  it('keeps unrelated user text and real tool errors', () => {
    const message = 'I saw [Request interrupted by user] in the log.';
    expect(isClaudeInterruptionText(message)).toBe(false);
    expect(claudePromptText({ type: 'user', message: { content: message } })).toBe(message);
    const imported = claudeSessionToEvents([JSON.stringify({ type: 'user', message: { content: message } })]);
    expect(imported.turns).toBe(1);
    expect(imported.events[0].event).toMatchObject({
      type: 'user', message: { content: [{ type: 'text', text: message }] },
    });
    expect(buildBlocks([result(1, rejection, false)])[0]).toMatchObject({ kind: 'tool_result', isError: false, stopped: false, content: rejection });
    expect(buildBlocks([result(1, 'Permission denied')])[0]).toMatchObject({ kind: 'tool_result', isError: true, stopped: false });
  });

  it.each(['[Request interrupted by user]', '[Request interrupted by user for tool use]'])(
    'imports %s without adding a user turn', (marker) => {
      const lines = [
        { type: 'user', message: { content: 'Please edit a.ts' } },
        { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool-1', name: 'Edit', input: { file_path: 'a.ts' } }] } },
        { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: rejection, is_error: true }] } },
        { type: 'user', message: { content: marker } },
        { type: 'user', message: { content: marker } },
      ];
      const imported = claudeSessionToEvents(lines.map((line) => JSON.stringify(line)));
      expect(imported.turns).toBe(1);
      const blocks = mergeToolBlocks(buildBlocks(imported.events.map(({ event }, i) => ({ ...event, seq: i + 1 } as AgentEvent))));
      expect(blocks.filter((block) => block.kind === 'system')).toHaveLength(1);
      expect(blocks.find((block) => block.kind === 'tool')).toMatchObject({ stopped: true, isError: false, output: '' });
    },
  );
});

describe('a turn that ends with a tool call still open', () => {
  const init = (seq: number, agent?: string): AgentEvent =>
    ({ seq, type: 'system', subtype: 'init', ...(agent ? { agent } : {}) }) as AgentEvent;
  const runResult = (seq: number, isError = false): AgentEvent =>
    ({ seq, type: 'result', subtype: isError ? 'error_during_execution' : 'success', is_error: isError, result: 'Waiting for the agent.' }) as AgentEvent;
  const notes = (events: AgentEvent[]) =>
    buildBlocks(events).filter((block) => block.kind === 'system' && block.text === TURN_ENDED_WITH_OPEN_TOOL_NOTE);

  it.each<{ name: string; events: AgentEvent[]; expected: number }>([
    { name: 'a Claude run with an open call', events: [init(1), tool(2), runResult(3)], expected: 1 },
    { name: 'a run with no init event', events: [tool(1), runResult(2)], expected: 1 },
    { name: 'a run whose call has a result', events: [init(1), tool(2), result(3, 'ok', false), runResult(4)], expected: 0 },
    { name: 'a run with no tool calls', events: [init(1), runResult(2)], expected: 0 },
    { name: 'an error result (a stop or a lost sandbox)', events: [init(1), tool(2), runResult(3, true)], expected: 0 },
    { name: 'a Codex run', events: [init(1, 'codex'), tool(2), runResult(3)], expected: 0 },
    { name: 'a Claude run after a Codex run', events: [init(1, 'codex'), runResult(2), init(3), tool(4), runResult(5)], expected: 1 },
    { name: 'a call left open in an earlier run', events: [init(1), tool(2), init(3), runResult(4)], expected: 0 },
    { name: 'two results for one open call', events: [init(1), tool(2), runResult(3), runResult(4)], expected: 1 },
  ])('$name: $expected note(s)', ({ events, expected }) => {
    expect(notes(events)).toHaveLength(expected);
  });

  it('places the note before the result, and the next turn still shows the interruption', () => {
    const blocks = buildBlocks([
      init(1), tool(2), runResult(3),
      user(4, 'Continue'),
      init(5), result(6, rejection), user(7, '[Request interrupted by user for tool use]'),
    ]);
    expect(blocks.map((block) => block.kind === 'system' ? block.text : block.kind)).toEqual([
      'tool_use', TURN_ENDED_WITH_OPEN_TOOL_NOTE, 'result', 'tool_result', 'Interrupted',
    ]);
    expect(blocks[1]).toEqual({ kind: 'system', key: '3.open', text: TURN_ENDED_WITH_OPEN_TOOL_NOTE });
  });
});

describe('thread transcript cards', () => {
  it('shows why automatic thread turns paused', () => {
    const blocks = buildBlocks([{
      seq: 1,
      type: 'talyn_thread',
      action: 'paused',
      sessionId: 'session-1',
      name: 'api',
      repo: 'acme/api',
      status: 'idle',
    } as AgentEvent]);
    expect(blocks).toEqual([expect.objectContaining({
      kind: 'system',
      subtype: 'talyn_thread',
      text: 'The thread stopped waking itself because its sessions made no progress since its last turn. It waits for the person.',
      thread: expect.objectContaining({ action: 'paused' }),
    })]);
  });
});
