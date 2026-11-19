import { afterEach, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { AgentEvent, WorkbenchChat, WorkbenchEvent } from '@talyn/shared';
import { AgentBlocks } from '../components/workbench/AgentBlocks';
import { WorkbenchTranscript } from '../components/workbench/WorkbenchTranscript';
import type { WorkbenchOps } from '../lib/workbenchOps';

vi.mock('../lib/supabase', () => ({ isSupabaseConfigured: () => false, supabase: null }));
afterEach(cleanup);

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
