import { PLAN_APPROVED_MESSAGE, type AgentEvent, type WorkbenchEvent } from '@talyn/shared';

import { diffTone, humanToolName, looksLikeDiff, preview, readableOutput, shortenPath, toolLine, unescapeText } from '../features/chat/toolFormat';
import { rowLabel, transcriptRows, userMessageText, type TranscriptRow } from '../features/chat/transcript';
import { agentLabel, chatDetailsLine, effortLabel, modelLabel } from '../lib/models';
import { ROW_TEXT_LIMIT } from '../workflow/model';
import { event } from './workflowFixtures';

let seq = 0;
const at = (body: Partial<AgentEvent> & { type: string }, turn = 1, patch: Partial<WorkbenchEvent> = {}): WorkbenchEvent => {
  seq += 1;
  return { chatId: 'chat-one', seq, turn, event: { seq, ...body } as AgentEvent, ...patch };
};
const user = (text: string, turn = 1, patch: Partial<WorkbenchEvent> = {}) =>
  at({ type: 'user', message: { content: [{ type: 'text', text }] }, talyn_user_message: true }, turn, patch);
const assistant = (content: unknown[], turn = 1) => at({ type: 'assistant', message: { content } } as AgentEvent, turn);
const toolResult = (id: string, content: unknown, isError = false, turn = 1) =>
  at({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] } } as AgentEvent, turn);
const kinds = (rows: TranscriptRow[]) => rows.map((row) => row.kind);
beforeEach(() => { seq = 0; });

describe('model and agent labels', () => {
  it.each([
    ['claude-opus-5-5', undefined, 'Opus 5.5'],
    ['claude-sonnet-5-5', undefined, 'Sonnet 5.5'],
    ['gpt-6.1-terra', undefined, 'GPT-6.1 Terra'],
    ['gpt-5.6-terra', undefined, 'GPT-6.1 Terra'],
    ['claude-haiku-9-2', undefined, 'Haiku 9.2'],
    ['gpt-7-nova-mini', undefined, 'GPT-7 Nova Mini'],
    ['some-local-model', undefined, 'some-local-model'],
    [null, 'claude', 'Sonnet 5.5'],
    [null, 'codex', 'GPT-6.1 Terra'],
    [null, undefined, ''],
  ])('labels model %s for agent %s as %s', (model, agent, expected) => expect(modelLabel(model, agent)).toBe(expected));
  it.each([['claude', 'Claude'], ['codex', 'Codex'], ['gemini', 'Gemini'], [null, '']])('labels agent %s', (agent, expected) => expect(agentLabel(agent)).toBe(expected));
  it.each([[null, 'High effort'], ['low', 'Low effort'], ['xhigh', 'Extra-high effort'], ['max', 'Max effort']] as const)('labels effort %s', (effort, expected) =>
    expect(effortLabel(effort)).toBe(expected));
  it.each([
    [{ agent: 'claude' as const, model: 'claude-opus-5-5', effort: null, planMode: false }, null, 'Claude · Opus 5.5 · High effort'],
    [{ agent: 'codex' as const, model: null, effort: 'low' as const, planMode: true }, null, 'Codex · GPT-6.1 Terra · Low effort · Plan mode'],
    [undefined, 'claude', 'Claude · Sonnet 5.5 · High effort'],
  ])('builds one details line %#', (chat, fallback, expected) => expect(chatDetailsLine(chat, fallback)).toBe(expected));
});

