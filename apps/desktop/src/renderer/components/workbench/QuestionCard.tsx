import React, { useState } from 'react';
import { Check, Loader2, MessageCircleQuestion, Send } from 'lucide-react';
import {
  formatQuestionAnswers,
  isQuestionAnswered,
  type QuestionAnswer,
  type WorkbenchChat,
  type WorkbenchMessageSender,
  type WorkbenchQuestionEvent,
  type WorkbenchQuestionItem,
} from '@talyn/shared';
import type { WorkbenchOps } from '../../lib/workbenchOps';
import { cn } from '../../lib/utils';
import { toast } from '../../stores/toast';
import { maybeHandleBillingLimit } from '../../stores/billing';
import { Button } from '../ui/button';

/**
 * - `open`: the last turn asked, and the chat waits. The person can answer.
 * - `waiting`: the last turn asked, but the chat runs or a message is on its way.
 * - `answered`: a later message answered it.
 */
export type QuestionCardState = 'open' | 'waiting' | 'answered';

/** Sends the answer as the chat's next message. Returns true when it was sent. */
export async function answerQuestion(chat: WorkbenchChat, ops: WorkbenchOps, text: string): Promise<boolean> {
  try {
    const res = await ops.send(chat, { text });
    if (res.queued) toast.info('Queued', 'It runs when the current turn ends.');
    return true;
  } catch (err) {
    if (maybeHandleBillingLimit(err, 'session_question_answer')) return false;
    toast.error('Could not send the answer', err instanceof Error ? err.message : undefined);
    return false;
  }
}

/** One question, one single-select list of options: a click on an option sends it. */
function sendsOnPick(question: WorkbenchQuestionEvent): boolean {
  const only = question.questions.length === 1 ? question.questions[0] : null;
  return Boolean(only && !only.multiSelect && only.options.length > 0);
}

export function QuestionCard({
  question,
  state,
  answeredBy = null,
  chat,
  ops,
}: {
  question: WorkbenchQuestionEvent;
  state: QuestionCardState;
  /** The thread that wrote the answer. Null when the person answered. */
  answeredBy?: WorkbenchMessageSender | null;
  /** Required for `open`; the card sends to this chat. */
  chat?: WorkbenchChat;
  ops?: WorkbenchOps;
}) {
  const [answers, setAnswers] = useState<QuestionAnswer[]>(() => question.questions.map(() => ({ selected: [] })));
  const [busy, setBusy] = useState(false);
  const open = state === 'open' && Boolean(chat && ops);
  const blocked = busy || chat?.status === 'running' || Boolean(ops?.unavailable);
  const instant = sendsOnPick(question);
  const complete = answers.every((answer) => isQuestionAnswered(answer));

  const send = async (next: QuestionAnswer[]) => {
    if (!chat || !ops || blocked) return;
    setBusy(true);
    try {
      await answerQuestion(chat, ops, formatQuestionAnswers(question, next));
    } finally {
      setBusy(false);
    }
  };

  const update = (index: number, answer: QuestionAnswer) =>
    setAnswers((current) => current.map((a, i) => (i === index ? answer : a)));

  const pick = (index: number, item: WorkbenchQuestionItem, label: string) => {
    const current = answers[index];
    if (instant) {
      void send([{ selected: [label] }]);
      return;
    }
    if (item.multiSelect) {
      const selected = current.selected.includes(label)
        ? current.selected.filter((l) => l !== label)
        : [...current.selected, label];
      update(index, { ...current, selected });
    } else {
      // Like a radio button: an option replaces the other answer.
      update(index, { selected: [label] });
    }
  };

  const setOther = (index: number, item: WorkbenchQuestionItem, other: string) => {
    const current = answers[index];
    update(index, item.multiSelect || !other.trim() ? { ...current, other } : { selected: [], other });
  };

  const answeredLabel = answeredBy ? `Answered by thread ${answeredBy.name}`.trim() : 'Answered';

  return (
    <div
      className={cn(
        'overflow-hidden rounded-lg border',
        open ? 'border-sky-500/50 bg-sky-500/[0.04]' : 'border-border bg-muted/30',
      )}
      data-attr="question-card"
    >
      <div className="flex items-center gap-1.5 border-b border-border/60 px-3 py-1.5 text-[11px] font-medium text-muted-foreground">
        <MessageCircleQuestion className="h-3 w-3 text-sky-600 dark:text-sky-400" />
        <span>{question.questions.length > 1 ? 'Questions' : 'Question'}</span>
        {state === 'answered' && (
          <span className="ml-auto inline-flex items-center gap-1 text-success">
            <Check className="h-3 w-3" /> {answeredLabel}
          </span>
        )}
      </div>
      <div className="space-y-3 px-3 py-2">
        {question.questions.map((item, index) => (
          <QuestionItem
            key={index}
            index={index}
            item={item}
            answer={answers[index]}
            open={open}
            disabled={blocked}
            instant={instant}
            onPick={(label) => pick(index, item, label)}
            onOther={(text) => setOther(index, item, text)}
            onSubmitOther={() => {
              if (complete) void send(answers);
            }}
          />
        ))}
      </div>
      {open && ops && (!instant || ops.unavailable) && (
        <div className="flex flex-wrap items-center gap-2 border-t border-border/60 px-3 py-2">
          {!instant && (
            <Button size="sm" onClick={() => void send(answers)} disabled={blocked || !complete}>
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
              {question.questions.length > 1 ? 'Send answers' : 'Send answer'}
            </Button>
          )}
          {ops.unavailable && <span className="text-[11px] text-muted-foreground">{ops.unavailable}</span>}
        </div>
      )}
    </div>
  );
}

