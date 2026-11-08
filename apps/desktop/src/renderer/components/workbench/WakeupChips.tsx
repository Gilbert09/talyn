import { X } from 'lucide-react';
import { api } from '../../lib/api';
import { formatCountdown } from '../../lib/sessionBackground';
import { useNow } from '../../hooks/useSessionBackground';
import { useScheduledWakeupsForChat } from '../../stores/sessionBackground';
import { toast } from '../../stores/toast';

export function WakeupChips({ workbenchId, chatId }: { workbenchId: string; chatId: string | null }) {
  if (!chatId) return null;
  return <OfferedWakeupChips workbenchId={workbenchId} chatId={chatId} />;
}

function OfferedWakeupChips({ workbenchId, chatId }: { workbenchId: string; chatId: string }) {
  const wakeups = useScheduledWakeupsForChat(workbenchId, chatId);
  const now = useNow(15_000);
  if (!wakeups.length) return null;
  return (
    <div className="mb-2 flex flex-wrap gap-1.5">
      {wakeups.map((wakeup) => (
        <span key={wakeup.id} data-testid="wakeup-chip" className="inline-flex max-w-full items-center gap-1 rounded-full border bg-muted/50 px-2 py-1 text-xs text-muted-foreground" title={`${formatCountdown(wakeup.wakeAt, now)}: ${wakeup.reason}`}>
          <span className="min-w-0 truncate">{formatCountdown(wakeup.wakeAt, now)}: {wakeup.reason}</span>
          <button type="button" aria-label={`Cancel wake-up: ${wakeup.reason}`} className="rounded-full p-0.5 hover:bg-accent hover:text-foreground" onClick={() => {
            void api.workbenches.cancelWakeup(workbenchId, wakeup.id).catch((error: unknown) => toast.error('Could not cancel wake-up', error instanceof Error ? error.message : undefined));
          }}><X className="h-3 w-3" /></button>
        </span>
      ))}
    </div>
  );
}
