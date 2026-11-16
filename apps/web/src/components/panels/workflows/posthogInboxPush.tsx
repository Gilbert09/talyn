import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Copy, ExternalLink, RefreshCw, RotateCw, Send, Trash2 } from 'lucide-react';
import type {
  PostHogInboxDestinationOutcome,
  PostHogInboxDestinationSummary,
  PostHogInboxPushReveal,
  PostHogInboxPushState,
  PostHogInboxStatus,
} from '@talyn/shared';
import {
  POSTHOG_INBOX_PUSH_RECONNECT_MESSAGE,
  POSTHOG_INBOX_PUSH_SCOPES_MISSING_CODE,
  posthogInboxPushActive,
} from '@talyn/shared';
import { api } from '../../../lib/api';
import { captureAnalyticsException } from '../../../lib/analytics';
import { toast } from '../../../stores/toast';
import { useWorkspaceStore } from '../../../stores/workspace';
import { Button } from '../../ui/button';
import { ConfirmDialog } from '../../ui/confirm-dialog';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../ui/dialog';
import { posthogInboxDeliverySource, WebhookDeliveriesList } from './WebhookDeliveriesList';

/**
 * The PostHog Inbox push: the webhook URL that a PostHog webhook destination
 * posts "report ready" to, "Set up push in PostHog" (Talyn creates and keeps
 * the destination itself), the manual steps, the last push and the requests
 * PostHog sent.
 *
 * The same file is in apps/desktop/src/renderer/components/panels/workflows/. Keep the two in step.
 */

/** The header name as a person types it in PostHog. */
export const SECRET_HEADER_LABEL = 'X-Talyn-Secret';

function formatWhen(iso: string | null): string {
  if (!iso) return 'never';
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? 'never' : at.toLocaleString();
}

async function copy(text: string, label: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`${label} copied`);
  } catch {
    toast.error('Could not copy to clipboard');
  }
}

function CopyValue({ label, value, testId }: { label: string; value: string; testId: string }) {
  return (
    <div className="space-y-1">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="flex items-start gap-2">
        <code data-testid={testId} className="flex-1 whitespace-pre-wrap break-all rounded bg-muted px-2 py-1.5 font-mono text-xs">
          {value}
        </code>
        <Button size="sm" variant="outline" aria-label={`Copy ${label.toLowerCase()}`} onClick={() => void copy(value, label)}>
          <Copy className="h-3.5 w-3.5" />
          Copy
        </Button>
      </div>
    </div>
  );
}

/** The steps to add the destination in PostHog. */
export function PostHogInboxPushSteps({ secretRequired }: { secretRequired: boolean }) {
  return (
    <ol className="list-decimal space-y-1 pl-5 text-xs text-muted-foreground" data-attr="posthog-inbox-push-steps">
      <li>In your PostHog project, open Data pipelines and add a new destination.</li>
      <li>
        Choose <span className="font-medium text-foreground">HTTP Webhook when an Inbox report is ready</span>. Its
        trigger is the Inbox report ready event.
      </li>
      <li>Paste the webhook URL. Keep the POST method and the default JSON body.</li>
      {secretRequired && (
        <li>
          Under secret headers, add <code className="font-mono">{SECRET_HEADER_LABEL}</code> with the secret. PostHog
          keeps it encrypted.
        </li>
      )}
      <li>Save and turn on the destination.</li>
    </ol>
  );
}