function QuestionItem({
  index,
  item,
  answer,
  open,
  disabled,
  instant,
  onPick,
  onOther,
  onSubmitOther,
}: {
  index: number;
  item: WorkbenchQuestionItem;
  answer: QuestionAnswer;
  open: boolean;
  disabled: boolean;
  instant: boolean;
  onPick: (label: string) => void;
  onOther: (text: string) => void;
  onSubmitOther: () => void;
}) {
  const role = instant ? undefined : item.multiSelect ? 'checkbox' : 'radio';
  const otherLabel = item.options.length ? 'Other answer' : 'Your answer';
  return (
    <div className="space-y-1.5">
      <div className="flex items-start gap-1.5 text-[13px] text-foreground">
        {item.header && (
          <span className="mt-px shrink-0 rounded bg-sky-500/10 px-1.5 py-px text-[11px] font-medium text-sky-700 dark:text-sky-300">
            {item.header}
          </span>
        )}
        <span className="min-w-0 whitespace-pre-wrap font-medium [overflow-wrap:anywhere]">{item.question}</span>
      </div>
      {item.multiSelect && open && <div className="text-[11px] text-muted-foreground">Pick one or more.</div>}
      {item.options.length > 0 && (
        <div
          className="flex flex-col gap-1"
          role={open && role ? (item.multiSelect ? 'group' : 'radiogroup') : undefined}
          aria-label={open && role ? item.question : undefined}
        >
          {item.options.map((option) => {
            const selected = answer.selected.includes(option.label);
            const content = (
              <>
                <span className="font-medium">{option.label}</span>
                {option.description && <span className="block text-[12px] text-muted-foreground">{option.description}</span>}
              </>
            );
            if (!open) {
              return (
                <div key={option.label} className="rounded-md border border-border/60 px-2.5 py-1.5 text-[13px] [overflow-wrap:anywhere]">
                  {content}
                </div>
              );
            }
            return (
              <button
                key={option.label}
                type="button"
                role={role}
                aria-checked={role ? selected : undefined}
                disabled={disabled}
                onClick={() => onPick(option.label)}
                className={cn(
                  'rounded-md border px-2.5 py-1.5 text-left text-[13px] transition-colors [overflow-wrap:anywhere] hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50',
                  selected ? 'border-sky-500 bg-sky-500/10' : 'border-border bg-background',
                )}
              >
                {content}
              </button>
            );
          })}
        </div>
      )}
      {open && (
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={answer.other ?? ''}
            disabled={disabled}
            onChange={(e) => onOther(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                e.preventDefault();
                onSubmitOther();
              }
            }}
            placeholder={item.options.length ? 'Other…' : 'Type your answer…'}
            aria-label={`${otherLabel} ${index + 1}`}
            className="h-8 w-full rounded-md border border-input bg-background px-2.5 text-[13px] placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
          />
          {instant && (
            <Button
              size="sm"
              variant="outline"
              aria-label="Send answer"
              onClick={onSubmitOther}
              disabled={disabled || !answer.other?.trim()}
            >
              <Send className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
