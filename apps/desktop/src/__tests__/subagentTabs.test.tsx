import '@testing-library/jest-dom';
import React from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { AgentEvent, Features, WorkbenchChat, WorkbenchEvent } from '@talyn/shared';
import { AgentBlocks, SubagentTabOpener, SubagentTranscript } from '../renderer/components/terminal/AgentConversation';
import { BackgroundChips } from '../renderer/components/workbench/BackgroundChips';
import { SubagentTabBar, useSubagentTabs } from '../renderer/components/workbench/SubagentTabs';
import { useWorkspaceStore } from '../renderer/stores/workspace';
import { useWorkbenchStore } from '../renderer/stores/workbenches';

jest.mock('../renderer/lib/supabase', () => ({ isSupabaseConfigured: () => false, supabase: null }));

const agent = (id: string, description: string) => ({ type: 'tool_use', id, name: 'Agent',
  input: { subagent_type: 'Explore', description, prompt: `Brief for ${description}.` } });
const calls: AgentEvent = { seq: 2, type: 'assistant', message: { content: [agent('a', 'Find the entry'), agent('b', 'Check the tests')] } };
const step = (seq: number, parent: string, name = 'Read'): AgentEvent => ({ seq, type: 'assistant', parent_tool_use_id: parent,
  message: { content: [{ type: 'tool_use', id: `nested-${seq}`, name, input: {} }] } });
const done = (seq: number, id: string, text: string): AgentEvent => ({ seq, type: 'user',
  message: { content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text }] }] } });
const entries = (events: AgentEvent[]): WorkbenchEvent[] => events.map((event) => ({ chatId: 'c1', seq: event.seq, turn: 1, event }));
const running = entries([{ seq: 1, type: 'user', message: { content: 'Go' } }, calls, step(3, 'a'), step(4, 'b', 'Grep')]);

/** The part of ChatView that draws the tabs. */
function Harness({ events }: { events: WorkbenchEvent[] }) {
  const { tabs, current } = useSubagentTabs('c1', events);
  return (
    <>
      {tabs.length > 0 && <SubagentTabBar chatId="c1" tabs={tabs} current={current} />}
      {current ? <SubagentTranscript block={current.block} events={events.map((e) => e.event)} /> : <div>Main transcript body</div>}
    </>
  );
}

const flag = (on: boolean) => useWorkspaceStore.setState({ features: { sessionSubagents: on } as Features });

beforeEach(() => {
  flag(true);
  useWorkbenchStore.setState({ subagentTab: {} });
});
afterEach(cleanup);

describe('subagent tabs', () => {
  it('shows no tabs with the flag off', () => {
    flag(false);
    render(<Harness events={running} />);
    expect(screen.queryByRole('tablist')).toBeNull();
  });

  it('shows no tabs for a chat without subagents', () => {
    render(<Harness events={entries([{ seq: 1, type: 'assistant', message: { content: [{ type: 'text', text: 'Hi' }] } }])} />);
    expect(screen.queryByRole('tablist')).toBeNull();
  });

  it('switches between the main transcript and each subagent', () => {
    render(<Harness events={running} />);
    const tabs = within(screen.getByRole('tablist')).getAllByRole('tab');
    expect(tabs.map((tab) => tab.getAttribute('aria-label'))).toEqual([
      'Main transcript', 'Subagent Find the entry, running', 'Subagent Check the tests, running',
    ]);
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(tabs[1]);
    expect(useWorkbenchStore.getState().subagentTab).toEqual({ c1: 'a' });
    expect(screen.getByRole('tab', { name: /Find the entry/ })).toHaveAttribute('aria-selected', 'true');
    const transcript = screen.getByTestId('subagent-transcript');
    expect(within(transcript).getByText('Brief for Find the entry.')).toBeVisible();
    expect(within(transcript).getByText('Still working…')).toBeVisible();
    expect(screen.queryByText('Main transcript body')).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'Main transcript' }));
    expect(useWorkbenchStore.getState().subagentTab).toEqual({});
    expect(screen.getByText('Main transcript body')).toBeVisible();
  });

  it('follows the subagent live and shows its result when it ends', () => {
    useWorkbenchStore.setState({ subagentTab: { c1: 'b' } });
    const view = render(<Harness events={running} />);
    expect(screen.getByText('1 step · grep')).toBeVisible();
    view.rerender(<Harness events={[...running, ...entries([done(5, 'b', 'All tests pass.')])]} />);
    expect(screen.getByText('Finished · 1 step')).toBeVisible();
    expect(screen.getByText('All tests pass.')).toBeVisible();
    expect(screen.getByRole('tab', { name: 'Subagent Check the tests' })).toHaveAttribute('aria-selected', 'true');
  });

  it('shows the main transcript when the chosen subagent is not in the chat', () => {
    useWorkbenchStore.setState({ subagentTab: { c1: 'gone' } });
    render(<Harness events={running} />);
    expect(screen.getByText('Main transcript body')).toBeVisible();
    expect(screen.getByRole('tab', { name: 'Main transcript' })).toHaveAttribute('aria-selected', 'true');
  });
});

describe('the subagents running chip', () => {
  const chat = { id: 'c1', workbenchId: 'wb1', status: 'running' } as WorkbenchChat;
  beforeEach(() => useWorkbenchStore.setState({ chats: { wb1: [chat] }, chatEvents: { c1: { events: running } } } as never));

  it('opens each running subagent in turn', () => {
    render(<BackgroundChips workbenchId="wb1" chatId="c1" canOpen={false} />);
    const chip = screen.getByTestId('subagent-chip');
    expect(chip).toHaveTextContent('2 subagents running');
    fireEvent.click(chip);
    expect(useWorkbenchStore.getState().subagentTab).toEqual({ c1: 'a' });
    fireEvent.click(chip);
    expect(useWorkbenchStore.getState().subagentTab).toEqual({ c1: 'b' });
    fireEvent.click(chip);
    expect(useWorkbenchStore.getState().subagentTab).toEqual({ c1: 'a' });
  });

  it('opens the tab also for a person who cannot open the Background tab', () => {
    render(<BackgroundChips workbenchId="wb1" chatId="c1" canOpen={false} />);
    expect(screen.getByRole('button', { name: "2 subagents running. Open a subagent's tab" })).toBeVisible();
  });
});

describe('the card Open button', () => {
  const events = [calls, step(3, 'a'), { ...step(4, 'a'), message: { content: [agent('inner', 'Nested helper')] } }];

  it.each([
    ['flag on, with tabs', true, true, 1],
    ['flag off', false, true, 0],
    ['no tabs (task transcript)', true, false, 0],
  ])('%s', (_name, on, withTabs, count) => {
    flag(on);
    const open = jest.fn();
    const blocks = <AgentBlocks events={events} />;
    render(withTabs ? <SubagentTabOpener.Provider value={open}>{blocks}</SubagentTabOpener.Provider> : blocks);
    const buttons = screen.queryAllByRole('button', { name: /in a tab$/ });
    expect(buttons).toHaveLength(count * 2);
    if (count) {
      fireEvent.click(screen.getByRole('button', { name: 'Open Find the entry in a tab' }));
      expect(open).toHaveBeenCalledWith('a');
    }
  });

  it('gives a subagent started by a subagent no Open button', () => {
    render(<SubagentTabOpener.Provider value={jest.fn()}><AgentBlocks events={events} /></SubagentTabOpener.Provider>);
    fireEvent.click(screen.getAllByRole('button', { name: /Subagent · Explore/ })[0]);
    expect(screen.getByText('Nested helper')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Open Nested helper in a tab' })).toBeNull();
  });
});
