import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { AgentEvent, Features, WorkbenchChat, WorkbenchEvent } from '@talyn/shared';
import { AgentBlocks } from '../components/workbench/AgentBlocks';
import { WorkbenchTranscript } from '../components/workbench/WorkbenchTranscript';
import { useWorkspaceStore } from '../stores/workspace';
import { useWorkbenchStore } from '../stores/workbenches';
import { BackgroundChips } from '../components/workbench/BackgroundChips';
import type { WorkbenchOps } from '../lib/workbenchOps';

vi.mock('../lib/supabase', () => ({ isSupabaseConfigured: () => false, supabase: null }));
afterEach(cleanup);
beforeEach(() => useWorkspaceStore.setState({ features: null }));

const call: AgentEvent = { seq: 1, type: 'assistant', message: { content: [{ type: 'tool_use', id: 'a', name: 'Agent',
  input: { subagent_type: 'Explore', description: 'Find the entry', prompt: 'Read the code.' } }] } };
const step = (seq: number, name = 'Read'): AgentEvent => ({ seq, type: 'assistant', parent_tool_use_id: 'a',
  message: { content: [{ type: 'tool_use', id: `nested-${seq}`, name, input: {} }] } });
const result: AgentEvent = { seq: 4, type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a',
  content: [{ type: 'text', text: 'Found the entry.' }] }] } };

it('shows the card and expands its brief and result', () => {
  render(<AgentBlocks events={[call, step(2), result]} />);
  expect(screen.getByText('Subagent · Explore')).toBeVisible();
  expect(screen.getByText('Find the entry')).toBeVisible();
  expect(screen.getByText('Finished · 1 step')).toBeVisible();
  expect(screen.queryByText('Read the code.')).toBeNull();
  const button = screen.getByRole('button', { name: /Subagent · Explore/ });
  fireEvent.click(button);
  expect(button).toHaveAttribute('aria-expanded', 'true');
  expect(screen.getByText('Brief from the agent')).toBeVisible();
  expect(screen.getByText('Read the code.')).toBeVisible();
  expect(screen.getByText('Result')).toBeVisible();
  expect(screen.getByText('Found the entry.')).toBeVisible();
  fireEvent.click(button);
  expect(screen.queryByText('Found the entry.')).toBeNull();
});

it('updates progress through the workbench turn cache', () => {
  const chat = { id: 'c1', workbenchId: 'wb1', status: 'running' } as WorkbenchChat;
  const ops = { unavailable: null } as unknown as WorkbenchOps;
  const draw = (events: AgentEvent[]) => <WorkbenchTranscript chat={chat} ops={ops} loading={false} error={null}
    events={events.map((event): WorkbenchEvent => ({ chatId: 'c1', seq: event.seq, turn: 1, event }))} />;
  const view = render(draw([call]));
  expect(screen.getByText('Starting…')).toBeVisible();
  view.rerender(draw([call, step(2)]));
  expect(screen.getByText('1 step · read')).toBeVisible();
  view.rerender(draw([call, step(2), step(3, 'Grep')]));
  expect(screen.getByText('2 steps · grep')).toBeVisible();
  view.rerender(draw([call, step(2), step(3, 'Grep'), result]));
  expect(screen.getByText('Finished · 2 steps')).toBeVisible();
});

it('keeps the ordinary tool row beside the card', () => {
  render(<AgentBlocks events={[call, { seq: 2, type: 'assistant', message: { content: [
    { type: 'tool_use', id: 'read', name: 'Read', input: { file_path: 'src/main.ts' } },
  ] } }]} />);
  expect(screen.getByText('Subagent · Explore')).toBeVisible();
  expect(screen.getByText('read')).toBeVisible();
  expect(screen.getByText('src/main.ts')).toBeVisible();
  expect(screen.getAllByText(/Subagent ·/)).toHaveLength(1);
});


it.each([false, true])('gates nested steps and task details, enabled=%s', (enabled) => {
  useWorkspaceStore.setState({ features: { sessionSubagents: enabled } as Features });
  const details: AgentEvent = { seq: 3, type: 'system', subtype: 'task_progress', tool_use_id: 'a',
    description: 'Checking imports', usage: { total_tokens: 1234, tool_uses: 3, duration_ms: 2000 } };
  const nested: AgentEvent = { seq: 4, type: 'assistant', parent_tool_use_id: 'a', message: { content: [{ type: 'text', text: 'Nested answer' }] } };
  const view = render(<AgentBlocks events={[call, step(2), details]} />);
  expect(screen.getByText(enabled ? '3 tools · Checking imports' : '1 step · read')).toBeVisible();
  expect(Boolean(screen.queryByText('1,234 tokens · 2s'))).toBe(enabled);
  fireEvent.click(screen.getByRole('button', { name: /Subagent · Explore/ }));
  view.rerender(<AgentBlocks events={[call, step(2), details, nested]} />);
  expect(Boolean(screen.queryByText('Nested answer'))).toBe(enabled);
  expect(Boolean(screen.queryByText('Steps'))).toBe(enabled);
  expect(Boolean(screen.queryByText('read'))).toBe(enabled);
  view.rerender(<AgentBlocks events={[call, step(2), { ...details, description: 'Checking tests' }, nested]} />);
  expect(screen.getByText(enabled ? '3 tools · Checking tests' : '1 step · read')).toBeVisible();
});

it('keeps the step fallback with the flag on', () => {
  useWorkspaceStore.setState({ features: { sessionSubagents: true } as Features });
  render(<AgentBlocks events={[call, step(2)]} />);
  expect(screen.getByText('1 step · read')).toBeVisible();
});

it.each([false, true])('gates the live turn count, enabled=%s', (enabled) => {
  useWorkspaceStore.setState({ features: { sessionSubagents: enabled } as Features });
  const chat = { id: 'c1', workbenchId: 'wb1', status: 'running' } as WorkbenchChat;
  const events: WorkbenchEvent[] = [
    { chatId: 'c1', seq: 1, turn: 1, event: { ...call, message: { content: [{ type: 'tool_use', id: 'old', name: 'Agent', input: {} }] } } },
    { chatId: 'c1', seq: 2, turn: 2, event: call },
  ];
  useWorkbenchStore.setState({ chats: { wb1: [chat] }, chatEvents: { c1: { events } } } as never);
  const view = render(<BackgroundChips workbenchId="wb1" chatId="c1" canOpen={false} />);
  expect(Boolean(screen.queryByText('1 subagent running'))).toBe(enabled);
  expect(screen.queryByText('2 subagents running')).toBeNull();
  view.unmount();
  useWorkbenchStore.setState({ chats: { wb1: [{ ...chat, status: 'idle' }] } });
  render(<BackgroundChips workbenchId="wb1" chatId="c1" canOpen={false} />);
  expect(screen.queryByText('1 subagent running')).toBeNull();
});

it('shows the turn-end note with the flag off', () => {
  render(<AgentBlocks events={[{ seq: 1, type: 'system', subtype: 'subagents_stopped', text: 'Two subagents stopped.' }]} />);
  expect(screen.getByText('Two subagents stopped.')).toBeVisible();
});
