import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import type { TeamInvitePreview } from '@talyn/shared';
import { ApiError, api } from '../../lib/api';
import { clearPendingInvite, readPendingInvite } from '../../lib/pendingInvite';
import { toast } from '../../stores/toast';
import { useSpacesStore } from '../../stores/spaces';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog';

const INVALID_LINK = 'This invite link is not valid. It may have expired or been used. Ask for a new invite.';

type State =
  | { kind: 'loading' }
  | { kind: 'ready'; preview: TeamInvitePreview }
  | { kind: 'message'; text: string; clear: boolean };

/** Asks a signed-in person to accept the team invite they opened by email link. */
export function PendingInviteDialog() {
  const [token] = useState(readPendingInvite);
  const [open, setOpen] = useState(token !== null);
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    api.teams
      .previewInvite(token)
      .then((preview) => {
        if (!cancelled) setState({ kind: 'ready', preview });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 404) {
          setState({ kind: 'message', text: INVALID_LINK, clear: true });
        } else if (err instanceof ApiError && err.status === 403 && err.code === 'spaces_unavailable') {
          setState({ kind: 'message', text: err.message, clear: true });
        } else {
          const text = err instanceof Error && err.message ? err.message : 'Could not load the invite.';
          setState({ kind: 'message', text, clear: false });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (!token || !open) return null;

  const close = () => {
    if (busy) return;
    if (state.kind === 'ready' || (state.kind === 'message' && state.clear)) clearPendingInvite();
    setOpen(false);
  };

  const accept = async () => {
    setBusy(true);
    setError(null);
    try {
      const team = await api.teams.acceptInvite(token);
      useSpacesStore.getState().upsertTeam(team);
      clearPendingInvite();
      toast.success(`You joined ${team.name}`);
      setOpen(false);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setState({ kind: 'message', text: INVALID_LINK, clear: true });
      } else {
        setError(err instanceof Error && err.message ? err.message : 'Could not accept the invite.');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(next) => !next && close()}>
      <DialogContent onClose={close} data-attr="pending-invite-dialog">
        {state.kind === 'loading' && (
          <div className="flex items-center justify-center py-6">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        )}
        {state.kind === 'message' && (
          <>
            <DialogHeader>
              <DialogTitle>Team invite</DialogTitle>
              <DialogDescription>{state.text}</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button onClick={close}>Close</Button>
            </DialogFooter>
          </>
        )}
        {state.kind === 'ready' && state.preview.alreadyMember && (
          <>
            <DialogHeader>
              <DialogTitle>{`You are already in ${state.preview.teamName}`}</DialogTitle>
              <DialogDescription>This invite is for a team that you already belong to.</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button onClick={close}>Close</Button>
            </DialogFooter>
          </>
        )}
        {state.kind === 'ready' && !state.preview.alreadyMember && (
          <>
            <DialogHeader>
              <DialogTitle>
                {state.preview.invitedByLogin
                  ? `@${state.preview.invitedByLogin} invited you to join ${state.preview.teamName}`
                  : `You are invited to join ${state.preview.teamName}`}
              </DialogTitle>
              <DialogDescription>
                Teammates see each other&apos;s sessions in the team&apos;s spaces. Each person&apos;s work runs on their own account.
              </DialogDescription>
            </DialogHeader>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <DialogFooter>
              <Button variant="outline" onClick={close} disabled={busy}>
                Decline
              </Button>
              <Button onClick={() => void accept()} disabled={busy}>
                {busy && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
                Accept
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
