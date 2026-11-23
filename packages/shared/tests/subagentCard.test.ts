import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../src/index.js';
import { buildBlocks, groupToolRuns, mergeToolBlocks, mergedBlockSignature, runningSubagentCount, subagentCardModel, type ToolBlock } from '../src/transcript.js';

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

describe('subagent card details', () => {
  const at = '2026-11-19T12:00:00Z';
  const progress = (patch: Partial<AgentEvent> = {}): AgentEvent => ({ seq: 3, type: 'system', subtype: 'task_progress',
    tool_use_id: 'agent-1', description: 'Checking imports', usage: { total_tokens: 1234, tool_uses: 4, duration_ms: 2300 }, ...patch });
  const card = (events: AgentEvent[]): ToolBlock => mergeToolBlocks(buildBlocks(events))[0] as ToolBlock;

  it('keeps nested tools, text and stream tails inside their own card', () => {
    const parent = card([
      assistant(1, [call('agent-1'), call('agent-2')]),
      assistant(2, [call('nested', 'Read'), { type: 'text', text: 'First answer' }], 'agent-1'),
      { seq: 3, type: 'user', parent_tool_use_id: 'agent-1', message: { content: [{ type: 'tool_result', tool_use_id: 'nested', content: 'File content' }] } },
      { seq: 4, type: 'stream_event', parent_tool_use_id: 'agent-1', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Live answer' } } },
      assistant(5, [{ type: 'text', text: 'Other answer' }], 'agent-2'),
    ]);
    expect(subagentCardModel(parent, true)?.children).toMatchObject([
      { kind: 'tool', name: 'Read', output: 'File content', settled: true },
      { kind: 'text', text: 'First answer' }, { kind: 'text', text: 'Live answer' },
    ]);
    expect(subagentCardModel(parent, false)?.children).toEqual([]);
  });

  it('uses the same card for deeper Agent calls and rejects cycles', () => {
    const events = [assistant(1, [call('agent-1')]), assistant(2, [call('agent-2')], 'agent-1'),
      assistant(3, [call('agent-1')], 'agent-2')];
    const children = subagentCardModel(card(events), true)?.children;
    expect(children?.[0]).toMatchObject({ kind: 'tool', name: 'Agent', subagent: { steps: 1 } });
    expect(() => JSON.stringify(children)).not.toThrow();
  });

  it.each([true, false])('gates task details and nested steps, enabled=%s', (enabled) => {
    const parent = card([assistant(1, [call('agent-1')]), assistant(2, [call('read', 'Read')], 'agent-1'), progress()]);
    expect(subagentCardModel(parent, enabled)).toMatchObject({
      stepsLabel: enabled ? '4 tools · Checking imports' : '1 step · read',
      detailsLabel: enabled ? '1,234 tokens · 2s' : undefined,
    });
  });

  it.each([undefined, {}, { total_tokens: -1, tool_uses: '4', duration_ms: NaN }])('keeps the step fallback with usage %j', (usage) => {
    const parent = card([assistant(1, [call('agent-1')]), assistant(2, [call('read', 'Read')], 'agent-1'), progress({ usage })]);
    expect(subagentCardModel(parent, true)).toMatchObject({ stepsLabel: '1 step · Checking imports', detailsLabel: '' });
  });

  it('keeps the base step count with no task events', () => {
    const parent = card([assistant(1, [call('agent-1')]), assistant(2, [call('read', 'Read')], 'agent-1')]);
    expect(subagentCardModel(parent, true)?.stepsLabel).toBe('1 step · read');
  });

  it('uses timestamps while running and freezes elapsed time when the result arrives', () => {
    const events: AgentEvent[] = [{ ...assistant(1, [call('agent-1')]), timestamp: at }];
    expect(subagentCardModel(card(events), true, Date.parse(at) + 4000)?.detailsLabel).toBe('4s');
    events.push({ seq: 2, type: 'user', timestamp: '2026-11-19T12:00:05Z', message: { content: [{ type: 'tool_result', tool_use_id: 'agent-1', content: 'done' }] } });
    expect(subagentCardModel(card(events), true, Date.parse(at) + 9000)?.detailsLabel).toBe('5s');
  });

  it('links task updates by task id and keeps usage across partial updates', () => {
    const parent = card([assistant(1, [call('agent-1')]),
      { seq: 2, type: 'system', subtype: 'task_started', tool_use_id: 'agent-1', task_id: 'task', timestamp: at },
      progress({ task_id: 'task', usage: { total_tokens: 0, tool_uses: 0 } }),
      { seq: 4, type: 'system', subtype: 'task_updated', task_id: 'task', patch: { status: 'completed', end_time: '2026-11-19T12:00:07Z' } },
    ]);
    expect(subagentCardModel(parent, true, Date.parse(at) + 9000)).toMatchObject({ stepsLabel: 'Finished · 0 tools', detailsLabel: '0 tokens · 7s' });
  });

  it('updates the signature for task details and nested text without new steps', () => {
    const events = [assistant(1, [call('agent-1')]), progress()];
    const first = mergedBlockSignature(card(events));
    expect(mergedBlockSignature(card([...events, progress({ seq: 4, description: 'Checking tests' })]))).not.toBe(first);
    expect(mergedBlockSignature(card([...events, assistant(5, [{ type: 'text', text: 'Answer' }], 'agent-1')]))).not.toBe(first);
  });
});


describe('running subagent count', () => {
  it('counts only open Agent calls, including nested calls', () => {
    const events = [assistant(1, [call('a'), call('b', 'Task'), call('read', 'Read')]), assistant(2, [call('c')], 'a')];
    expect(runningSubagentCount(events)).toBe(3);
    expect(runningSubagentCount([...events, assistant(3, [call('a')])])).toBe(3);
    events.push({ seq: 4, type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a', content: '' }] } });
    expect(runningSubagentCount(events)).toBe(2);
    events.push({ seq: 5, type: 'system', subtype: 'subagents_stopped' });
    expect(runningSubagentCount(events)).toBe(0);
  });
});


describe('background subagents', () => {
  it('keeps a background task running after its Agent call returns', () => {
    const events: AgentEvent[] = [
      assistant(1, [call('a')]),
      { seq: 2, type: 'system', subtype: 'task_started', task_id: 'task-a', tool_use_id: 'a' },
      { seq: 3, type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a', content: 'Started in background' }] } },
      { seq: 4, type: 'result', subtype: 'success', result: 'Waiting', talyn: { kind: 'process_result', turn: 1, attempt: 0 } },
    ];
    expect(runningSubagentCount(events)).toBe(1);
    const blocks = mergeToolBlocks(buildBlocks(events));
    expect(subagentCardModel(blocks[0] as ToolBlock, true)?.running).toBe(true);
    const finished: AgentEvent[] = [...events,
      { seq: 5, type: 'system', subtype: 'task_notification', task_id: 'task-a', status: 'completed' },
      { seq: 6, type: 'system', subtype: 'init', session_id: 'same' },
      assistant(7, [{ type: 'text', text: 'Final answer' }]),
      { seq: 8, type: 'result', subtype: 'success', result: 'Final answer', talyn: { kind: 'process_result', turn: 1, attempt: 0 } },
    ];
    expect(runningSubagentCount(finished)).toBe(0);
    const finalBlocks = mergeToolBlocks(buildBlocks(finished));
    expect(finalBlocks.filter((block) => block.kind === 'result')).toHaveLength(2);
    expect(subagentCardModel(finalBlocks[0] as ToolBlock, true)?.running).toBe(false);
  });
});
