/**
 * Questions from the agent to the person.
 *
 * `claude -p` has no AskUserQuestion tool, and Codex never had one. So an agent
 * in a Talyn session asks with the `talyn_ask_user` tool of Talyn's own MCP
 * server. The tool writes a `talyn_question` event in the chat's transcript, and
 * the agent ends its turn. The turn then ends as `awaiting_input`, the clients
 * draw the question as a card with its options, and a session in a thread wakes
 * the thread, which can answer for the person.
 *
 * Any next message in the chat answers the question: the card, the composer or
 * the thread's `talyn_send_session_message`.
 */
import type { AgentEvent } from './index.js';

/** The MCP tool, as the agent calls it. */
export const ASK_USER_TOOL = 'talyn_ask_user';

/** The transcript event the tool writes. */
export const QUESTION_EVENT_TYPE = 'talyn_question';

export const QUESTION_LIMITS = {
  questions: 4,
  options: 6,
  questionChars: 1000,
  headerChars: 40,
  labelChars: 120,
  descriptionChars: 400,
} as const;

export interface WorkbenchQuestionOption {
  label: string;
  description?: string;
}

export interface WorkbenchQuestionItem {
  question: string;
  /** A short tag for the question, such as "Database". */
  header?: string;
  /** Empty: the person answers in their own words. */
  options: WorkbenchQuestionOption[];
  /** The person may pick more than one option. */
  multiSelect: boolean;
}

/** The `talyn_question` transcript event, without its `type`. */
export interface WorkbenchQuestionEvent {
  id: string;
  questions: WorkbenchQuestionItem[];
}

/** The tool's name as a transcript shows it: `mcp__talyn__talyn_ask_user` from both agents. */
export function isAskUserToolName(name: unknown): boolean {
  return typeof name === 'string' && (name === ASK_USER_TOOL || name.endsWith(`__${ASK_USER_TOOL}`));
}

function clean(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

/**
 * The tool's `questions` argument, checked. The agent writes it, so every limit
 * is an error it can fix, not a silent cut. Strings longer than a limit are
 * cut, because a long question is still a question.
 */
export function normaliseQuestions(
  raw: unknown,
): { ok: true; questions: WorkbenchQuestionItem[] } | { ok: false; error: string } {
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, error: 'questions must be a list with at least one question.' };
  if (raw.length > QUESTION_LIMITS.questions) {
    return { ok: false, error: `Ask at most ${QUESTION_LIMITS.questions} questions at a time.` };
  }
  const questions: WorkbenchQuestionItem[] = [];
  for (const [i, item] of raw.entries()) {
    const q = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
    const question = clean(q.question, QUESTION_LIMITS.questionChars);
    if (!question) return { ok: false, error: `Question ${i + 1} has no text.` };
    const rawOptions = q.options === undefined ? [] : q.options;
    if (!Array.isArray(rawOptions)) return { ok: false, error: `Question ${i + 1}: options must be a list.` };
    if (rawOptions.length > QUESTION_LIMITS.options) {
      return { ok: false, error: `Question ${i + 1}: give at most ${QUESTION_LIMITS.options} options.` };
    }
    const options: WorkbenchQuestionOption[] = [];
    for (const option of rawOptions) {
      const o = (typeof option === 'string' ? { label: option } : option && typeof option === 'object' ? option : {}) as Record<string, unknown>;
      const label = clean(o.label, QUESTION_LIMITS.labelChars);
      if (!label) return { ok: false, error: `Question ${i + 1}: every option needs a label.` };
      if (options.some((existing) => existing.label === label)) {
        return { ok: false, error: `Question ${i + 1}: the option "${label}" is there twice.` };
      }
      const description = clean(o.description, QUESTION_LIMITS.descriptionChars);
      options.push({ label, ...(description ? { description } : {}) });
    }
    if (options.length === 1) return { ok: false, error: `Question ${i + 1}: give two or more options, or none.` };
    const header = clean(q.header, QUESTION_LIMITS.headerChars);
    const multi = q.multi_select ?? q.multiSelect;
    questions.push({ question, ...(header ? { header } : {}), options, multiSelect: multi === true && options.length > 0 });
  }
  return { ok: true, questions };
}

/** A stored `talyn_question` event, or null when it is not one. */
export function parseQuestionEvent(event: Record<string, unknown>): WorkbenchQuestionEvent | null {
  if (event.type !== QUESTION_EVENT_TYPE || typeof event.id !== 'string' || !event.id) return null;
  const parsed = normaliseQuestions(event.questions);
  return parsed.ok ? { id: event.id, questions: parsed.questions } : null;
}

/** The last question one turn asked, or null. */
export function findTurnQuestion(events: readonly AgentEvent[]): WorkbenchQuestionEvent | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const question = parseQuestionEvent(events[i] as unknown as Record<string, unknown>);
    if (question) return question;
  }
  return null;
}

/** One line for a notification, a badge or a thread card: the first question. */
export function questionSummary(question: WorkbenchQuestionEvent): string {
  const first = question.questions[0]?.question ?? '';
  const more = question.questions.length - 1;
  return more > 0 ? `${first} (+${more} more)` : first;
}

/** The questions as plain text, with their options: for an agent that reads them, such as the thread's. */
export function questionText(question: WorkbenchQuestionEvent): string {
  return question.questions
    .map((q, i) => {
      const head = `${question.questions.length > 1 ? `${i + 1}. ` : ''}${q.header ? `[${q.header}] ` : ''}${q.question}`;
      const options = q.options.map((o) => `   - ${o.label}${o.description ? `: ${o.description}` : ''}`);
      const note = q.options.length === 0 ? [] : [`   (${q.multiSelect ? 'one or more' : 'one'} of these, or another answer)`];
      return [head, ...options, ...note].join('\n');
    })
    .join('\n');
}

/** The person's answer to one question: the options they picked and their own words. */
export interface QuestionAnswer {
  selected: string[];
  other?: string;
}

export function isQuestionAnswered(answer: QuestionAnswer | undefined): boolean {
  return Boolean(answer && (answer.selected.length > 0 || answer.other?.trim()));
}

/**
 * The message the question card sends. Each question is repeated, so the agent
 * and a later reader see which answer is which.
 */
export function formatQuestionAnswers(question: WorkbenchQuestionEvent, answers: readonly (QuestionAnswer | undefined)[]): string {
  return question.questions
    .map((q, i) => {
      const answer = answers[i];
      const parts = [...(answer?.selected ?? [])];
      const other = answer?.other?.trim();
      if (other) parts.push(other);
      return `${q.question}\n→ ${parts.length ? parts.join(', ') : '(no answer)'}`;
    })
    .join('\n\n');
}

/** What the tool tells the agent after it records the question. */
export function askUserToolResult(opts: { inThread: boolean }): string {
  return [
    'Talyn shows your question to the person. End your turn now: stop work, and do not guess the answer.',
    opts.inThread
      ? 'This session belongs to a thread, so the thread can answer for the person.'
      : null,
    'The answer arrives as your next message.',
  ]
    .filter(Boolean)
    .join(' ');
}
