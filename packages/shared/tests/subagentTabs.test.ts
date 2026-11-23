import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../src/index.js';
import { nextRunningSubagentTab, subagentTabs } from '../src/transcript.js';

const agentCall = (id: string, description = id) => ({ type: 'tool_use', id, name: 'Agent', input: { description, prompt: `Brief ${id}` } });
const entry = (turn: number, event: AgentEvent, createdAt?: string) => ({ turn, event, ...(createdAt ? { createdAt } : {}) });
const assistant = (seq: number, content: unknown[], parent?: string): AgentEvent => ({
  seq, type: 'assistant', message: { content }, ...(parent ? { parent_tool_use_id: parent } : {}),
});
const result = (seq: number, id: string): AgentEvent => ({
  seq, type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: `Done ${id}` }] },
});

const chat = [
  entry(1, { seq: 1, type: 'user', message: { content: 'first' } }),
  entry(1, assistant(2, [agentCall('old')])),
  entry(1, assistant(3, [{ type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: 'a.ts' } }], 'old'), '2026-11-19T10:00:00Z'),
  entry(1, result(4, 'old')),
  entry(2, { seq: 5, type: 'user', message: { content: 'second' } }),
  entry(2, assistant(6, [agentCall('a'), agentCall('b'), { type: 'tool_use', id: 'plain', name: 'Read', input: {} }])),
  entry(2, assistant(7, [{ type: 'tool_use', id: 'r2', name: 'Grep', input: { pattern: 'x' } }], 'a')),
  entry(2, result(8, 'b')),
];

describe('subagentTabs', () => {
  it.each([
    ['no subagents', [entry(1, assistant(1, [{ type: 'text', text: 'hi' }]))], undefined, []],
    ['the latest turn only', chat, undefined, ['a', 'b']],
    ['an older kept subagent first', chat, 'old', ['old', 'a', 'b']],
    ['a kept subagent of the latest turn once', chat, 'a', ['a', 'b']],
    ['an unknown kept id ignored', chat, 'missing', ['a', 'b']],
    ['a later turn without subagents keeps the last one with them', [...chat, entry(3, assistant(9, [{ type: 'text', text: 'later' }]))], null, ['a', 'b']],
  ])('%s', (_name, entries, keep, ids) => {
    expect(subagentTabs(entries, keep).map((tab) => tab.toolId)).toEqual(ids);
  });

  it('carries the subagent steps, turn, settled state and result', () => {
    const tabs = subagentTabs(chat, 'old');
    expect(tabs[0]).toMatchObject({ turn: 1, block: { settled: true, output: 'Done old', subagent: { steps: 1 } } });
    expect(tabs[0].block.subagent?.children).toHaveLength(1);
    expect(tabs[1]).toMatchObject({ turn: 2, block: { settled: false, subagent: { steps: 1, current: 'grep x' } } });
    expect(tabs[2]).toMatchObject({ turn: 2, block: { settled: true } });
  });

  it('ignores Agent calls that a subagent makes', () => {
    const nested = [...chat, entry(2, assistant(9, [agentCall('inner')], 'a'))];
    expect(subagentTabs(nested).map((tab) => tab.toolId)).toEqual(['a', 'b']);
  });
});

describe('nextRunningSubagentTab', () => {
  const running = [...chat.slice(0, 7), entry(2, assistant(8, [agentCall('c')]))];
  const tabs = subagentTabs(running);

  it.each([
    ['opens the first running one from the main tab', null, 'a'],
    ['moves to the next running one', 'a', 'b'],
    ['wraps back to the first', 'c', 'a'],
    ['starts again from a tab that is not running', 'old', 'a'],
  ])('%s', (_name, current, next) => {
    expect(nextRunningSubagentTab(tabs, current)).toBe(next);
  });

  it('is null when no subagent runs', () => {
    expect(nextRunningSubagentTab(subagentTabs([...chat, entry(2, result(9, 'a'))]), null)).toBeNull();
  });
});
