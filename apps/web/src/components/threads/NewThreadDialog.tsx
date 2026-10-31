import React, { useMemo, useState } from 'react';
import { create } from 'zustand';
import { Loader2 } from 'lucide-react';
import {
  defaultFleetModelForAgent,
  storedFleetModelForAgent,
  WORKBENCH_MANUAL_TITLE_MAX,
  type WorkbenchAgent,
} from '@talyn/shared';
import { agentChoice, useReadiness } from '../../lib/readiness';
import { readSessionDefaults } from '../../lib/sessionDefaults';
import { createThread } from '../../lib/threadActions';
import { useWorkspaceStore } from '../../stores/workspace';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';

/** Open from anywhere: the sidebar's Threads header, the new-session page. */
export const useNewThreadDialog = create<{ open: boolean; setOpen: (open: boolean) => void }>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));

/** New thread: a name and a first message. A thread has no repository, so there is no picker. */
export function NewThreadDialog() {
  const open = useNewThreadDialog((s) => s.open);
  const setOpen = useNewThreadDialog((s) => s.setOpen);
  if (!open) return null;
  return <NewThreadForm onClose={() => setOpen(false)} />;
}

const AGENTS: WorkbenchAgent[] = ['claude', 'codex'];

function NewThreadForm({ onClose }: { onClose: () => void }) {
  const workspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const workspace = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === s.currentWorkspaceId) ?? null);
  const readiness = useReadiness(workspaceId);
  const [defaults] = useState(readSessionDefaults);
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A thread runs in a sandbox: the default agent when it can, else the other one.
  const agent = useMemo(() => {
    const ready = { sandbox: readiness.sandbox };
    if (!readiness.sandbox) return defaults.agent;
    return [defaults.agent, ...AGENTS].find((a) => agentChoice(ready, a).available) ?? defaults.agent;
  }, [readiness.sandbox, defaults.agent]);
  const blocked = readiness.sandbox ? agentChoice({ sandbox: readiness.sandbox }, agent) : null;

  const close = () => {
    if (!busy) onClose();
  };

  const submit = async () => {
    if (!workspaceId || !prompt.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await createThread({
        workspaceId,
        name,
        prompt,
        agent,
        model: storedFleetModelForAgent(workspace?.settings, agent) ?? defaultFleetModelForAgent(agent),
        internetAccess: defaults.internetAccess,
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'Could not start the thread.');
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void submit();
    }
  };

  return (
    <Dialog open onOpenChange={(next) => !next && close()}>
      <DialogContent onClose={busy ? undefined : close} className="max-w-lg" data-attr="new-thread-dialog">
        <DialogHeader>
          <DialogTitle>New thread</DialogTitle>
          <DialogDescription>
            A thread has no repository. It plans the work and starts sessions on your repositories.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <label className="block space-y-1 text-xs font-medium">
            <span>Name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={WORKBENCH_MANUAL_TITLE_MAX}
              placeholder="Optional. Talyn names it from the message."
              disabled={busy}
              autoFocus
              className="block h-8 w-full rounded-md border border-input bg-background px-2.5 text-[13px] font-normal placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </label>
          <label className="block space-y-1 text-xs font-medium">
            <span>First message</span>
            <textarea
              value={prompt}
              onChange={(e) => {
                setPrompt(e.target.value);
                if (error) setError(null);
              }}
              onKeyDown={onKeyDown}
              rows={5}
              placeholder="What do you want to get done?"
              disabled={busy}
              className="block w-full resize-y rounded-md border border-input bg-background px-2.5 py-1.5 text-[13px] font-normal placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </label>
          {(error || (blocked && !blocked.available)) && (
            <p role="alert" className="text-xs text-destructive">
              {error ?? blocked?.reason ?? 'Sandbox sessions are not available.'}
            </p>
          )}
          <DialogFooter className="mt-2">
            <Button type="button" variant="ghost" onClick={close} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !prompt.trim() || !workspaceId} data-attr="new-thread-start">
              {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              Start thread
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
