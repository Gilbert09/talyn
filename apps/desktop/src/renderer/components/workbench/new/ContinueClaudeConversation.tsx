import { useCallback, useEffect, useMemo, useState } from 'react';
import { create } from 'zustand';
import { Check, Circle, Loader2 } from 'lucide-react';
import type { ClaudeConversation } from '../../../../workbenchBridgeTypes';
import { cn } from '../../../lib/utils';
import { getWorkbenchBridge } from '../../../lib/workbenchBridge';
import {
  CLAUDE_IMPORT_NOTICE,
  CLAUDE_IMPORT_STEP_LABEL,
  CLAUDE_IMPORT_STEPS,
  ClaudeImportError,
  continueClaudeConversation,
  type ClaudeImportStep,
} from '../../../lib/claudeImport';
import { readSessionDefaults } from '../../../lib/sessionDefaults';
import { useNavigationStore } from '../../../stores/navigation';
import type { WatchedRepo } from '../../../stores/workspace';
import { Button } from '../../ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../ui/dialog';
import { timeAgo } from './RecentWorkbenches';

/** Whether the "Continue a Claude Code conversation" dialog is open. The palette opens it too. */
export const useClaudeImportDialog = create<{ open: boolean; setOpen: (open: boolean) => void }>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));

/** The desktop can read local conversations: an older main process has no such bridge. */
export function claudeImportAvailable(): boolean {
  return Boolean(getWorkbenchBridge()?.claudeImport);
}

type Phase =
  | { kind: 'list' }
  | { kind: 'confirm'; conversation: ClaudeConversation }
  | { kind: 'running'; step: ClaudeImportStep }
  | { kind: 'failed'; step: ClaudeImportStep; message: string; workbenchId: string | null };

function shortFolder(path: string | null): string {
  if (!path) return 'Unknown folder';
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : path;
}

