import { useState } from 'react';
import { AlarmClock, Terminal } from 'lucide-react';
import { messageTriggerText, type WorkbenchMessageTrigger } from '@talyn/shared';

export function TriggerRow({ trigger, text }: { trigger: WorkbenchMessageTrigger; text: string }) {
  const [open, setOpen] = useState(false);
  const Icon = trigger.kind === 'wakeup' ? AlarmClock : Terminal;
  return (
    <div className="rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
      <div className="flex items-center gap-2">
        <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
        <span className="min-w-0 flex-1">{messageTriggerText(trigger)}</span>
        {trigger.kind === 'job_exit' && text && (
          <button type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open} className="shrink-0 text-foreground hover:underline">
            {open ? 'Hide output' : 'Show output'}
          </button>
        )}
      </div>
      {open && trigger.kind === 'job_exit' && (
        <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-background p-2 font-mono text-xs text-foreground">{text}</pre>
      )}
    </div>
  );
}
