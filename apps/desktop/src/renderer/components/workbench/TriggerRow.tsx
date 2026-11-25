import { useState } from 'react';
import { AlarmClock, CircleCheck, CircleX, GitPullRequestArrow, ScanSearch, Terminal } from 'lucide-react';
import { messageTriggerText, type WorkbenchMessageTrigger } from '@talyn/shared';

function triggerIcon(trigger: WorkbenchMessageTrigger) {
  switch (trigger.kind) {
    case 'job_exit':
      return Terminal;
    case 'pr_retry':
      return GitPullRequestArrow;
    case 'code_review':
      return ScanSearch;
    case 'wakeup':
      return trigger.ci === 'passing' ? CircleCheck : trigger.ci === 'failing' ? CircleX : AlarmClock;
  }
}

/** What the toggle shows: a job's output, the error a pull request retry gives the agent, or the review report. */
function triggerDetail(trigger: WorkbenchMessageTrigger, text: string): { detail: string; noun: string } {
  switch (trigger.kind) {
    case 'job_exit':
      return { detail: text, noun: 'output' };
    case 'pr_retry':
      return { detail: trigger.error, noun: 'error' };
    case 'code_review':
      return { detail: text, noun: 'message' };
    case 'wakeup':
      return { detail: '', noun: 'output' };
  }
}

export function TriggerRow({ trigger, text }: { trigger: WorkbenchMessageTrigger; text: string }) {
  const [open, setOpen] = useState(false);
  const Icon = triggerIcon(trigger);
  const { detail, noun } = triggerDetail(trigger, text);
  return (
    <div className="rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
      <div className="flex items-center gap-2">
        <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
        <span className="min-w-0 flex-1">{messageTriggerText(trigger)}</span>
        {detail && (
          <button type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open} className="shrink-0 text-foreground hover:underline">
            {open ? `Hide ${noun}` : `Show ${noun}`}
          </button>
        )}
      </div>
      {open && detail && (
        <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-background p-2 font-mono text-xs text-foreground">{detail}</pre>
      )}
    </div>
  );
}