describe('tool lines and output', () => {
  it.each([
    ['mcp__talyn__talyn_memory_write', 'Talyn · Memory write'],
    ['mcp__linear__create_issue', 'Linear · Create issue'],
    ['mcp__my-server__do-thing', 'My server · Do thing'],
    ['Bash', 'Bash'],
  ])('humanises %s', (name, expected) => expect(humanToolName(name)).toBe(expected));
  it.each([
    ['Bash', { command: 'npm test' }, { label: 'bash', detail: 'npm test', isCommand: true }],
    ['Read', { file_path: '/work/repo/src/app.ts' }, { label: 'read', detail: 'src/app.ts', isCommand: false }],
    ['Edit', { file_path: '/home/me/project/apps/web/x.ts' }, { label: 'edit', detail: 'apps/web/x.ts', isCommand: false }],
    ['mcp__talyn__talyn_memory_write', { name: 'Deploys' }, { label: 'Talyn · Memory write', detail: 'Deploys', isCommand: false }],
  ])('describes %s', (name, input, expected) => expect(toolLine(name, input)).toEqual(expected));
  it.each([
    ['/work/abc/src/a.ts', 'src/a.ts'],
    ['/Users/me/code/x/y.ts', '~/code/x/y.ts'],
    ['relative/path.ts', 'relative/path.ts'],
  ])('shortens %s', (path, expected) => expect(shortenPath(path)).toBe(expected));
  it.each([
    ['line\\nnext', 'line\nnext'],
    ['tab\\there', 'tab\there'],
    ['keep \\\\n literal', 'keep \\n literal'],
    ['quote \\" stays', 'quote \\" stays'],
  ])('unescapes %s', (source, expected) => expect(unescapeText(source)).toBe(expected));
  it('pretty prints JSON and shows escaped newlines as real ones', () => {
    const output = readableOutput('{"a":1,"log":"one\\ntwo"}');
    expect(output.text).toBe('{\n  "a": 1,\n  "log": "one\ntwo"\n}');
    expect(output.summary).toMatch(/^JSON/);
  });
  it('turns a single escaped line into real lines', () => {
    expect(readableOutput('first\\nsecond').text).toBe('first\nsecond');
    expect(readableOutput('real\nlines \\n stay').text).toBe('real\nlines \\n stay');
  });
  it.each([
    ['@@ -1 +1 @@\n-old\n+new', true],
    ['diff --git a/x b/x\n--- a/x\n+++ b/x\n+added', true],
    ['- a bullet\n- another', false],
    ['plain output', false],
  ])('detects a diff in %j', (text, expected) => expect(looksLikeDiff(text)).toBe(expected));
  it.each([['+added', 'add'], ['-removed', 'del'], ['@@ -1 +1 @@', 'hunk'], ['+++ b/x', null], [' context', null]] as const)('tints %s', (line, tone) =>
    expect(diffTone(line)).toBe(tone));
  it.each([
    ['a\nb\nc', 2, 100, 'a\nb', true],
    ['abcdef', 5, 3, 'abc', true],
    ['short', 5, 100, 'short', false],
  ])('previews %j', (text, lines, chars, shown, hidden) => expect(preview(text, lines, chars)).toEqual({ text: shown, hidden }));
});

