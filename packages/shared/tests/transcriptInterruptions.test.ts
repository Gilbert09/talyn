import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../src/index.js';
import { claudePromptText, claudeSessionToEvents } from '../src/claudeSessionImport.js';
import { buildBlocks, isClaudeInterruptionText, mergeToolBlocks } from '../src/transcript.js';

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
