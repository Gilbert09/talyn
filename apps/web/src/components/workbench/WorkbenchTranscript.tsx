import React, { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { History, Loader2 } from 'lucide-react';
import { findTurnPlan, PLAN_APPROVED_MESSAGE, type WorkbenchChat, type WorkbenchEvent } from '@talyn/shared';
import { AgentBlocks } from './AgentBlocks';
import { renderMarkdownish } from '../../lib/markdown';
import { chatTotals, compactCount, splitTurns, type TranscriptTurn } from '../../lib/workbenchFormat';
import type { WorkbenchOps } from '../../lib/workbenchOps';
import { PlanCard, type PlanCardState } from './PlanCard';
import { MessageAttachments } from './MessageAttachments';
import { toast } from '../../stores/toast';

/**
 * A chat's transcript: each turn is the user's message, then the agent's
 * blocks rendered by the same components as a task transcript. The user's
 * message carries the "revert to here" affordance — restore the files to how
 * they were before that message was sent.
 */
export function WorkbenchTranscript({
  chat,
  events,
  loading,
  error,
  ops,
  emptyHint,
  older = NO_OLDER,
}: {
  chat: WorkbenchChat;
  events: WorkbenchEvent[];
  loading: boolean;
  error: string | null;
  ops: WorkbenchOps;
  emptyHint?: React.ReactNode;
  /** Paging backwards: the transcript holds the newest events and loads older ones as it scrolls up. */
  older?: OlderHistory;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const wasAtBottomRef = useRef(true);
  const turns = useStableTurns(events);
  const firstSeq = events.length ? events[0].seq : null;
  const prevFirstSeqRef = useRef(firstSeq);
  const prevChatIdRef = useRef(chat.id);
  // The content height at the last layout or scroll, to keep the view still when a page lands above it.
  const prevHeightRef = useRef(0);
  const olderRef = useRef(older);
  olderRef.current = older;

  const maybeLoadOlder = useCallback(() => {
    const el = scrollRef.current;
    const o = olderRef.current;
    if (!el || !o.hasOlder || o.loading || o.error) return;
    if (el.scrollTop < LOAD_OLDER_THRESHOLD_PX) void o.load();
  }, []);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    wasAtBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 200;
    prevHeightRef.current = el.scrollHeight;
    maybeLoadOlder();
  }, [maybeLoadOlder]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // Another chat opens at its bottom, like the first one did.
    if (prevChatIdRef.current !== chat.id) {
      prevChatIdRef.current = chat.id;
      prevFirstSeqRef.current = null;
      wasAtBottomRef.current = true;
    }
    const prepended = firstSeq !== null && prevFirstSeqRef.current !== null && firstSeq < prevFirstSeqRef.current;
    if (wasAtBottomRef.current) el.scrollTop = el.scrollHeight;
    else if (prepended) el.scrollTop += el.scrollHeight - prevHeightRef.current;
    prevFirstSeqRef.current = firstSeq;
    prevHeightRef.current = el.scrollHeight;
    // A page that does not fill the view gives no scroll to react to.
    maybeLoadOlder();
  }, [events.length, firstSeq, chat.id, older.hasOlder, older.loading, maybeLoadOlder]);

  const running = chat.status === 'running';
  const totals = useMemo(() => chatTotals(events), [events]);
  const plans = useMemo(() => turns.map((turn) => findTurnPlan(turn.events)), [turns]);

  return (
    <div className="flex h-full min-w-0 flex-col bg-background">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="min-h-0 min-w-0 flex-1 overflow-auto px-4 py-4 text-sm text-foreground"
      >
        {error && <p className="mb-3 text-xs text-destructive">Could not load this chat: {error}</p>}
        {turns.length === 0 && !loading && (
          <div className="flex h-full items-center justify-center text-center text-xs text-muted-foreground">
            {emptyHint ?? 'Send a message to start.'}
          </div>
        )}
        {loading && turns.length === 0 && (
          <div className="flex h-full items-center justify-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading the chat…
          </div>
        )}
        {older.hasOlder && turns.length > 0 && <OlderRow older={older} />}
        <div className="space-y-3">
          {turns.map((turn, i) => {
            const plan = plans[i];
            const last = i === turns.length - 1;
            const planState: PlanCardState = last
              ? 'open'
              : turns[i + 1].userText === PLAN_APPROVED_MESSAGE
                ? 'approved'
                : 'past';
            return (
              <TurnView
                key={`${chat.id}:${turn.turn}:${turn.userSeq ?? i}`}
                chatId={chat.id}
                turn={turn}
                ops={ops}
                canRevert={!running && !ops.unavailable && turn.userText !== null}
                plan={
                  plan ? (
                    <PlanCard plan={plan} state={planState} {...(last && planState === 'open' ? { chat, ops } : {})} />
                  ) : null
                }
              />
            );
          })}
          {running && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" /> Working…
            </div>
          )}
        </div>
      </div>
      {totals.turns > 0 && <ChatTotalsFooter totals={totals} partial={older.hasOlder} />}
    </div>
  );
}

/** Paging state for the transcript's older history. */
export interface OlderHistory {
  hasOlder: boolean;
  loading: boolean;
  error: string | null;
  load: () => Promise<void> | void;
}

const NO_OLDER: OlderHistory = { hasOlder: false, loading: false, error: null, load: () => undefined };

/** How close to the top a scroll must come before the next older page loads. */
const LOAD_OLDER_THRESHOLD_PX = 400;

