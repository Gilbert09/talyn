import { describe, expect, it } from 'vitest';
import {
  buildBlocks,
  findTurnQuestion,
  formatQuestionAnswers,
  isAskUserToolName,
  isQuestionAnswered,
  messageSender,
  normaliseQuestions,
  notificationText,
  parseQuestionEvent,
  parseThreadSessionEvent,
  QUESTION_LIMITS,
  questionSummary,
  questionText,
  threadSessionEventText,
  type AgentEvent,
  type WorkbenchEvent,
  type WorkbenchQuestionEvent,
} from '@talyn/shared';

const DB = { question: 'Which database?', header: 'Database', options: [{ label: 'Postgres' }, { label: 'SQLite', description: 'One file' }], multiSelect: false };
const AREAS = { question: 'Which areas?', options: [{ label: 'Auth' }, { label: 'Billing' }], multiSelect: true };
const FREE = { question: 'What should the page be called?', options: [], multiSelect: false };
const ASKED: WorkbenchQuestionEvent = { id: 'q1', questions: [DB, AREAS] };

const ev = (seq: number, event: Record<string, unknown>) => ({ seq, ...event }) as unknown as AgentEvent;

describe('normaliseQuestions', () => {
  it('accepts the tool input and normalises it', () => {
    expect(normaliseQuestions([
      { question: '  Which database? ', header: 'Database', options: [{ label: 'Postgres' }, { label: 'SQLite', description: 'One file' }] },
      { question: 'Which areas?', options: ['Auth', 'Billing'], multi_select: true },
      { question: 'What should the page be called?' },
    ])).toEqual({ ok: true, questions: [DB, AREAS, FREE] });
  });

  it('reads multiSelect as well as multi_select, and never sets it without options', () => {
    const parsed = normaliseQuestions([{ question: 'A?', options: ['x', 'y'], multiSelect: true }, { question: 'B?', multi_select: true }]);
    expect(parsed.ok && parsed.questions.map((q) => q.multiSelect)).toEqual([true, false]);
  });

  it('cuts text that is too long', () => {
    const parsed = normaliseQuestions([{ question: 'q'.repeat(5000), header: 'h'.repeat(100), options: [{ label: 'l'.repeat(500) }, { label: 'b' }] }]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.questions[0].question).toHaveLength(QUESTION_LIMITS.questionChars);
    expect(parsed.questions[0].header).toHaveLength(QUESTION_LIMITS.headerChars);
    expect(parsed.questions[0].options[0].label).toHaveLength(QUESTION_LIMITS.labelChars);
  });

  it.each([
    ['no list', undefined, 'questions must be a list with at least one question.'],
    ['an empty list', [], 'questions must be a list with at least one question.'],
    ['too many questions', Array.from({ length: 5 }, () => ({ question: 'A?' })), 'Ask at most 4 questions at a time.'],
    ['a question with no text', [{ question: '  ' }], 'Question 1 has no text.'],
    ['a question that is not an object', ['A?'], 'Question 1 has no text.'],
    ['options that are not a list', [{ question: 'A?', options: 'x' }], 'Question 1: options must be a list.'],
    ['too many options', [{ question: 'A?', options: ['1', '2', '3', '4', '5', '6', '7'] }], 'Question 1: give at most 6 options.'],
    ['one option', [{ question: 'A?', options: ['only'] }], 'Question 1: give two or more options, or none.'],
    ['an option with no label', [{ question: 'A?' }, { question: 'B?', options: [{ label: 'x' }, { description: 'y' }] }], 'Question 2: every option needs a label.'],
    ['a repeated option', [{ question: 'A?', options: ['x', 'x'] }], 'Question 1: the option "x" is there twice.'],
  ])('refuses %s', (_name, raw, error) => {
    expect(normaliseQuestions(raw)).toEqual({ ok: false, error });
  });
});

describe('the question event', () => {
  it.each([
    ['a question event', { type: 'talyn_question', ...ASKED }, ASKED],
    ['another type', { type: 'talyn_thread', ...ASKED }, null],
    ['no id', { type: 'talyn_question', questions: ASKED.questions }, null],
    ['bad questions', { type: 'talyn_question', id: 'q1', questions: [] }, null],
  ])('parses %s', (_name, event, expected) => {
    expect(parseQuestionEvent(event)).toEqual(expected);
  });

  it('finds the last question of a turn', () => {
    const events = [ev(1, { type: 'talyn_question', id: 'old', questions: [FREE] }), ev(2, { type: 'talyn_question', ...ASKED }), ev(3, { type: 'result' })];
    expect(findTurnQuestion(events)?.id).toBe('q1');
    expect(findTurnQuestion([ev(1, { type: 'result' })])).toBeNull();
  });

  it('summarises and writes out the questions', () => {
    expect(questionSummary(ASKED)).toBe('Which database? (+1 more)');
    expect(questionSummary({ id: 'q', questions: [FREE] })).toBe('What should the page be called?');
    expect(questionText(ASKED)).toBe([
      '1. [Database] Which database?',
      '   - Postgres',
      '   - SQLite: One file',
      '   (one of these, or another answer)',
      '2. Which areas?',
      '   - Auth',
      '   - Billing',
      '   (one or more of these, or another answer)',
    ].join('\n'));
    expect(questionText({ id: 'q', questions: [FREE] })).toBe('What should the page be called?');
  });
});

