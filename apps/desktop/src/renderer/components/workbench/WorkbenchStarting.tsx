import { Loader2 } from 'lucide-react';
import { workbenchQueuesMessages } from '@talyn/shared';
import type { Workbench } from '@talyn/shared';

/** Still being set up, and not failed. An error wins, as in the banner. */
export function isStarting(workbench: Workbench): boolean {
  if (workbench.status === 'error' || workbench.sandboxState === 'error') return false;
  return workbenchQueuesMessages(workbench.status) || workbench.sandboxState === 'creating' || workbench.sandboxState === 'lost';
}

/**
 * The empty chat while the session starts: what it is doing now, and what
 * happens to a message written meanwhile. "Send a message to start" was wrong
 * here, because a message sent now waits in the queue.
 */
export function StartingHint({ workbench, queued }: { workbench: Workbench; queued: number }) {
  const sandbox = workbench.runtime === 'sandbox';
  const ready = sandbox ? 'the sandbox is ready' : 'the worktree is ready';
  return (
    <div className="flex max-w-sm flex-col items-center gap-1.5" data-attr="workbench-starting">
      <Loader2 className="mb-1 h-4 w-4 animate-spin" />
      <p className="text-[13px] font-medium text-foreground">
        {workbench.status === 'moving' ? 'Moving to a fresh sandbox' : workbench.sandboxState === 'lost' ? 'Starting a new sandbox' : sandbox ? 'Starting the sandbox' : 'Creating the worktree'}
      </p>
      {workbench.statusMessage && <p>{workbench.statusMessage}</p>}
      <p>
        {queued === 0
          ? `You can write your first message now. It is sent when ${ready}.`
          : queued === 1
            ? `Your message is queued. It is sent when ${ready}.`
            : `${queued} messages are queued. They are sent in order when ${ready}.`}
      </p>
    </div>
  );
}