describe('transcript rows', () => {
  it('reads user text like web and ignores tool results and injected text', () => {
    expect(userMessageText({ type: 'user', message: { content: 'Plain' } } as AgentEvent)).toBe('Plain');
    expect(userMessageText({ type: 'talyn_user_message', text: 'Stored' } as unknown as AgentEvent)).toBe('Stored');
    expect(userMessageText({ type: 'user', message: { content: [{ type: 'tool_result', content: 'x' }] } } as AgentEvent)).toBeNull();
    expect(userMessageText({ type: 'user', isMeta: true, message: { content: 'Skill text' } } as unknown as AgentEvent)).toBeNull();
    expect(userMessageText({ type: 'assistant', message: { content: 'Agent' } } as AgentEvent)).toBeNull();
  });

  it('builds a user bubble, agent text, and a paired tool call', () => {
    const rows = transcriptRows('chat-one', [user('Fix it', 1, { createdAt: '2026-11-08T11:00:00Z' }),
      assistant([{ type: 'text', text: 'Looking' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }]),
      toolResult('t1', 'a\nb')]);
    expect(kinds(rows)).toEqual(['user', 'text', 'tool']);
    expect(rows[0]).toMatchObject({ text: 'Fix it', timestamp: '2026-11-08T11:00:00Z' });
    expect(rows[2]).toMatchObject({ tool: { name: 'Bash', settled: true, output: 'a\nb', isError: false } });
    expect(new Set(rows.map((row) => row.key)).size).toBe(rows.length);
  });

  it('groups consecutive calls into one row', () => {
    const rows = transcriptRows('chat-one', [assistant([
      { type: 'tool_use', id: 'a', name: 'Bash', input: { command: 'ls' } },
      { type: 'tool_use', id: 'b', name: 'Read', input: { file_path: '/work/r/a.ts' } },
    ]), toolResult('a', 'ok'), toolResult('b', 'boom', true)]);
    expect(kinds(rows)).toEqual(['tool_group']);
    expect(rows[0]).toMatchObject({ group: { failedCount: 1, running: false } });
  });

  it('marks a running call as unsettled', () => {
    const rows = transcriptRows('chat-one', [assistant([{ type: 'tool_use', id: 'a', name: 'Bash', input: { command: 'sleep 1' } }])]);
    expect(rows[0]).toMatchObject({ kind: 'tool', tool: { settled: false } });
  });

  it.each([
    ['a completed turn hides its result', { type: 'result', subtype: 'success', is_error: false, result: 'Done' }, []],
    ['a failed turn shows its reason', { type: 'result', subtype: 'error', is_error: true, result: 'Out of memory' }, ['failed']],
    ['a cancelled turn says stopped', { type: 'result', subtype: 'cancelled', is_error: true, result: '' }, ['stopped']],
  ])('%s', (_name, result, expected) => {
    const rows = transcriptRows('chat-one', [assistant([{ type: 'text', text: 'Work' }]), at(result as AgentEvent)]);
    expect(kinds(rows).slice(1)).toEqual(expected);
  });

  it('shows streamed text as streaming', () => {
    const rows = transcriptRows('chat-one', [event(1, { event: { seq: 1, type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Streaming text' } } } })]);
    expect(rows[0]).toMatchObject({ kind: 'text', text: 'Streaming text', streaming: true });
  });

  it('turns an interruption echo into a system line in the same turn', () => {
    const rows = transcriptRows('chat-one', [user('Go'), assistant([{ type: 'text', text: 'Working' }]),
      at({ type: 'user', message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } } as AgentEvent)]);
    expect(kinds(rows)).toEqual(['user', 'text', 'system']);
    expect(rows[2]).toMatchObject({ subtype: 'talyn_interruption' });
  });

  it.each([
    ['the last turn', false, 'open'],
    ['a turn approved by the next message', true, 'approved'],
  ])('shows the plan of %s', (_name, approved, state) => {
    const events = [user('Plan it'), assistant([{ type: 'text', text: 'Here.\n\n```talyn-plan\n1. Do it\n```' }])];
    if (approved) events.push(user(PLAN_APPROVED_MESSAGE, 2));
    const rows = transcriptRows('chat-one', events);
    const plan = rows.find((row) => row.kind === 'plan');
    expect(plan).toMatchObject({ kind: 'plan', state });
    expect(rows.find((row) => row.kind === 'text')).toMatchObject({ text: 'Here.' });
  });

  it('keeps pending permission requests as rows', () => {
    const rows = transcriptRows('chat-one', [at({ type: 'talyn_permission_request', requestId: 'r1', tool_name: 'Bash', tool_input: { command: 'rm -rf x' } } as unknown as AgentEvent)]);
    expect(rows[0]).toMatchObject({ kind: 'permission', status: 'pending', toolName: 'Bash' });
  });

  it('carries the opened pull request on a Talyn event', () => {
    const rows = transcriptRows('chat-one', [at({ type: 'talyn_pr', ok: true, number: 132020, url: 'https://github.com/o/r/pull/132020' } as unknown as AgentEvent)]);
    expect(rows[0]).toMatchObject({ kind: 'system', subtype: 'talyn_pr', text: 'Opened pull request #132020', url: 'https://github.com/o/r/pull/132020',
      pullRequest: { number: 132020 } });
  });

  it.each([
    ['a pull request retry', { kind: 'pr_retry', attempt: 1, error: 'GitHub rejected the push' }, 'Talyn could not open the pull request. The agent tries to fix the cause.'],
    ['a wake-up', { kind: 'wakeup', wakeupId: 'w', reason: 'Check CI', createdBy: 'agent' }, 'Woke up: Check CI'],
  ])('shows %s from Talyn as one short line', (_name, trigger, text) => {
    const rows = transcriptRows('chat-one', [at({
      type: 'user', message: { content: [{ type: 'text', text: 'The full message body' }] },
      talyn: { kind: 'user_message', origin: 'talyn', trigger },
    } as unknown as AgentEvent)]);
    expect(rows).toEqual([expect.objectContaining({ kind: 'system', subtype: 'talyn_message', text })]);
  });

  it('keeps a Talyn message with no trigger as a bubble', () => {
    const rows = transcriptRows('chat-one', [at({
      type: 'user', message: { content: [{ type: 'text', text: 'Session finished' }] }, talyn: { kind: 'user_message', origin: 'talyn' },
    } as unknown as AgentEvent)]);
    expect(rows).toEqual([expect.objectContaining({ kind: 'user', text: 'Session finished' })]);
  });

  it('bounds long text', () => {
    const rows = transcriptRows('chat-one', [assistant([{ type: 'text', text: 'x'.repeat(ROW_TEXT_LIMIT + 50) }])]);
    expect(rows[0].kind === 'text' && rows[0].text.length).toBe(ROW_TEXT_LIMIT);
  });

  it.each([
    [{ key: 'a', timestamp: null, kind: 'user', text: 'Hi', attachments: 0, files: [] }, 'You said: Hi'],
    [{ key: 'a', timestamp: null, kind: 'text', text: 'Hello', streaming: false }, 'Agent said: Hello'],
    [{ key: 'a', timestamp: null, kind: 'failed', text: 'Crashed' }, 'Turn failed. Crashed'],
  ] as const)('labels a row for screen readers %#', (row, label) => expect(rowLabel(row as TranscriptRow)).toBe(label));
});
