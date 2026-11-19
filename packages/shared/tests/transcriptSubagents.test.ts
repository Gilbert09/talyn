import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../src/index.js';
import { createClaudeStreamParser } from '../src/agentStream.js';
import { claudePromptText, claudeSessionToEvents } from '../src/claudeSessionImport.js';
import { buildBlocks, isSubagentEvent } from '../src/transcript.js';

const event = (seq: number, type: string, content: unknown, nested = true): AgentEvent => ({
  seq,
  type,
  ...(type === 'stream_event' ? { event: content } : { message: { content } }),
  ...(nested ? { parent_tool_use_id: 'agent-1' } : {}),
});

describe('subagent transcript events', () => {
  it('passes nested events through without changing main agent state', () => {
    const parser = createClaudeStreamParser();
    const nested = { type: 'assistant', parent_tool_use_id: 'agent-1', message: {
      usage: { input_tokens: 100 }, content: [{ type: 'tool_use', name: 'TodoWrite', input: { todos: [{ content: 'Nested', status: 'pending' }] } }],
    } };
    expect(parser.push(JSON.stringify(nested))).toEqual([nested]);
    expect(parser.todos).toBeNull();
    expect(parser.contextUsage).toBeNull();
  });

  it('does not import nested prompts as turns', () => {
    const nested = { type: 'user', parent_tool_use_id: 'agent-1', message: { content: 'Research this' } };
    expect(claudePromptText(nested)).toBeNull();
    const imported = claudeSessionToEvents([
      JSON.stringify({ type: 'user', message: { content: 'Start' } }),
      JSON.stringify(nested),
      JSON.stringify({ type: 'assistant', parent_tool_use_id: 'agent-1', message: { content: [{ type: 'text', text: 'Nested answer' }] } }),
    ]);
    expect(imported.turns).toBe(1);
    expect(imported.events).toHaveLength(1);
  });

  it('ignores a subagent prompt, assistant text, and tool call', () => {
    const events = [
      event(1, 'user', [{ type: 'text', text: 'Research this' }]),
      event(2, 'assistant', [{ type: 'text', text: 'Researching' }]),
      event(3, 'assistant', [{ type: 'tool_use', id: 'nested-tool', name: 'Read', input: {} }]),
    ];
    expect(events.every(isSubagentEvent)).toBe(true);
    expect(buildBlocks(events)).toEqual([]);
  });

  it('keeps the main Agent call and its result', () => {
    const blocks = buildBlocks([
      event(1, 'assistant', [{ type: 'tool_use', id: 'agent-1', name: 'Agent', input: { prompt: 'Research this' } }], false),
      event(2, 'user', [{ type: 'text', text: 'Research this' }]),
      event(3, 'assistant', [{ type: 'text', text: 'Found an answer' }]),
      event(4, 'user', [{ type: 'tool_result', tool_use_id: 'agent-1', content: 'Answer' }], false),
    ]);
    expect(blocks).toEqual([
      { kind: 'tool_use', key: '1.0', toolId: 'agent-1', name: 'Agent', input: { prompt: 'Research this' } },
      { kind: 'tool_result', key: '4.0', toolId: 'agent-1', content: 'Answer', isError: false, stopped: false,
        toolName: 'Agent', toolInput: { prompt: 'Research this' } },
    ]);
  });

  it('keeps an open interruption across a nested assistant event', () => {
    const marker = '[Request interrupted by user]';
    expect(buildBlocks([
      event(1, 'user', [{ type: 'text', text: marker }], false),
      event(2, 'assistant', [{ type: 'text', text: 'Nested' }]),
      event(3, 'user', [{ type: 'text', text: marker }], false),
    ])).toEqual([{ kind: 'system', key: '1.interrupted', text: 'Interrupted', subtype: 'talyn_interruption' }]);
  });

  it('keeps the main stream across nested stream and assistant events', () => {
    expect(buildBlocks([
      event(1, 'stream_event', { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Main ' } }, false),
      event(2, 'stream_event', { type: 'message_start', message: { id: 'nested' } }),
      event(3, 'stream_event', { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Nested' } }),
      event(4, 'assistant', [{ type: 'text', text: 'Nested final' }]),
      event(5, 'stream_event', { type: 'content_block_delta', delta: { type: 'text_delta', text: 'answer' } }, false),
    ])).toEqual([{ kind: 'text', key: 'stream-live', text: 'Main answer' }]);
  });
});
