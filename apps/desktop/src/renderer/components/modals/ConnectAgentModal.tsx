import { useEffect, useRef } from 'react';
import { Bot } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '../ui/dialog';
import { ProviderConnectCards } from '../panels/SettingsPanel';
import { useGitHubActions } from '../panels/github/useGitHubActions';
import { useWorkspaceStore } from '../../stores/workspace';
import { trackEvent } from '../../lib/analytics';

/**
 * "Connect an agent to run this." Task buttons render even with no cloud
 * provider connected (so a first-run user can reach them without an onboarding
 * detour); clicking one with nothing connected opens this modal and stashes the
 * task. The moment a provider connects — its env row lands via the
 * `environment:created` push — `providerReady` flips and the stashed task
 * auto-runs, so the user's click isn't wasted.
 *
 * Mounted once in MainLayout, driven by the workspace store.
 */
export function ConnectAgentModal() {
  const open = useWorkspaceStore((s) => s.connectAgentOpen);
  const pending = useWorkspaceStore((s) => s.pendingCloudTask);
  const closeConnectAgent = useWorkspaceStore((s) => s.closeConnectAgent);
  const source = useWorkspaceStore((s) => s.connectAgentSource);
  const { createPostHogTask, runSkillTask, providerReady } = useGitHubActions();
  // Guard against the async fire running twice while it's in flight.
  const firing = useRef(false);
  // One impression per open, not per render: the effect below re-runs whenever
  // the pending task or the provider state changes while the modal is up.
  const announced = useRef(false);

  // The top of the connect funnel. Without it "we asked and they refused" and
  // "we never asked" are the same absence, and the only surface we can see
  // today (Settings) is the one nobody arrives at with a task in mind.
  useEffect(() => {
    if (!open) {
      announced.current = false;
      return;
    }
    if (announced.current) return;
    announced.current = true;
    trackEvent('connect_agent_opened', {
      source: source ?? 'unknown',
      pending_kind: pending?.kind ?? 'none',
      // Already connected when this opened — rare, and it means a dispatch
      // resolved no env for some reason OTHER than "nothing is connected".
      // Recorded rather than filtered, so it cannot quietly pad the funnel.
      provider_ready: providerReady,
    });
  }, [open, source, pending, providerReady]);

  useEffect(() => {
    if (!open || !pending || !providerReady || firing.current) return;
    firing.current = true;
    void (async () => {
      try {
        const dispatched =
          pending.kind === 'fix'
            ? await createPostHogTask(pending.row, pending.providerType, pending.model)
            : await runSkillTask(pending.row, pending.skill, {
                providerType: pending.providerType,
                model: pending.model,
                localContent: pending.localContent,
              });
        // The point of stashing the task is that the click which hit this modal
        // is the one that runs. Recording it is what turns "they connected"
        // into "they connected AND the work they asked for actually started".
        if (dispatched) {
          trackEvent('connect_agent_dispatched', {
            source: source ?? 'unknown',
            pending_kind: pending.kind,
          });
        }
      } finally {
        firing.current = false;
        closeConnectAgent();
      }
    })();
  }, [open, pending, providerReady, source, createPostHogTask, runSkillTask, closeConnectAgent]);

  // Reset the fire guard on close so a later open can dispatch again.
  useEffect(() => {
    if (!open) firing.current = false;
  }, [open]);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) closeConnectAgent();
      }}
    >
      <DialogContent onClose={closeConnectAgent}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Bot className="h-5 w-5" />
            Connect an agent to run this
          </DialogTitle>
          <DialogDescription>
            Talyn hands the actual work to a cloud coding agent. Connect one below and your
            task starts the moment it&rsquo;s ready. You only do this once.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <ProviderConnectCards />
        </div>
      </DialogContent>
    </Dialog>
  );
}
