import { buildBlocks, mergeToolBlocks, type AgentEvent, type Features, type ToolBlock, type WorkbenchEvent } from '@talyn/shared';
import { act, fireEvent, render, screen } from '@testing-library/react-native';

import { fullToolFrom, TranscriptContext } from '../features/chat/fullTool';
import { useFeatures } from '../lib/features';
import { ToolRow } from '../features/chat/ToolRow';
import { TranscriptRowCache } from '../features/chat/transcript';

jest.mock('../lib/features', () => ({ useFeatures: jest.fn(() => null) }));
beforeEach(() => jest.mocked(useFeatures).mockReturnValue(null));

jest.mock('../auth/AuthProvider', () => ({ useMobileRuntime: () => ({ workflow: {} }), useNetwork: () => 'online' }));

jest.mock('expo-router', () => ({ Link: ({ children }: { children: React.ReactNode }) => children }));

const tool = (patch: Partial<ToolBlock> = {}): ToolBlock => ({ kind: 'tool', key: '1.0', toolId: 'a', name: 'Agent',
  input: { subagent_type: 'Explore', description: 'Find the entry', prompt: 'Read the code.' },
  output: [{ type: 'text', text: 'Found the entry.' }], subagent: { steps: 1, current: 'read' },
  settled: true, stopped: false, isError: false, ...patch });

it('shows the card and expands its brief and result', async () => {
  await render(<ToolRow tool={tool()} />);
  expect(screen.getByText('Subagent · Explore')).toBeVisible();
  expect(screen.getByText('Find the entry')).toBeVisible();
  expect(screen.getByText('Finished · 1 step')).toBeVisible();
  expect(screen.queryByText('Read the code.')).toBeNull();
  const button = screen.getByRole('button', { name: /Subagent · Explore/ });
  await fireEvent.press(button);
  expect(screen.getByRole('button', { name: /Subagent · Explore/, expanded: true })).toBeVisible();
  expect(screen.getByText('Brief from the agent')).toBeVisible();
  expect(screen.getByText('Read the code.')).toBeVisible();
  expect(screen.getByText('Result')).toBeVisible();
  expect(screen.getByText('Found the entry.')).toBeVisible();
  await fireEvent.press(button);
  expect(screen.queryByText('Found the entry.')).toBeNull();
});

it('keeps the ordinary tool row', async () => {
  await render(<ToolRow tool={tool({ name: 'Read', input: { file_path: 'src/main.ts' }, subagent: undefined })} />);
  expect(screen.getByText('read')).toBeVisible();
  expect(screen.getByText('src/main.ts')).toBeVisible();
  expect(screen.queryByText(/Subagent ·/)).toBeNull();
  await fireEvent.press(screen.getByRole('button', { name: /src\/main.ts/ }));
  expect(screen.getByText('Input')).toBeVisible();
});

it('keeps progress when it loads the whole brief and result', async () => {
  const held = tool();
  const load = jest.fn(async () => fullToolFrom(held, [
    { chatId: 'c1', seq: 1, turn: 1, event: { seq: 1, type: 'assistant', message: { content: [
      { type: 'tool_use', id: 'a', name: 'Agent', input: { ...held.input as object, prompt: 'The whole brief.' } },
    ] } } },
    { chatId: 'c1', seq: 4, turn: 1, event: { seq: 4, type: 'user', message: { content: [
      { type: 'tool_result', tool_use_id: 'a', content: [{ type: 'text', text: 'The whole result.' }] },
    ] } } },
  ]));
  await render(<TranscriptContext.Provider value={{ loadFullTool: load }}><ToolRow tool={held} partial /></TranscriptContext.Provider>);
  await act(async () => { await fireEvent.press(screen.getByRole('button', { name: /Subagent · Explore/ })); });
  expect(load).toHaveBeenCalledTimes(1);
  expect(screen.getByText('The whole brief.')).toBeVisible();
  expect(screen.getByText('The whole result.')).toBeVisible();
  expect(screen.getByText('Finished · 1 step')).toBeVisible();
});

it('updates the cached row when nested tools arrive', async () => {
  const cache = new TranscriptRowCache();
  const at = (event: AgentEvent): WorkbenchEvent => ({ chatId: 'c1', seq: event.seq, turn: 1, event });
  const events = [at({ seq: 1, type: 'assistant', message: { content: [{ type: 'tool_use', id: 'a', name: 'Agent', input: tool().input }] } })];
  const getTool = () => {
    const rows = cache.rows('c1', events);
    expect(rows).toHaveLength(1);
    if (rows[0].kind !== 'tool') throw new Error('Expected a tool row');
    return rows[0].tool;
  };
  const first = getTool();
  const view = await render(<ToolRow tool={first} />);
  expect(screen.getByText('Starting…')).toBeVisible();
  events.push(at({ seq: 2, type: 'assistant', parent_tool_use_id: 'a', message: { content: [
    { type: 'tool_use', id: 'nested', name: 'Read', input: {} }, { type: 'text', text: 'Hidden answer' },
  ] } }));
  const updated = getTool();
  expect(updated).not.toBe(first);
  await view.rerender(<ToolRow tool={updated} />);
  expect(screen.getByText('1 step · read')).toBeVisible();
  expect(screen.queryByText('Hidden answer')).toBeNull();
  expect(getTool()).toBe(updated);
});


