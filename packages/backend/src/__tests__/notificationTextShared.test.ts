import { describe, expect, it } from 'vitest';
import {
  latestEventTurn,
  notificationSummary,
  notificationText,
  pullRequestOutcomeEvent,
  truncateNotificationText,
  type WorkbenchChat,
  type WorkbenchEvent,
} from '@talyn/shared';

type Status = WorkbenchChat['status'];

function event(turn: number, value: Record<string, unknown>, seq = turn): WorkbenchEvent {
  return { chatId: 'chat1', turn, seq, event: { seq, ...value } as WorkbenchEvent['event'] };
}

function assistant(text: string): Record<string, unknown> {
  return { type: 'assistant', message: { content: [{ type: 'text', text }] } };
}

describe('shared notification text', () => {
  it.each<[Status, string, string]>([
    ['idle', 'Done: Fix session settings', 'The agent finished.'],
    ['running', 'Done: Fix session settings', 'The agent finished.'],
    ['awaiting_input', 'Needs your reply: Fix session settings', 'The agent is waiting for your answer.'],
    ['error', 'Failed: Fix session settings', 'The agent stopped with an error.'],
  ])('uses the session name and %s status', (status, title, body) => {
    expect(notificationText({ status }, { name: 'internal-branch', title: 'Fix session settings' })).toEqual({ title, body });
  });

  it.each([
    [{ name: 'internal-branch' }, 'Done: internal-branch'],
    [{ name: 'internal-branch', title: '   ' }, 'Done: internal-branch'],
    [{ name: '  ' }, 'Done: Session'],
    [undefined, 'Done: Session'],
  ] as const)('uses the available session name', (workbench, title) => {
    expect(notificationText({ status: 'idle' }, workbench).title).toBe(title);
  });

  it('trims a long title to 80 characters', () => {
    const title = notificationText({ status: 'idle' }, { name: 'x'.repeat(100) }).title;
    expect(title).toHaveLength(80);
    expect(title).toMatch(/…$/);
  });

  it.each<[string, Record<string, unknown>, string]>([
    ['opened', pullRequestOutcomeEvent({ ok: true, number: 42, url: 'u', existing: false }), 'Opened PR #42'],
    ['adopted', pullRequestOutcomeEvent({ ok: true, number: 7, url: 'u', existing: true, adopted: true }), 'Linked PR #7'],
  ])('reports a %s pull request', (_name, pr, expected) => {
    expect(notificationSummary({ status: 'idle' }, [event(1, assistant('Other work finished.')), event(1, pr, 2)])).toBe(expected);
  });

  it('skips a failed pull request outcome', () => {
    const failed = pullRequestOutcomeEvent({ ok: false, message: 'No commits.' });
    expect(notificationSummary({ status: 'idle' }, [event(1, assistant('Tried to open it.')), event(1, failed, 2)]))
      .toBe('Tried to open it.');
  });

  it('uses the last AskUserQuestion input', () => {
    const question = event(2, {
      type: 'assistant',
      message: { content: [
        { type: 'tool_use', name: 'AskUserQuestion', input: { questions: [{ question: 'Which database should I use?' }] } },
      ] },
    });
    expect(notificationSummary({ status: 'awaiting_input' }, [event(1, assistant('Earlier answer.')), question]))
      .toBe('Which database should I use?');
  });

  it.each<[string, WorkbenchEvent[], string]>([
    ['assistant text', [event(1, assistant('I need the database name.'))], 'I need the database name.'],
    ['no events', [], 'The agent is waiting for your answer.'],
  ])('uses %s when the question is absent', (_name, events, expected) => {
    expect(notificationText({ status: 'awaiting_input' }, { name: 'Session' }, events).body).toBe(expected);
  });

  it.each<[string, WorkbenchEvent[], string | null, string]>([
    ['result', [event(1, { type: 'result', is_error: true, result: 'The build failed.' })], null, 'The build failed.'],
    ['errors', [event(1, { type: 'result', is_error: true, errors: ['Could not connect.'] })], null, 'Could not connect.'],
    ['error objects', [event(1, { type: 'result', is_error: true, errors: [{ message: 'Disk full.' }, 3] })], null, 'Disk full.'],
    ['string errors', [event(1, { type: 'result', is_error: true, errors: 'Timed out.' })], null, 'Timed out.'],
    ['chat error', [], 'The sandbox stopped.', 'The sandbox stopped.'],
    ['fallback', [], null, 'The agent stopped with an error.'],
    ['blank error', [], '', 'The agent stopped with an error.'],
  ])('uses the %s error', (_name, events, error, expected) => {
    expect(notificationText({ status: 'error', error }, { name: 'Session' }, events).body).toBe(expected);
  });

  it.each<[string, string, string]>([
    ['Markdown', '## **Updated** [login](https://example.com) with `OAuth`\n- Added tests', 'Updated login with OAuth Added tests'],
    ['sentence', 'Updated the login flow. Tests now pass.', 'Updated the login flow.'],
    ['short sentence', 'Done. Updated the login flow.', 'Done. Updated the login flow.'],
    ['numbered list', '1. Fixed the bug\n2) Added a test', 'Fixed the bug Added a test'],
  ])('cleans %s assistant text', (_name, input, expected) => {
    expect(notificationSummary({ status: 'idle' }, [event(1, assistant(input))])).toBe(expected);
  });

  it('trims a long summary to 140 characters', () => {
    const body = notificationSummary({ status: 'idle' }, [event(1, assistant('x'.repeat(180)))]);
    expect(body).toHaveLength(140);
    expect(body).toMatch(/…$/);
  });

  it('ignores a pull request from an earlier turn and nested assistant text', () => {
    const events = [
      event(1, pullRequestOutcomeEvent({ ok: true, number: 10, url: 'u', existing: false })),
      event(2, { ...assistant('Nested task finished.'), parent_tool_use_id: 'tool1' }, 2),
      event(2, assistant('Updated the settings page.'), 3),
    ];
    expect(notificationSummary({ status: 'idle' }, events)).toBe('Updated the settings page.');
  });

  it.each<[string, Array<{ turn: number }>, number]>([
    ['no events', [], 0],
    ['ordered events', [{ turn: 1 }, { turn: 2 }, { turn: 3 }], 3],
    ['unordered events', [{ turn: 4 }, { turn: 2 }, { turn: 3 }], 4],
  ])('finds the latest turn of %s', (_name, events, expected) => {
    expect(latestEventTurn(events)).toBe(expected);
  });

  it.each<[string, number, string]>([
    ['short', 10, 'short'],
    ['exactly ten', 11, 'exactly ten'],
    ['a long sentence here', 10, 'a long se…'],
    ['trailing space cut', 10, 'trailing…'],
  ])('truncates %j to %i characters', (text, length, expected) => {
    expect(truncateNotificationText(text, length)).toBe(expected);
  });
});
