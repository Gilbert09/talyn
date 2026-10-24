import React, { useState } from 'react';
import { Check, Hammer, Loader2, NotebookPen } from 'lucide-react';
import { PLAN_APPROVED_MESSAGE, type WorkbenchChat } from '@talyn/shared';
import { api } from '../../lib/api';
import { renderMarkdownish } from '../../lib/markdown';
import { FOCUS_COMPOSER_EVENT } from '../../lib/shortcuts';
import type { WorkbenchOps } from '../../lib/workbenchOps';
import { cn } from '../../lib/utils';
import { useWorkbenchStore } from '../../stores/workbenches';
import { toast } from '../../stores/toast';
import { Button } from '../ui/button';

/**
 * - `open`: the last turn's plan; the person can approve it or keep planning.
 * - `approved`: the next message approved it.
 * - `past`: the chat moved on some other way.
 */
export type PlanCardState = 'open' | 'approved' | 'past';

/**
 * "Approve and build": turn plan mode off for the chat and tell the agent to
 * build. The agent resumes the same session, so the plan is in its context.
 */
export async function approvePlan(chat: WorkbenchChat, ops: WorkbenchOps): Promise<void> {
  try {
    const res = await ops.send(chat, {
      text: PLAN_APPROVED_MESSAGE,
      planMode: false,
    });
    if (res.queued) toast.info('Queued', 'It runs when the current turn ends.');
  } catch (err) {
    toast.error('Could not start the build', err instanceof Error ? err.message : undefined);
    return;
  }
  // The build turn already runs without plan mode; this is for the turns after it.
  setChatPlanMode(chat, false);
}

/**
 * Only `planMode` changes. The chat passed in can be stale by now (the build
 * turn has started), and writing it back whole would undo its running status.
 */
function setChatPlanMode(chat: WorkbenchChat, planMode: boolean): void {
  const apply = (value: boolean) => {
    const store = useWorkbenchStore.getState();
    const current = store.chats[chat.workbenchId]?.find((c) => c.id === chat.id) ?? chat;
    if (current.planMode !== value) store.upsertChat({ ...current, planMode: value });
  };
  apply(planMode);
  api.workbenches.updateChat(chat.id, { planMode }).then(
    (updated) => apply(updated.planMode),
    (err) =>
      toast.error(
        `Could not turn plan mode ${planMode ? 'on' : 'off'}`,
        err instanceof Error ? err.message : undefined,
      ),
  );
}

/** "Keep planning": plan mode stays on (or comes back on), and the composer takes focus. */
export function keepPlanning(chat: WorkbenchChat): void {
  if (!chat.planMode) setChatPlanMode(chat, true);
  window.dispatchEvent(new CustomEvent(FOCUS_COMPOSER_EVENT));
}

export function PlanCard({
  plan,
  state,
  chat,
  ops,
}: {
  plan: string;
  state: PlanCardState;
  /** Required for `open`; the buttons act on this chat. */
  chat?: WorkbenchChat;
  ops?: WorkbenchOps;
}) {
  const [busy, setBusy] = useState(false);
  const running = chat?.status === 'running';
  const blocked = busy || running || Boolean(ops?.unavailable);

  const approve = async () => {
    if (!chat || !ops || blocked) return;
    setBusy(true);
    try {
      await approvePlan(chat, ops);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className={cn(
        'overflow-hidden rounded-lg border',
        state === 'open' ? 'border-sky-500/50 bg-sky-500/[0.04]' : 'border-border bg-muted/30',
      )}
    >
      <div className="flex items-center gap-1.5 border-b border-border/60 px-3 py-1.5 text-[11px] font-medium text-muted-foreground">
        <NotebookPen className="h-3 w-3 text-sky-600 dark:text-sky-400" />
        <span>Plan</span>
        {state === 'approved' && (
          <span className="ml-auto inline-flex items-center gap-1 text-success">
            <Check className="h-3 w-3" /> Approved
          </span>
        )}
      </div>
      <div className="min-w-0 px-3 py-2 text-[13px] text-foreground [overflow-wrap:anywhere]">
        {renderMarkdownish(plan, 'surface')}
      </div>
      {state === 'open' && chat && ops && (
        <div className="flex flex-wrap items-center gap-2 border-t border-border/60 px-3 py-2">
          <Button size="sm" onClick={() => void approve()} disabled={blocked}>
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Hammer className="h-3.5 w-3.5" />}
            Approve and build
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => keepPlanning(chat)}
            disabled={busy}
            title="Plan mode stays on. Tell the agent what to change."
          >
            Keep planning
          </Button>
          {ops.unavailable && <span className="text-[11px] text-muted-foreground">{ops.unavailable}</span>}
        </div>
      )}
    </div>
  );
}