describe('answers', () => {
  it.each([
    ['nothing', undefined, false],
    ['an empty answer', { selected: [] }, false],
    ['blank own words', { selected: [], other: '  ' }, false],
    ['an option', { selected: ['Postgres'] }, true],
    ['own words', { selected: [], other: 'MySQL' }, true],
  ])('%s answered: %s', (_name, answer, expected) => {
    expect(isQuestionAnswered(answer)).toBe(expected);
  });

  it('repeats each question with its answer', () => {
    expect(formatQuestionAnswers(ASKED, [{ selected: ['Postgres'] }, { selected: ['Auth', 'Billing'], other: ' and logs ' }])).toBe(
      'Which database?\n→ Postgres\n\nWhich areas?\n→ Auth, Billing, and logs',
    );
    expect(formatQuestionAnswers(ASKED, [{ selected: [], other: 'MySQL' }])).toBe('Which database?\n→ MySQL\n\nWhich areas?\n→ (no answer)');
  });
});

describe('the transcript', () => {
  const call = (seq: number, id: string, name: string) =>
    ev(seq, { type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input: { questions: [DB] } }] } });
  const result = (seq: number, id: string, isError = false) =>
    ev(seq, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: isError ? 'Question 1 has no text.' : 'Talyn shows your question.', is_error: isError }] } });

  it.each(['mcp__talyn__talyn_ask_user', 'talyn_ask_user'])('recognises %s', (name) => {
    expect(isAskUserToolName(name)).toBe(true);
  });

  it.each(['AskUserQuestion', 'mcp__talyn__talyn_ask_user_x', undefined])('does not take %s for the tool', (name) => {
    expect(isAskUserToolName(name)).toBe(false);
  });

  it('hides a successful talyn_ask_user call and draws no block for the question event', () => {
    const blocks = buildBlocks([
      call(1, 't1', 'mcp__talyn__talyn_ask_user'),
      result(2, 't1'),
      ev(3, { type: 'talyn_question', ...ASKED }),
      ev(4, { type: 'assistant', message: { content: [{ type: 'text', text: 'I asked.' }] } }),
    ]);
    expect(blocks.map((b) => b.kind)).toEqual(['text']);
  });

  it('shows a failed call with its error', () => {
    const blocks = buildBlocks([call(1, 't1', 'mcp__talyn__talyn_ask_user'), result(2, 't1', true)]);
    expect(blocks.map((b) => b.kind)).toEqual(['tool_use', 'tool_result']);
    expect(blocks[1]).toMatchObject({ isError: true, toolName: 'mcp__talyn__talyn_ask_user' });
  });

  it('leaves other tools alone', () => {
    expect(buildBlocks([call(1, 't1', 'Bash'), result(2, 't1')]).map((b) => b.kind)).toEqual(['tool_use', 'tool_result']);
  });
});

describe('notifications and thread cards', () => {
  const events: WorkbenchEvent[] = [
    { chatId: 'c1', seq: 1, turn: 2, event: ev(1, { type: 'talyn_question', ...ASKED }) },
    { chatId: 'c1', seq: 2, turn: 2, event: ev(2, { type: 'assistant', message: { content: [{ type: 'text', text: 'I asked two questions.' }] } }) },
  ];

  it('names the question in the notification of a chat that waits for an answer', () => {
    expect(notificationText({ status: 'awaiting_input' } as never, { name: 'oslo' }, events)).toEqual({
      title: 'Needs your reply: oslo',
      body: 'Which database? (+1 more)',
    });
  });

  it('shows the question on the thread card', () => {
    const card = parseThreadSessionEvent({ type: 'talyn_thread', action: 'needs_input', sessionId: 's1', name: 'api', repo: 'acme/api', status: 'awaiting_input', question: 'Which database?' });
    expect(card && threadSessionEventText(card)).toBe('Session api on acme/api asks: Which database?');
    const plain = parseThreadSessionEvent({ type: 'talyn_thread', action: 'needs_input', sessionId: 's1', name: 'api', repo: 'acme/api', status: 'awaiting_input' });
    expect(plain && threadSessionEventText(plain)).toBe('Session api on acme/api needs an answer');
  });

  it.each([
    ['a thread sender', { sender: { kind: 'thread', threadId: 't1', name: 'Plan' } }, { kind: 'thread', threadId: 't1', name: 'Plan' }],
    ['a sender with no name', { sender: { kind: 'thread', threadId: 't1' } }, { kind: 'thread', threadId: 't1', name: '' }],
    ['another kind', { sender: { kind: 'person', threadId: 't1' } }, null],
    ['no thread id', { sender: { kind: 'thread' } }, null],
    ['no sender', {}, null],
    ['no talyn block', undefined, null],
  ])('reads the message sender from %s', (_name, talyn, expected) => {
    expect(messageSender(talyn)).toEqual(expected);
  });
});
