/**
 * @jest-environment jsdom
 */
import '@testing-library/jest-dom';
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import type { AgentEvent, WorkbenchChat, WorkbenchEvent } from '@talyn/shared';
import type { WorkbenchOps } from '../renderer/lib/workbenchOps';
import { WorkbenchTranscript } from '../renderer/components/workbench/WorkbenchTranscript';
import { AgentConversation } from '../renderer/components/terminal/AgentConversation';
import { isInjectedUserMessage, skillInstructionsByToolId } from '../renderer/lib/skillInstructions';
import { splitTurns, userMessageText } from '../renderer/lib/workbenchFormat';

jest.mock('../renderer/lib/api', () => ({ api: { workbenches: { updateChat: jest.fn() } } }));
jest.mock('../renderer/lib/supabase', () => ({ isSupabaseConfigured: () => false, supabase: null }));
jest.mock('../renderer/stores/toast', () => ({ toast: { success: jest.fn(), error: jest.fn(), info: jest.fn() } }));

const CHAT = { id: 'c1', workbenchId: 'wb1', status: 'idle', planMode: false, agent: 'claude' } as WorkbenchChat;
const SKILL_TEXT = 'Base directory for this skill: /work/charts/.claude/skills/render-appset\n\n# Render appset\n\nRun the renderer.';

