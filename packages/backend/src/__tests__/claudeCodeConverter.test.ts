import { describe, it, expect } from 'vitest';
import {
  managedAgentEventToAgentEvents,
  managedAgentEventsToAgentEvents,
  findPullRequestUrl,
  isTerminalEvent,
  type ManagedAgentEvent,
} from '../services/claudeCode/converter.js';

const textContent = (text: string) => [{ type: 'text', text }];

describe('managedAgentEventToAgentEvents', () => {
  it('maps agent.message to an assistant text event', () => {
    const out = managedAgentEventToAgentEvents({
      type: 'agent.message',
      content: textContent('Hello, I will fix this.'),
    });
    expect(out).toEqual([
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Hello, I will fix this.' }] },
      },
    ]);
  });

  it('maps user.message to a user text event', () => {
    const out = managedAgentEventToAgentEvents({
      type: 'user.message',
      content: textContent('Update the readme'),
    });
    expect(out[0]).toMatchObject({ type: 'user', message: { role: 'user' } });
  });

  it('maps agent.thinking with content to a thinking block', () => {
    const out = managedAgentEventToAgentEvents({
      type: 'agent.thinking',
      content: textContent('Let me inspect the repo first.'),
    });
    expect(out).toEqual([
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'thinking', thinking: 'Let me inspect the repo first.' }],
        },
      },
    ]);
  });

  it('drops a contentless agent.thinking marker', () => {
    expect(managedAgentEventToAgentEvents({ type: 'agent.thinking', id: 'x' })).toEqual([]);
  });

  it('maps agent.tool_use to an assistant tool_use (prebuilt tool name)', () => {
    const out = managedAgentEventToAgentEvents({
      type: 'agent.tool_use',
      id: 'sevt_1',
      name: 'bash',
      input: { command: 'ls -1' },
    });
    expect(out).toEqual([
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'sevt_1', name: 'bash', input: { command: 'ls -1' } }],
        },
      },
    ]);
  });

  it('maps agent.mcp_tool_use, resolving the name from tool_name/mcp_tool_name', () => {
    const fromToolName = managedAgentEventToAgentEvents({
      type: 'agent.mcp_tool_use',
      id: 'sevt_2',
      tool_name: 'create_pull_request',
      input: { title: 'x' },
    });
    expect(fromToolName[0].message?.content?.[0]).toMatchObject({
      type: 'tool_use',
      name: 'create_pull_request',
    });
    const fromMcpName = managedAgentEventToAgentEvents({
      type: 'agent.mcp_tool_use',
      id: 'sevt_3',
      mcp_tool_name: 'create_branch',
      input: {},
    });
    expect(fromMcpName[0].message?.content?.[0]).toMatchObject({ name: 'create_branch' });
  });

  it('maps agent.tool_result to a user tool_result with linkage + error flag', () => {
    const ok = managedAgentEventToAgentEvents({
      type: 'agent.tool_result',
      tool_use_id: 'sevt_1',
      content: textContent('file1\nfile2'),
      is_error: false,
    });
    expect(ok).toEqual([
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'sevt_1', content: 'file1\nfile2', is_error: false },
          ],
        },
      },
    ]);
    const err = managedAgentEventToAgentEvents({
      type: 'agent.mcp_tool_result',
      tool_use_id: 'sevt_2',
      content: textContent('boom'),
      is_error: true,
    });
    expect(err[0].message?.content?.[0]).toMatchObject({ is_error: true, tool_use_id: 'sevt_2' });
  });

  it('maps session.error to a system stderr note', () => {
    const out = managedAgentEventToAgentEvents({
      type: 'session.error',
      error: { message: 'MCP server github initialize failed', type: 'mcp_authentication_failed_error' },
    });
    expect(out).toEqual([
      { type: 'system', subtype: 'stderr', text: 'error: MCP server github initialize failed' },
    ]);
  });

  it('ignores lifecycle/telemetry events', () => {
    for (const type of [
      'span.model_request_start',
      'span.model_request_end',
      'session.status_running',
      'session.status_idle',
      'session.thread_status_running',
      'session.thread_status_idle',
      'user.interrupt',
      'something.unknown',
    ]) {
      expect(managedAgentEventToAgentEvents({ type })).toEqual([]);
    }
  });

  it('tolerates a bare-string or nested content shape', () => {
    expect(
      managedAgentEventToAgentEvents({ type: 'agent.message', content: 'plain string' })[0]
        .message?.content?.[0],
    ).toEqual({ type: 'text', text: 'plain string' });
  });
});

describe('managedAgentEventsToAgentEvents', () => {
  it('flat-maps a full event page in order', () => {
    const page: ManagedAgentEvent[] = [
      { type: 'user.message', content: textContent('do it') },
      { type: 'span.model_request_start' },
      { type: 'agent.tool_use', id: 't1', name: 'bash', input: {} },
      { type: 'agent.tool_result', tool_use_id: 't1', content: textContent('ok') },
      { type: 'agent.message', content: textContent('done') },
    ];
    const out = managedAgentEventsToAgentEvents(page);
    expect(out.map((e) => e.type)).toEqual(['user', 'assistant', 'user', 'assistant']);
  });
});

describe('findPullRequestUrl', () => {
  it('extracts the PR URL from a create_pull_request mcp_tool_result', () => {
    const events: ManagedAgentEvent[] = [
      { type: 'agent.mcp_tool_use', name: 'create_pull_request', input: {} },
      {
        type: 'agent.mcp_tool_result',
        content: textContent('Pull request created: https://github.com/Gilbert09/owl/pull/8'),
      },
    ];
    expect(findPullRequestUrl(events)).toBe('https://github.com/Gilbert09/owl/pull/8');
  });

  it('returns null when no PR was opened', () => {
    expect(findPullRequestUrl([{ type: 'agent.message', content: textContent('no pr here') }])).toBeNull();
  });
});

describe('isTerminalEvent', () => {
  it('is true only for session.status_idle with end_turn', () => {
    expect(
      isTerminalEvent({ type: 'session.status_idle', stop_reason: { type: 'end_turn' } }),
    ).toBe(true);
    // idle without a terminal stop_reason (e.g. a freshly created session) is not terminal
    expect(isTerminalEvent({ type: 'session.status_idle' })).toBe(false);
    expect(
      isTerminalEvent({ type: 'session.status_idle', stop_reason: { type: 'requires_action' } }),
    ).toBe(false);
    expect(isTerminalEvent({ type: 'session.status_running' })).toBe(false);
  });
});