it.each([false, true])('gates nested steps and task details, enabled=%s', async (enabled) => {
  jest.mocked(useFeatures).mockReturnValue({ sessionSubagents: enabled } as Features);
  const events: AgentEvent[] = [
    { seq: 1, type: 'assistant', message: { content: [{ type: 'tool_use', id: 'a', name: 'Agent', input: tool().input }] } },
    { seq: 2, type: 'assistant', parent_tool_use_id: 'a', message: { content: [{ type: 'tool_use', id: 'read', name: 'Read', input: {} }] } },
    { seq: 3, type: 'system', subtype: 'task_progress', tool_use_id: 'a', description: 'Checking imports', usage: { total_tokens: 1234, tool_uses: 3, duration_ms: 2000 } },
  ];
  const parent = () => mergeToolBlocks(buildBlocks(events))[0] as ToolBlock;
  const view = await render(<ToolRow tool={parent()} />);
  expect(screen.getByText(enabled ? '3 tools · Checking imports' : '1 step · read')).toBeVisible();
  expect(Boolean(screen.queryByText('1,234 tokens · 2s'))).toBe(enabled);
  await fireEvent.press(screen.getByRole('button', { name: /Subagent · Explore/ }));
  events.push({ seq: 4, type: 'assistant', parent_tool_use_id: 'a', message: { content: [{ type: 'text', text: 'Nested answer' }] } });
  await view.rerender(<ToolRow tool={parent()} />);
  expect(Boolean(screen.queryByText('Nested answer'))).toBe(enabled);
  expect(Boolean(screen.queryByText('Steps'))).toBe(enabled);
  expect(Boolean(screen.queryByText('read'))).toBe(enabled);
});

it('keeps the step fallback with the flag on', async () => {
  jest.mocked(useFeatures).mockReturnValue({ sessionSubagents: true } as Features);
  await render(<ToolRow tool={tool({ settled: false })} />);
  expect(screen.getByText('1 step · read')).toBeVisible();
});

it('keeps new text and task details in the row cache', () => {
  const cache = new TranscriptRowCache();
  const events: WorkbenchEvent[] = [{ chatId: 'c', seq: 1, turn: 1, event: { seq: 1, type: 'assistant', message: { content: [{ type: 'tool_use', id: 'a', name: 'Agent', input: {} }] } } }];
  const first = cache.rows('c', events)[0];
  events.push({ chatId: 'c', seq: 2, turn: 1, event: { seq: 2, type: 'system', subtype: 'task_progress', tool_use_id: 'a', description: 'Working' } });
  const next = cache.rows('c', events)[0];
  expect(next).not.toBe(first);
  events.push({ chatId: 'c', seq: 3, turn: 1, event: { seq: 3, type: 'assistant', parent_tool_use_id: 'a', message: { content: [{ type: 'text', text: 'Nested answer' }] } } });
  expect(cache.rows('c', events)[0]).not.toBe(next);
});


it('loads a nested tool with the same preview controls as a main tool', async () => {
  jest.mocked(useFeatures).mockReturnValue({ sessionSubagents: true } as Features);
  const child = tool({ key: '2.0', toolId: 'nested', name: 'Read', input: { file_path: 'src/main.ts' }, output: 'Preview', subagent: undefined });
  const load = jest.fn(async () => fullToolFrom(child, [
    { chatId: 'c', seq: 2, turn: 1, event: { seq: 2, type: 'assistant', parent_tool_use_id: 'a', message: { content: [{ type: 'tool_use', id: 'nested', name: 'Read', input: child.input }] } } },
    { chatId: 'c', seq: 3, turn: 1, event: { seq: 3, type: 'user', parent_tool_use_id: 'a', message: { content: [{ type: 'tool_result', tool_use_id: 'nested', content: 'Whole nested output' }] } } },
  ]));
  await render(<TranscriptContext.Provider value={{ loadFullTool: load, partialTools: new Set(['nested']) }}>
    <ToolRow tool={tool({ subagent: { steps: 1, children: [child] } })} />
  </TranscriptContext.Provider>);
  await fireEvent.press(screen.getByRole('button', { name: /Subagent · Explore/ }));
  await fireEvent.press(screen.getByRole('button', { name: /read src/ }));
  await fireEvent.press(screen.getByText('Show more'));
  expect(await screen.findByText('Whole nested output')).toBeVisible();
  expect(load).toHaveBeenCalledTimes(1);
});