let seq = 0;
function ev(turn: number, event: Record<string, unknown>): WorkbenchEvent {
  seq += 1;
  return { chatId: 'c1', seq, turn, event: { seq, ...event } } as WorkbenchEvent;
}
const userMsg = (turn: number, text: string) => ev(turn, { type: 'talyn_user_message', text });
const reply = (turn: number, text: string) =>
  ev(turn, { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
const toolUse = (turn: number, id: string, name: string, input: Record<string, unknown>) =>
  ev(turn, { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
const toolResult = (turn: number, id: string, content: string) =>
  ev(turn, { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] } });
// The exact shape `claude -p --output-format stream-json` emits after a Skill result.
const injected = (turn: number, text: string, extra: Record<string, unknown> = { isSynthetic: true }) =>
  ev(turn, {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
    parent_tool_use_id: null,
    ...extra,
  });

function skillRun(): WorkbenchEvent[] {
  return [
    userMsg(1, 'Render the appset'),
    toolUse(1, 'toolu_skill', 'Skill', { skill: 'render-appset' }),
    toolResult(1, 'toolu_skill', 'Launching skill: render-appset'),
    injected(1, SKILL_TEXT),
    reply(1, 'Rendered it.'),
  ];
}

const ops = { runtime: 'sandbox', unavailable: null, send: jest.fn() } as unknown as WorkbenchOps;

beforeEach(() => {
  seq = 0;
});

describe('skill instructions in a session transcript', () => {
  it('does not draw the skill text as a user message', () => {
    render(<WorkbenchTranscript chat={CHAT} events={skillRun()} loading={false} error={null} ops={ops} />);
    expect(screen.getByText('Render the appset')).toBeInTheDocument();
    expect(screen.getByText('Rendered it.')).toBeInTheDocument();
    expect(screen.queryByText(/Base directory for this skill/)).toBeNull();
    expect(screen.queryByText(/Run the renderer\./)).toBeNull();
    // One revert affordance: one user message.
    expect(screen.getAllByTitle(/Restore the files/)).toHaveLength(1);
  });

  it('opens the skill text under the Skill call', () => {
    render(<WorkbenchTranscript chat={CHAT} events={skillRun()} loading={false} error={null} ops={ops} />);
    const toggle = screen.getByRole('button', { name: /Skill instructions/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText(/Run the renderer\./)).toBeInTheDocument();
    const callRow = screen.getByText('Skill').closest('div.font-mono');
    expect(callRow).toContainElement(screen.getByText(/Run the renderer\./));
    expect(callRow).toHaveTextContent('Launching skill: render-appset');
  });

  it('keeps the turn in one piece', () => {
    const turns = splitTurns(skillRun());
    expect(turns).toHaveLength(1);
    expect(turns[0].userText).toBe('Render the appset');
    expect(turns[0].events).toHaveLength(4);
  });

  it('does not take the skill text as the user message of a turn with none recorded', () => {
    const events = skillRun().slice(1);
    const turns = splitTurns(events);
    expect(turns).toHaveLength(1);
    expect(turns[0].userText).toBeNull();
    expect(turns[0].events).toHaveLength(4);
  });

  it('still draws a normal user message, and a later one still starts a new turn', () => {
    const events = [...skillRun(), userMsg(2, 'Now ship it'), reply(2, 'Shipped.')];
    render(<WorkbenchTranscript chat={CHAT} events={events} loading={false} error={null} ops={ops} />);
    expect(screen.getByText('Now ship it')).toBeInTheDocument();
    expect(screen.getAllByTitle(/Restore the files/)).toHaveLength(2);
    expect(splitTurns(events).map((t) => t.userText)).toEqual(['Render the appset', 'Now ship it']);
  });
});

describe('skill instructions in a task transcript', () => {
  it('draws them under the Skill call, closed', () => {
    const events = skillRun()
      .slice(1)
      .map((e) => e.event);
    render(<AgentConversation transcript={events} scopeId="t1" />);
    expect(screen.queryByText(/Run the renderer\./)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Skill instructions/ }));
    expect(screen.getByText(/Run the renderer\./)).toBeInTheDocument();
  });
});

describe('isInjectedUserMessage', () => {
  const user = (extra: Record<string, unknown>, content: unknown = [{ type: 'text', text: 'hi' }]) =>
    ({ seq: 1, type: 'user', message: { role: 'user', content }, ...extra }) as AgentEvent;

  it.each<[string, AgentEvent, boolean]>([
    ['stream-json isSynthetic', user({ isSynthetic: true }), true],
    ['session-file isMeta', user({ isMeta: true }), true],
    ['plain user text', user({}), false],
    ['isSynthetic false', user({ isSynthetic: false }), false],
    ['isSynthetic as a string', user({ isSynthetic: 'true' }), false],
    ["Talyn's own user message", user({ isSynthetic: true, talyn_user_message: true }), false],
    ['assistant event', { seq: 1, type: 'assistant', isSynthetic: true } as AgentEvent, false],
    ['talyn_user_message event', { seq: 1, type: 'talyn_user_message', text: 'hi' } as AgentEvent, false],
  ])('%s', (_name, event, expected) => {
    expect(isInjectedUserMessage(event)).toBe(expected);
  });

  it('keeps a plain user text event as a user message', () => {
    expect(userMessageText(user({}))).toBe('hi');
    expect(userMessageText(user({ isSynthetic: true }))).toBeNull();
    expect(userMessageText(user({ isMeta: true }, 'raw string'))).toBeNull();
  });
});

describe('skillInstructionsByToolId', () => {
  const events = (list: WorkbenchEvent[]) => list.map((e) => e.event);

  it('pairs each injected message with the oldest Skill call still waiting', () => {
    const map = skillInstructionsByToolId(
      events([
        ev(1, {
          type: 'assistant',
          message: {
            content: [
              { type: 'tool_use', id: 'a', name: 'Skill', input: { skill: 'one' } },
              { type: 'tool_use', id: 'b', name: 'Skill', input: { skill: 'two' } },
            ],
          },
        }),
        toolResult(1, 'a', 'Launching skill: one'),
        toolResult(1, 'b', 'Launching skill: two'),
        injected(1, 'first skill'),
        injected(1, 'second skill'),
      ])
    );
    expect(Object.fromEntries(map)).toEqual({ a: 'first skill', b: 'second skill' });
  });

  it('uses sourceToolUseID when the message carries one', () => {
    const map = skillInstructionsByToolId(
      events([
        toolUse(1, 'a', 'Skill', {}),
        toolUse(1, 'b', 'Skill', {}),
        toolResult(1, 'a', 'ok'),
        toolResult(1, 'b', 'ok'),
        injected(1, 'for b', { isMeta: true, sourceToolUseID: 'b' }),
        injected(1, 'for a', { isMeta: true }),
      ])
    );
    expect(Object.fromEntries(map)).toEqual({ a: 'for a', b: 'for b' });
  });

  it.each<[string, WorkbenchEvent[]]>([
    ['no Skill call', [injected(1, 'hook feedback')]],
    ['a Skill call with no result yet', [toolUse(1, 'a', 'Skill', {}), injected(1, 'too early')]],
    ['a non-Skill call', [toolUse(1, 'a', 'Bash', {}), toolResult(1, 'a', 'ok'), injected(1, 'x')]],
    ['a plain user message', [toolUse(1, 'a', 'Skill', {}), toolResult(1, 'a', 'ok'), userMsg(1, 'typed')]],
    [
      'a second injected message after the call is used',
      [toolUse(1, 'a', 'Skill', {}), toolResult(1, 'a', 'ok'), injected(1, 'skill'), injected(1, 'hook')],
    ],
  ])('attaches nothing extra for %s', (name, list) => {
    const map = skillInstructionsByToolId(events(list));
    if (name.startsWith('a second')) expect(Object.fromEntries(map)).toEqual({ a: 'skill' });
    else expect(map.size).toBe(0);
  });
});