function size(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function agoText(iso: string): string {
  const ago = timeAgo(iso);
  return ago === 'now' ? 'just now' : `${ago} ago`;
}

function labelOf(c: ClaudeConversation): string {
  return (c.firstPrompt ?? c.title ?? 'Untitled conversation').replace(/\s+/g, ' ').trim();
}

/**
 * Pick a local Claude Code conversation, confirm what leaves the machine, then
 * continue it in a new Claude sandbox session. `blockedReason` is why a
 * sandbox Claude session cannot start now, or null.
 */
export function ContinueClaudeConversationDialog({
  workspaceId,
  repositories,
  blockedReason,
}: {
  workspaceId: string | null;
  repositories: WatchedRepo[];
  blockedReason: string | null;
}) {
  const open = useClaudeImportDialog((s) => s.open);
  const setOpen = useClaudeImportDialog((s) => s.setOpen);
  const [phase, setPhase] = useState<Phase>({ kind: 'list' });
  const [conversations, setConversations] = useState<ClaudeConversation[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const repoNames = useMemo(() => repositories.map((r) => r.fullName), [repositories]);
  const busy = phase.kind === 'running';

  useEffect(() => {
    if (!open) return;
    setPhase({ kind: 'list' });
    setConversations(null);
    setListError(null);
    const bridge = getWorkbenchBridge();
    if (!bridge?.claudeImport) {
      setListError('This version of the app cannot read local conversations.');
      return;
    }
    let cancelled = false;
    bridge.claudeImport
      .list(repoNames)
      .then((list) => !cancelled && setConversations(list))
      .catch((err: unknown) => !cancelled && setListError(err instanceof Error ? err.message : 'Could not read your conversations.'));
    return () => {
      cancelled = true;
    };
  }, [open, repoNames]);

  const close = useCallback(() => {
    if (!busy) setOpen(false);
  }, [busy, setOpen]);

  const start = async (conversation: ClaudeConversation) => {
    const bridge = getWorkbenchBridge();
    const repo = repositories.find((r) => r.fullName.toLowerCase() === conversation.repoFullName?.toLowerCase());
    if (!bridge || !workspaceId || !repo) return;
    const defaults = readSessionDefaults();
    setPhase({ kind: 'running', step: 'create' });
    try {
      await continueClaudeConversation({
        bridge,
        conversation,
        workspaceId,
        repositoryId: repo.id,
        internetAccess: defaults.internetAccess,
        autoCreatePr: defaults.autoCreatePr,
        onStep: (step) => setPhase({ kind: 'running', step }),
      });
      setOpen(false);
    } catch (err) {
      const failed = err instanceof ClaudeImportError ? err : null;
      setPhase({
        kind: 'failed',
        step: failed?.step ?? 'upload',
        message: err instanceof Error && err.message ? err.message : 'The import failed.',
        workbenchId: failed?.workbenchId ?? null,
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && close()}>
      <DialogContent onClose={busy ? undefined : close} className="max-w-xl" data-attr="claude-import-dialog">
        <DialogHeader>
          <DialogTitle>Continue a Claude Code conversation</DialogTitle>
          <DialogDescription>Pick a conversation from this machine. It continues in a new sandbox session.</DialogDescription>
        </DialogHeader>

        {phase.kind === 'list' && (
          <ConversationList
            conversations={conversations}
            error={listError}
            blockedReason={blockedReason}
            onPick={(conversation) => setPhase({ kind: 'confirm', conversation })}
          />
        )}

        {phase.kind === 'confirm' && (
          <div className="space-y-3">
            <p className="truncate text-sm font-medium" title={labelOf(phase.conversation)}>
              {labelOf(phase.conversation)}
            </p>
            <p className="rounded-md border border-border bg-muted/40 p-3 text-sm text-muted-foreground" role="note">
              {CLAUDE_IMPORT_NOTICE}
            </p>
            <DialogFooter>
              <Button variant="outline" onClick={() => setPhase({ kind: 'list' })}>
                Cancel
              </Button>
              <Button onClick={() => void start(phase.conversation)} data-attr="claude-import-continue">
                Continue
              </Button>
            </DialogFooter>
          </div>
        )}

        {(phase.kind === 'running' || phase.kind === 'failed') && (
          <div className="space-y-3">
            <ol className="space-y-1.5 text-sm" aria-live="polite">
              {CLAUDE_IMPORT_STEPS.map((step, i) => {
                const at = CLAUDE_IMPORT_STEPS.indexOf(phase.step);
                const done = i < at;
                const current = i === at;
                return (
                  <li key={step} className={cn('flex items-center gap-2', !done && !current && 'text-muted-foreground')}>
                    {done ? (
                      <Check className="h-3.5 w-3.5 text-success" />
                    ) : current && phase.kind === 'running' ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Circle className={cn('h-3.5 w-3.5', current && 'text-destructive')} />
                    )}
                    {CLAUDE_IMPORT_STEP_LABEL[step]}
                  </li>
                );
              })}
            </ol>
            {phase.kind === 'failed' && (
              <>
                <p role="alert" className="text-sm text-destructive">
                  {phase.message}
                </p>
                <DialogFooter>
                  {phase.workbenchId && (
                    <Button
                      variant="outline"
                      onClick={() => {
                        useNavigationStore.getState().navigate({ view: 'workbench', id: phase.workbenchId! });
                        setOpen(false);
                      }}
                    >
                      Open the session
                    </Button>
                  )}
                  <Button variant="outline" onClick={() => setPhase({ kind: 'list' })}>
                    Back
                  </Button>
                </DialogFooter>
              </>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ConversationList({
  conversations,
  error,
  blockedReason,
  onPick,
}: {
  conversations: ClaudeConversation[] | null;
  error: string | null;
  blockedReason: string | null;
  onPick: (conversation: ClaudeConversation) => void;
}) {
  if (error) return <p role="alert" className="text-sm text-destructive">{error}</p>;
  if (!conversations) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Reading your conversations…
      </p>
    );
  }
  if (conversations.length === 0) return <p className="text-sm text-muted-foreground">No Claude Code conversations on this machine.</p>;
  return (
    <div className="space-y-2">
      {blockedReason && <p className="text-xs text-muted-foreground">{blockedReason}</p>}
      <ul className="max-h-[50vh] space-y-1 overflow-y-auto" aria-label="Claude Code conversations">
        {conversations.map((c) => {
          const disabled = Boolean(blockedReason || !c.repoFullName);
          return (
            <li key={c.sessionId}>
              <button
                type="button"
                disabled={disabled}
                onClick={() => onPick(c)}
                title={c.unavailableReason ?? c.cwd ?? undefined}
                data-attr="claude-import-conversation"
                className="w-full rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
              >
                <span className="block truncate text-sm">{labelOf(c)}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {[c.repoFullName ?? shortFolder(c.cwd), c.gitBranch, agoText(c.lastActivity), size(c.bytes)]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
                {c.unavailableReason && <span className="block text-xs text-muted-foreground">{c.unavailableReason}</span>}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