/** The row above the oldest loaded turn. A fixed height, so it never moves the content when it changes. */
function OlderRow({ older }: { older: OlderHistory }) {
  return (
    <div className="mb-3 flex h-6 items-center justify-center gap-2 text-xs text-muted-foreground">
      {older.error ? (
        <>
          <span>Could not load earlier messages.</span>
          <button type="button" onClick={() => void older.load()} className="rounded px-1.5 text-foreground hover:bg-accent">
            Retry
          </button>
        </>
      ) : older.loading ? (
        <>
          <Loader2 className="h-3 w-3 animate-spin" /> Loading earlier messages…
        </>
      ) : null}
    </div>
  );
}

/**
 * `splitTurns`, keeping the previous object for every turn that did not
 * change. A live turn appends an event many times a second; without this every
 * earlier turn would rebuild its blocks on each one.
 */
function useStableTurns(events: WorkbenchEvent[]): TranscriptTurn[] {
  const cache = useRef(new Map<string, { size: number; last: number; turn: TranscriptTurn }>());
  return useMemo(() => {
    const next = new Map<string, { size: number; last: number; turn: TranscriptTurn }>();
    const out = splitTurns(events).map((turn, i) => {
      const key = `${turn.turn}:${turn.userSeq ?? i}`;
      const last = turn.events.length ? turn.events[turn.events.length - 1].seq : -1;
      const prev = cache.current.get(key);
      const kept =
        prev &&
        prev.size === turn.events.length &&
        prev.last === last &&
        prev.turn.userText === turn.userText &&
        prev.turn.attachments.length === turn.attachments.length
          ? prev.turn
          : turn;
      next.set(key, { size: turn.events.length, last, turn: kept });
      return kept;
    });
    cache.current = next;
    return out;
  }, [events]);
}

/** The chat's spend so far, pinned under the transcript so it never scrolls away. */
function ChatTotalsFooter({ totals, partial }: { totals: ReturnType<typeof chatTotals>; partial: boolean }) {
  return (
    <div
      className="flex shrink-0 flex-wrap items-center justify-end gap-x-3 gap-y-1 border-t border-border px-4 py-1.5 text-xs text-muted-foreground"
      title={partial ? 'These totals cover the loaded messages. Scroll up to load earlier ones.' : undefined}
    >
      <span>
        {partial && 'Last '}
        {totals.turns} {totals.turns === 1 ? 'turn' : 'turns'}
      </span>
      {totals.costUsd !== null && (
        <span title="What these turns would cost at Anthropic's API prices. Runs on your subscription are not billed this amount; they count toward your plan's usage limits.">
          ≈ ${totals.costUsd.toFixed(2)} at API prices
        </span>
      )}
      <span title="Each step of a turn re-reads the whole conversation, so input adds up quickly. Cached tokens cost about a tenth of fresh ones.">
        {compactCount(totals.inputTokens)} in
        {totals.cachedInputTokens > 0 && ` (${compactCount(totals.cachedInputTokens)} cached)`} ·{' '}
        {compactCount(totals.outputTokens)} out
      </span>
    </div>
  );
}

const TurnView = React.memo(function TurnView({
  chatId,
  turn,
  ops,
  canRevert,
  plan,
}: {
  chatId: string;
  turn: TranscriptTurn;
  ops: WorkbenchOps;
  canRevert: boolean;
  /** The turn's plan card, drawn after its blocks. */
  plan: React.ReactNode;
}) {
  return (
    <div className="space-y-3">
      {turn.userText !== null && (
        <UserMessage
          chatId={chatId}
          turn={turn.turn}
          text={turn.userText}
          attachments={turn.attachments}
          ops={ops}
          canRevert={canRevert}
        />
      )}
      {turn.events.length > 0 && (
        <AgentBlocks events={turn.events} scopeId={`${chatId}:${turn.turn}`} hideCompletedResults />
      )}
      {plan}
    </div>
  );
});

function UserMessage({
  chatId,
  turn,
  text,
  attachments,
  ops,
  canRevert,
}: {
  chatId: string;
  turn: number;
  text: string;
  attachments: TranscriptTurn['attachments'];
  ops: WorkbenchOps;
  canRevert: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const restore = async () => {
    setBusy(true);
    try {
      await ops.restoreCheckpoint(chatId, turn);
      toast.success('Files restored', `The working tree is back to how it was before message ${turn}.`);
      setConfirming(false);
    } catch (err) {
      toast.error('Could not restore the files', err instanceof Error ? err.message : undefined);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="group flex justify-end">
      <div className="max-w-[85%] space-y-1">
        <div className="rounded-lg bg-muted px-3 py-2 text-[13px] text-foreground [overflow-wrap:anywhere]">
          {renderMarkdownish(text, 'surface')}
          {attachments.length > 0 && <MessageAttachments attachments={attachments} ops={ops} />}
        </div>
        {canRevert && (
          <div className="flex justify-end gap-1.5 text-[11px] text-muted-foreground">
            {confirming ? (
              <>
                <span>Restore the files to before this message? Later changes are lost.</span>
                <button
                  type="button"
                  onClick={() => void restore()}
                  disabled={busy}
                  className="rounded px-1.5 text-warning hover:bg-accent disabled:opacity-50"
                >
                  {busy ? <Loader2 className="inline h-3 w-3 animate-spin" /> : 'Restore'}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirming(false)}
                  disabled={busy}
                  className="rounded px-1.5 hover:bg-accent"
                >
                  Cancel
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={() => setConfirming(true)}
                className="inline-flex items-center gap-1 rounded px-1.5 opacity-0 hover:bg-accent hover:text-foreground group-hover:opacity-100"
                title="Restore the files to how they were before this message"
              >
                <History className="h-3 w-3" /> Revert to here
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
