import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../src/index.js';
import { buildBlocks, groupToolRuns, mergeToolBlocks, mergedBlockSignature, subagentCardModel, type ToolBlock } from '../src/transcript.js';

const call = (id: string, name = 'Agent') => ({ type: 'tool_use', id, name, input: {} });
const assistant = (seq: number, content: unknown[], parent?: string): AgentEvent => ({
  seq, type: 'assistant', message: { content }, ...(parent ? { parent_tool_use_id: parent } : {}),
});
const tool = (patch: Partial<ToolBlock> = {}): ToolBlock => ({
  kind: 'tool', key: '1.0', toolId: 'agent-1', name: 'Agent', input: {}, isError: false, settled: false, stopped: false, ...patch,
});

describe('subagent progress', () => {
  it('counts assistant tool blocks and keeps the latest label for each parent', () => {
    const blocks = buildBlocks([
      assistant(1, [call('agent-1'), call('agent-2', 'Task'), call('ordinary', 'Read')]),
      assistant(2, [call('read', 'Read'), call('search', 'Grep')], 'agent-1'),
      assistant(3, [call('write', 'Write')], 'agent-2'),
      assistant(4, [{ type: 'text', text: 'Hidden answer' }], 'agent-1'),
      { seq: 5, type: 'user', parent_tool_use_id: 'agent-1', message: { content: [call('ignored', 'Read')] } },
      { seq: 6, type: 'stream_event', parent_tool_use_id: 'agent-1', event: { type: 'content_block_start', content_block: call('search', 'Grep') } },
      assistant(7, [call('nested', 'Read')], 'ordinary'),
    ]);
    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toMatchObject({ subagent: { steps: 2, current: 'grep' } });
    expect(blocks[1]).toMatchObject({ subagent: { steps: 1, current: 'write' } });
    expect(blocks[2]).not.toHaveProperty('subagent');
    const merged = mergeToolBlocks(blocks);
    expect(merged[0]).toMatchObject({ subagent: { steps: 2, current: 'grep' } });
    expect(merged[1]).toMatchObject({ subagent: { steps: 1, current: 'write' } });
    expect(merged[2]).not.toHaveProperty('subagent');
  });

  it('changes the render signature when progress changes', () => {
    const first = tool({ subagent: { steps: 1, current: 'read' } });
    expect(mergedBlockSignature(first)).not.toBe(mergedBlockSignature(tool({ subagent: { steps: 2, current: 'read' } })));
    expect(mergedBlockSignature(first)).not.toBe(mergedBlockSignature(tool({ subagent: { steps: 1, current: 'grep' } })));
  });

  it('keeps agent cards outside groups of ordinary tools', () => {
    const ordinary = tool({ name: 'Read' });
    expect(groupToolRuns([ordinary, ordinary, tool(), tool(), ordinary]).map((block) => block.kind))
      .toEqual(['tool_group', 'tool', 'tool', 'tool']);
  });
});

describe('subagent card model', () => {
  it.each(['Agent', 'Task', 'subagent', 'dispatchagent'])('supports %s and text part results', (name) => {
    expect(subagentCardModel(tool({ name, input: { subagent_type: 'Explore', description: 'Find the entry', prompt: 'Read **the code**.' },
      output: [{ type: 'text', text: 'First' }, { type: 'text', text: 'Second' }], settled: true })))
      .toMatchObject({ type: 'Explore', title: 'Find the entry', brief: 'Read **the code**.', result: 'First\n\nSecond', running: false, failed: false });
  });

  it.each(['Read', 'Bash', 'mcp__search'])('returns null for %s', (name) => {
    expect(subagentCardModel(tool({ name }))).toBeNull();
  });

  it.each([undefined, null, {}, { subagent_type: 1, description: false, prompt: null }])('handles missing or invalid input %j', (input) => {
    expect(subagentCardModel(tool({ input }))).toMatchObject({ type: 'Subagent', title: '', brief: '', result: null, stepsLabel: 'Starting…' });
  });

  it('uses the first trimmed prompt line when there is no title', () => {
    expect(subagentCardModel(tool({ input: { description: ' ', prompt: '\n  Find the file  \nThen read it.' } }))?.title).toBe('Find the file');
  });

  it.each([
    [false, false, 0, undefined, 'Starting…'],
    [false, false, 1, 'read', '1 step · read'],
    [false, false, 12, 'grep', '12 steps · grep'],
    [false, false, 2, undefined, '2 steps'],
    [true, false, 0, undefined, 'Finished · 0 steps'],
    [true, false, 1, 'read', 'Finished · 1 step'],
    [true, false, 23, 'read', 'Finished · 23 steps'],
    [true, true, 0, undefined, 'Failed · 0 steps'],
    [true, true, 1, 'read', 'Failed · 1 step'],
    [true, true, 12, 'read', 'Failed · 12 steps'],
  ])('labels settled=%s, failed=%s, steps=%s', (settled, isError, steps, current, stepsLabel) => {
    expect(subagentCardModel(tool({ settled, isError, subagent: { steps, current } })))
      .toMatchObject({ stepsLabel, running: !settled, failed: settled && isError });
  });
});

describe('subagent step label', () => {
  it('names the file a subagent step works on, by its last path segment', () => {
    const blocks = buildBlocks([
      { seq: 1, type: 'assistant', message: { content: [call('agent-1')] } },
      { seq: 2, type: 'assistant', parent_tool_use_id: 'agent-1',
        message: { content: [{ type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: '/work/repo/products/destinations/contracts.py' } }] } },
    ] as never);
    expect(blocks[0]).toMatchObject({ subagent: { steps: 1, current: 'read contracts.py' } });
  });
});