/** The URL and the secret, once. Only Done closes it. */
export function PostHogInboxPushRevealDialog({ reveal, onClose }: { reveal: PostHogInboxPushReveal; onClose: () => void }) {
  return (
    <Dialog open onOpenChange={() => undefined}>
      <DialogContent className="max-w-xl" role="dialog" aria-modal="true" aria-label="Copy the PostHog webhook URL">
        <DialogHeader>
          <DialogTitle>Copy the webhook URL</DialogTitle>
          <DialogDescription className="text-xs">
            Add a webhook destination in PostHog that sends to this URL.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <p className="flex items-start gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-2 text-xs text-amber-700 dark:text-amber-300">
            <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
            Copy these now. Talyn shows them only once.
          </p>
          {reveal.destination?.state === 'failed' && (
            <p className="text-xs text-red-500" data-testid="posthog-inbox-push-reveal-destination-error">
              {reveal.destination.error}
            </p>
          )}
          <CopyValue label="URL" value={reveal.url} testId="posthog-inbox-push-url" />
          {reveal.secret && (
            <>
              <CopyValue label="Header name" value={SECRET_HEADER_LABEL} testId="posthog-inbox-push-header" />
              <CopyValue label="Secret" value={reveal.secret} testId="posthog-inbox-push-secret" />
            </>
          )}
          <PostHogInboxPushSteps secretRequired={reveal.secret !== null} />
        </div>
        <DialogFooter>
          <Button size="sm" onClick={onClose} data-attr="posthog-inbox-push-reveal-done">
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The workspace's PostHog Inbox webhook URL, or null, with a reload. */
export function usePostHogInboxPush(workspaceId: string | null) {
  const [state, setState] = useState<PostHogInboxPushState | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!workspaceId) return;
    api.workflows
      .posthogInboxWebhook(workspaceId)
      .then((next) => {
        setState(next);
        setError(null);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Could not load the webhook URL'));
  }, [workspaceId]);

  useEffect(() => {
    setState(undefined);
    load();
  }, [load]);

  return { state, error, reload: load };
}

/** A short line about the push, for the rule editor and the Connection tab. */
export function postHogInboxPushLine(lastPushAt: string | null, configured: boolean): string {
  if (!configured) return 'PostHog does not push to Talyn yet. Talyn checks the Inbox every 3 minutes.';
  if (!lastPushAt) return 'Talyn has a webhook URL, but no push from PostHog has arrived yet. Talyn checks the Inbox every 3 minutes.';
  if (posthogInboxPushActive(lastPushAt)) {
    return `Last push from PostHog: ${formatWhen(lastPushAt)}. Talyn also checks the Inbox every 30 minutes.`;
  }
  return `Last push from PostHog: ${formatWhen(lastPushAt)}. No push in the last 24 hours, so Talyn checks the Inbox every 3 minutes.`;
}

/** Whether a rotate or remove left Talyn's PostHog destination as it should be. Null: no destination. */
export function destinationOutcomeText(outcome: PostHogInboxDestinationOutcome | null | undefined, action: 'rotate' | 'remove'): string | null {
  if (!outcome) return null;
  switch (outcome.state) {
    case 'updated':
      return 'PostHog has the new URL and secret.';
    case 'deleted':
      return 'Talyn deleted its destination in PostHog.';
    case 'not_found':
      return action === 'rotate'
        ? 'The destination Talyn made is gone from PostHog. Set up push again to make a new one.'
        : 'The destination was already gone from PostHog.';
    case 'failed':
      return outcome.error ?? 'PostHog did not take the change.';
  }
}

function errorCode(err: unknown): string | undefined {
  return (err as { code?: string } | null)?.code;
}

/** The Talyn-managed destination: its PostHog link, the last update, or that it is out of date. */
function ManagedDestination({ destination }: { destination: PostHogInboxDestinationSummary }) {
  return (
    <div className="space-y-1 text-xs" data-attr="posthog-inbox-push-managed">
      {destination.error ? (
        <p
          className="flex items-start gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-2 text-amber-700 dark:text-amber-300"
          data-testid="posthog-inbox-push-out-of-date"
        >
          <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
          <span>The destination in PostHog is out of date. {destination.error}</span>
        </p>
      ) : (
        <p className="flex items-center gap-1.5 text-emerald-700 dark:text-emerald-400">
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
          Talyn set up the destination in PostHog
          {destination.syncedAt ? ` and last updated it ${formatWhen(destination.syncedAt)}` : ''}.
        </p>
      )}
      {destination.url && (
        <a
          href={destination.url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground hover:underline"
          data-attr="posthog-inbox-push-destination-link"
        >
          <ExternalLink className="h-3 w-3" />
          Open the destination in PostHog
        </a>
      )}
    </div>
  );
}

/**
 * The push part of the PostHog Inbox Connection tab: set up the push in
 * PostHog, or make, rotate or remove the URL by hand; the steps for PostHog,
 * the last push and the requests.
 *
 * `status` gives the scopes "Set up push in PostHog" needs. `onReconnect`
 * starts the PostHog sign-in again.
 */
export function PostHogInboxPushSection({
  status,
  onReconnect,
  reconnectBusy = false,
}: {
  status?: Pick<PostHogInboxStatus, 'authMethod' | 'pushSetupMissingScopes'> | null;
  onReconnect?: () => void;
  reconnectBusy?: boolean;
} = {}) {
  const workspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const { state, error, reload } = usePostHogInboxPush(workspaceId);
  const [requireSecret, setRequireSecret] = useState(true);
  const [confirming, setConfirming] = useState<'rotate' | 'remove' | 'setup' | null>(null);
  const [running, setRunning] = useState<'setup' | 'rotate' | 'remove' | null>(null);
  const busy = running !== null;
  const [reveal, setReveal] = useState<PostHogInboxPushReveal | null>(null);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [scopesRefused, setScopesRefused] = useState(false);
  // A rotate keeps the current choice unless the person changes it.
  const currentSecret = state ? state.secretRequired : null;
  useEffect(() => {
    if (currentSecret !== null) setRequireSecret(currentSecret);
  }, [currentSecret]);

  const missingScopes = status?.pushSetupMissingScopes ?? [];
  const needsReconnect = missingScopes.length > 0 || scopesRefused;
  const managed = state?.destination ?? null;

  const setUp = async () => {
    if (!workspaceId) return;
    setRunning('setup');
    setSetupError(null);
    try {
      const result = await api.workflows.setUpPostHogInboxPush(workspaceId);
      setConfirming(null);
      setScopesRefused(false);
      toast.success(result.created ? 'Push is set up in PostHog' : 'PostHog has the new URL and secret');
      reload();
    } catch (err) {
      setConfirming(null);
      if (errorCode(err) === POSTHOG_INBOX_PUSH_SCOPES_MISSING_CODE) setScopesRefused(true);
      else captureAnalyticsException(err, { flow: 'posthog_inbox_push_setup' });
      setSetupError(err instanceof Error ? err.message : 'Could not set up the push in PostHog.');
      reload();
    } finally {
      setRunning(null);
    }
  };

  const rotate = async () => {
    if (!workspaceId) return;
    setRunning('rotate');
    try {
      const next = await api.workflows.rotatePostHogInboxWebhook(workspaceId, requireSecret);
      setConfirming(null);
      if (next.destination?.state === 'updated') {
        // PostHog has them already: nobody needs to copy the URL or the secret.
        toast.success('URL rotated', destinationOutcomeText(next.destination, 'rotate') ?? undefined);
      } else {
        if (next.destination) toast.error('The destination in PostHog is out of date', destinationOutcomeText(next.destination, 'rotate') ?? undefined);
        setReveal(next);
      }
      reload();
    } catch (err) {
      captureAnalyticsException(err, { flow: 'posthog_inbox_push_rotate' });
      toast.error('Could not make the URL', err instanceof Error ? err.message : undefined);
    } finally {
      setRunning(null);
    }
  };

  const remove = async () => {
    if (!workspaceId) return;
    setRunning('remove');
    try {
      const result = await api.workflows.removePostHogInboxWebhook(workspaceId);
      setConfirming(null);
      const text = destinationOutcomeText(result.destination, 'remove');
      if (result.destination?.state === 'failed') toast.error('Webhook URL removed, but not the destination in PostHog', text ?? undefined);
      else toast.success('Webhook URL removed', text ?? undefined);
      reload();
    } catch (err) {
      captureAnalyticsException(err, { flow: 'posthog_inbox_push_remove' });
      toast.error('Could not remove the URL', err instanceof Error ? err.message : undefined);
    } finally {
      setRunning(null);
    }
  };

  const secretToggle = (
    <label className="flex items-center gap-2 text-xs">
      <input
        type="checkbox"
        checked={requireSecret}
        onChange={(e) => setRequireSecret(e.target.checked)}
        data-attr="posthog-inbox-push-require-secret"
      />
      Require a secret header ({SECRET_HEADER_LABEL})
    </label>
  );

  const setupButton = (
    <Button
      size="sm"
      variant={state === null ? 'default' : 'outline'}
      // Over an existing URL it is a rotate, so ask first.
      onClick={() => (state ? setConfirming('setup') : void setUp())}
      disabled={busy || needsReconnect}
      data-attr="posthog-inbox-push-setup"
    >
      <Send className="mr-1 h-3.5 w-3.5" />
      {running === 'setup' ? 'Setting up...' : managed?.error ? 'Update the destination in PostHog' : 'Set up push in PostHog'}
    </Button>
  );

  const reconnectNotice = needsReconnect && (
    <div
      className="flex items-start gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2"
      data-attr="posthog-inbox-push-reconnect"
    >
      <div className="flex-1 text-xs">
        <p className="font-medium text-amber-600 dark:text-amber-400">{POSTHOG_INBOX_PUSH_RECONNECT_MESSAGE}</p>
        <p className="mt-0.5 text-muted-foreground">
          {missingScopes.length > 0
            ? `The PostHog connection lacks ${missingScopes.join(' and ')}. Your automations keep working without them.`
            : 'The PostHog connection cannot create destinations. Your automations keep working without it.'}{' '}
          You can also add the destination by hand.
        </p>
      </div>
      {onReconnect && (
        <Button size="sm" onClick={onReconnect} disabled={reconnectBusy} data-attr="posthog-inbox-push-reconnect-button">
          <RefreshCw className="mr-1 h-3.5 w-3.5" />
          Reconnect
        </Button>
      )}
    </div>
  );

  const setupErrorLine = setupError && !scopesRefused && (
    <p className="text-xs text-red-500" data-testid="posthog-inbox-push-setup-error">
      {setupError}
    </p>
  );

  return (
    <div className="space-y-3 rounded-lg border p-4" data-attr="posthog-inbox-push-section">
      <div>
        <div className="text-sm font-medium">Push from PostHog</div>
        <p className="mt-0.5 text-xs text-muted-foreground">
          PostHog can tell Talyn when a report is ready, so automations start within seconds. Talyn then reads the
          report from PostHog itself. While pushes arrive, Talyn checks the Inbox only every 30 minutes, to catch a
          push that was lost.
        </p>
      </div>

      {error ? (
        <p className="text-xs text-red-500">{error}</p>
      ) : state === undefined ? (
        <p className="text-xs text-muted-foreground">Loading...</p>
      ) : state === null ? (
        <div className="space-y-2">
          {reconnectNotice}
          <p className="text-xs text-muted-foreground">
            Talyn can add the webhook destination in your PostHog project for you, with a new URL and secret that
            nobody needs to copy.
          </p>
          {setupButton}
          {setupErrorLine}
          <div className="space-y-2 border-t pt-2" data-attr="posthog-inbox-push-manual">
            <p className="text-xs text-muted-foreground">Or make a URL and add the destination in PostHog yourself.</p>
            {secretToggle}
            <Button size="sm" variant="outline" onClick={() => void rotate()} disabled={busy} data-attr="posthog-inbox-push-create">
              {running === 'rotate' ? 'Making the URL...' : 'Make a webhook URL'}
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          <code className="block break-all font-mono text-xs" data-testid="posthog-inbox-push-url-prefix">
            {state.urlPrefix}…
          </code>
          <p className="text-xs text-muted-foreground">
            For PostHog project {state.projectId}. Secret header {state.secretRequired ? 'required' : 'not required'}.
            Made {formatWhen(state.createdAt)}. Rotated {formatWhen(state.rotatedAt)}. Last request{' '}
            {formatWhen(state.lastDeliveryAt)}.
          </p>
          {managed && <ManagedDestination destination={managed} />}
          <p className="text-xs" data-testid="posthog-inbox-push-last">
            {postHogInboxPushLine(state.lastPushAt, true)}
          </p>
          {reconnectNotice}
          {(!managed || managed.error) && setupButton}
          {setupErrorLine}
          {!managed && secretToggle}
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => setConfirming('rotate')} data-attr="posthog-inbox-push-rotate">
              <RotateCw className="mr-1 h-3.5 w-3.5" />
              Rotate URL
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setConfirming('remove')} data-attr="posthog-inbox-push-remove">
              <Trash2 className="mr-1 h-3.5 w-3.5" />
              Remove URL
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">Talyn hides the end of the URL. To get a new URL, rotate it.</p>
        </div>
      )}

      {!managed && <PostHogInboxPushSteps secretRequired={state ? state.secretRequired : requireSecret} />}

      {state && workspaceId && (
        <div className="rounded-md border" data-attr="posthog-inbox-push-deliveries">
          <div className="border-b px-4 py-2 text-xs font-medium">Requests from PostHog</div>
          <WebhookDeliveriesList source={posthogInboxDeliverySource(workspaceId)} />
        </div>
      )}

      <ConfirmDialog
        open={confirming === 'setup'}
        title="Set up push in PostHog?"
        description={
          managed
            ? 'Talyn rotates the URL and secret and gives them to its destination in PostHog.'
            : 'Talyn rotates the URL and secret and adds a destination in PostHog that sends to them. A destination you added by hand stops working: delete it in PostHog.'
        }
        confirmLabel="Set up push"
        busy={busy}
        onConfirm={() => void setUp()}
        onCancel={() => setConfirming(null)}
      />
      <ConfirmDialog
        open={confirming === 'rotate'}
        title="Rotate the URL?"
        description={
          managed
            ? 'The old URL and secret stop working at once. Talyn gives the new ones to its destination in PostHog.'
            : requireSecret
              ? 'The old URL and secret stop working at once. Update the destination in PostHog with the new URL and secret.'
              : 'The old URL stops working at once, and the new URL needs no secret. Update the destination in PostHog with the new URL.'
        }
        confirmLabel="Rotate URL"
        busy={busy}
        onConfirm={() => void rotate()}
        onCancel={() => setConfirming(null)}
      />
      <ConfirmDialog
        open={confirming === 'remove'}
        title="Remove the URL?"
        description={
          managed
            ? "PostHog's requests stop working at once, and Talyn deletes its destination in PostHog. Talyn goes back to checking the Inbox every 3 minutes."
            : "PostHog's requests stop working at once. Talyn goes back to checking the Inbox every 3 minutes."
        }
        confirmLabel="Remove URL"
        busy={busy}
        onConfirm={() => void remove()}
        onCancel={() => setConfirming(null)}
      />
      {reveal && <PostHogInboxPushRevealDialog reveal={reveal} onClose={() => setReveal(null)} />}
    </div>
  );
}
