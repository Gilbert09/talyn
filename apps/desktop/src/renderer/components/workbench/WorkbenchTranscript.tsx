import React, { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { History, Loader2 } from 'lucide-react';
import type { WorkbenchChat, WorkbenchEvent } from '@talyn/shared';
import { AgentBlocks } from '../terminal/AgentConversation';
import { renderMarkdownish } from '../../lib/markdown';
import { chatTotals, compactCount, splitTurns, type TranscriptTurn } from '../../lib/workbenchFormat';
import type { WorkbenchOps } from '../../lib/workbenchOps';
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
}: {
  chat: WorkbenchChat;
  events: WorkbenchEvent[];
  loading: boolean;
  error: string | null;
  ops: WorkbenchOps;
  emptyHint?: React.ReactNode;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const wasAtBottomRef = useRef(true);
  const turns = useStableTurns(events);
  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (el) wasAtBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 200;
  }, []);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && wasAtBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [events.length, chat.id]);

  const running = chat.status === 'running';
  const totals = useMemo(() => chatTotals(events), [events]);

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
        <div className="space-y-3">
          {turns.map((turn, i) => (
            <TurnView
              key={`${chat.id}:${turn.turn}:${turn.userSeq ?? i}`}
              chatId={chat.id}
              turn={turn}
              ops={ops}
              canRevert={!running && !ops.unavailable && turn.userText !== null}
            />
          ))}
          {running && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" /> Working…
            </div>
          )}
        </div>
      </div>
      {totals.turns > 0 && <ChatTotalsFooter totals={totals} />}
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
        prev && prev.size === turn.events.length && prev.last === last && prev.turn.userText === turn.userText
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
function ChatTotalsFooter({ totals }: { totals: ReturnType<typeof chatTotals> }) {
  return (
    <div className="flex shrink-0 flex-wrap items-center justify-end gap-x-3 gap-y-1 border-t border-border px-4 py-1.5 text-xs text-muted-foreground">
      <span>
        {totals.turns} {totals.turns === 1 ? 'turn' : 'turns'}
      </span>
      {totals.costUsd !== null && <span>${totals.costUsd.toFixed(2)}</span>}
      <span title="Tokens the model read (cache included) and wrote, over every turn">
        {compactCount(totals.inputTokens)} in · {compactCount(totals.outputTokens)} out
      </span>
    </div>
  );
}

const TurnView = React.memo(function TurnView({
  chatId,
  turn,
  ops,
  canRevert,
}: {
  chatId: string;
  turn: TranscriptTurn;
  ops: WorkbenchOps;
  canRevert: boolean;
}) {
  return (
    <div className="space-y-3">
      {turn.userText !== null && (
        <UserMessage chatId={chatId} turn={turn.turn} text={turn.userText} ops={ops} canRevert={canRevert} />
      )}
      {turn.events.length > 0 && (
        <AgentBlocks events={turn.events} scopeId={`${chatId}:${turn.turn}`} hideCompletedResults />
      )}
    </div>
  );
});

function UserMessage({
  chatId,
  turn,
  text,
  ops,
  canRevert,
}: {
  chatId: string;
  turn: number;
  text: string;
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
          {renderMarkdownish(text)}
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
