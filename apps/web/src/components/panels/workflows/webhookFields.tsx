import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Copy, Plus, RotateCw, X } from 'lucide-react';
import type {
  WebhookConnectionSummary,
  WebhookPayloadCondition,
  WebhookPayloadOp,
  WebhookSecretReveal,
  WorkflowConditions,
} from '@talyn/shared';
import {
  emptyWebhookPayloadCondition,
  parseWebhookPath,
  WEBHOOK_PAYLOAD_OP_LABELS,
  WEBHOOK_PAYLOAD_OPS,
  WEBHOOK_SIGNATURE_HEADER,
} from '@talyn/shared';
import { api } from '../../../lib/api';
import { captureAnalyticsException } from '../../../lib/analytics';
import { toast } from '../../../stores/toast';
import { Button } from '../../ui/button';
import { ConfirmDialog } from '../../ui/confirm-dialog';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../ui/dialog';
import { Input } from '../../ui/input';
import { Select } from '../../ui/select';

// ---------------------------------------------------------------------------
// Payload conditions
// ---------------------------------------------------------------------------

/** The problem with one path, or null. An empty path is left to the validator on save. */
export function webhookPathProblem(path: string): string | null {
  if (!path.trim()) return null;
  return parseWebhookPath(path) ? null : 'This is not a path. Use keys and indexes, like issue.labels[0].name.';
}

/** The list of payload tests on a webhook rule. Every test must pass. */
export function WebhookPayloadConditions({ conditions, onChange }: {
  conditions: WorkflowConditions;
  onChange: (next: WorkflowConditions) => void;
}) {
  const rows = conditions.payloadMatches ?? [];

  const setRows = (next: WebhookPayloadCondition[]) => {
    const nextConditions = { ...conditions };
    if (next.length === 0) delete nextConditions.payloadMatches;
    else nextConditions.payloadMatches = next;
    onChange(nextConditions);
  };

  const setRow = (index: number, next: WebhookPayloadCondition) =>
    setRows(rows.map((row, i) => (i === index ? next : row)));

  const setOp = (index: number, row: WebhookPayloadCondition, op: WebhookPayloadOp) =>
    setRow(index, op === 'exists' ? { path: row.path, op } : { path: row.path, op, value: row.value ?? '' });

  return (
    <div className="space-y-2" data-attr="webhook-payload-conditions">
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No tests. Every request to the URL starts this automation.
        </p>
      ) : (
        rows.map((row, i) => {
          const problem = webhookPathProblem(row.path);
          return (
            <div key={i} className="space-y-1" data-attr="webhook-payload-row">
              <div className="flex items-start gap-2">
                <Input
                  aria-label={`Path ${i + 1}`}
                  className="flex-1 font-mono text-sm"
                  value={row.path}
                  placeholder="issue.labels[0].name"
                  onChange={(e) => setRow(i, { ...row, path: e.target.value })}
                />
                <Select
                  aria-label={`Test ${i + 1}`}
                  className="w-32"
                  value={row.op}
                  onChange={(e) => setOp(i, row, e.target.value as WebhookPayloadOp)}
                >
                  {WEBHOOK_PAYLOAD_OPS.map((op) => (
                    <option key={op} value={op}>{WEBHOOK_PAYLOAD_OP_LABELS[op]}</option>
                  ))}
                </Select>
                {row.op !== 'exists' && (
                  <Input
                    aria-label={`Value ${i + 1}`}
                    className="flex-1"
                    value={row.value ?? ''}
                    placeholder="opened"
                    onChange={(e) => setRow(i, { ...row, value: e.target.value })}
                  />
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Remove test ${i + 1}`}
                  onClick={() => setRows(rows.filter((_, j) => j !== i))}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
              {problem && <p className="text-xs text-red-500" role="alert">{problem}</p>}
            </div>
          );
        })
      )}
      <Button
        variant="outline"
        size="sm"
        data-attr="webhook-payload-add"
        onClick={() => setRows([...rows, emptyWebhookPayloadCondition()])}
      >
        <Plus className="mr-1 h-4 w-4" />
        Add test
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The URL, shown once
// ---------------------------------------------------------------------------

async function copy(text: string, label: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`${label} copied`);
  } catch {
    toast.error('Could not copy to clipboard');
  }
}

export const webhookCurlExample = (url: string) =>
  `curl -X POST "${url}" -H 'content-type: application/json' -d '{"action":"opened"}'`;

function CopyRow({ label, value, copyLabel, testId }: {
  label: string;
  value: string;
  copyLabel: string;
  testId?: string;
}) {
  return (
    <div className="space-y-1">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="flex items-start gap-2">
        <code data-testid={testId} className="flex-1 whitespace-pre-wrap break-all rounded bg-muted px-2 py-1.5 font-mono text-xs">
          {value}
        </code>
        <Button size="sm" variant="outline" aria-label={`Copy ${copyLabel}`} onClick={() => void copy(value, label)}>
          <Copy className="h-3.5 w-3.5" />
          Copy
        </Button>
      </div>
    </div>
  );
}

/**
 * The URL and the signing secret, once. Only Done closes it: a stray click on
 * the backdrop must not lose a URL that Talyn cannot show again.
 */
export function WebhookRevealDialog({ reveal, onClose }: {
  reveal: WebhookSecretReveal;
  onClose: () => void;
}) {
  return (
    <Dialog open onOpenChange={() => undefined}>
      <DialogContent className="max-w-xl" role="dialog" aria-modal="true" aria-label="Copy the webhook URL">
        <DialogHeader>
          <DialogTitle>Copy the webhook URL</DialogTitle>
          <DialogDescription className="text-xs">
            Send a POST request with a JSON body to this URL to start the automation.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <p className="flex items-start gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-2 text-xs text-amber-700 dark:text-amber-300">
            <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
            Copy the URL now. Talyn shows it only once. Anyone with the URL can start this automation.
          </p>
          <CopyRow label="URL" value={reveal.url} copyLabel="URL" testId="webhook-url" />
          <CopyRow label="Signing secret" value={reveal.signingSecret} copyLabel="signing secret" testId="webhook-signing-secret" />
          <p className="text-xs text-muted-foreground">
            The signature is optional. To sign a request, send the header{' '}
            <code className="font-mono">{WEBHOOK_SIGNATURE_HEADER}: sha256=&lt;hex&gt;</code>, where hex is the
            HMAC-SHA256 of the raw body with the signing secret.
          </p>
          <CopyRow label="Try it" value={webhookCurlExample(reveal.url)} copyLabel="curl command" />
        </div>
        <DialogFooter>
          <Button size="sm" onClick={onClose} data-attr="webhook-reveal-done">
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// The URL of a saved rule
// ---------------------------------------------------------------------------

function formatWhen(iso: string | null): string {
  if (!iso) return 'never';
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? 'never' : at.toLocaleString();
}

/**
 * A saved webhook rule's URL, with the token hidden, and the Rotate button.
 * Rotate gives a new URL and secret, shown once, and the old URL stops at once.
 */
export function WebhookUrlSection({ ruleId }: { ruleId: string }) {
  const [summary, setSummary] = useState<WebhookConnectionSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [reveal, setReveal] = useState<WebhookSecretReveal | null>(null);

  const load = useCallback(() => {
    api.workflows
      .webhook(ruleId)
      .then((next) => {
        setSummary(next);
        setError(null);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Could not load the webhook URL'));
  }, [ruleId]);

  useEffect(() => {
    setSummary(null);
    load();
  }, [load]);

  const rotate = async () => {
    setRotating(true);
    try {
      const next = await api.workflows.rotateWebhook(ruleId);
      setConfirming(false);
      setReveal(next);
      load();
    } catch (err) {
      captureAnalyticsException(err, { flow: 'webhook_rotate' });
      toast.error('Could not rotate the URL', err instanceof Error ? err.message : undefined);
    } finally {
      setRotating(false);
    }
  };

  return (
    <div className="space-y-2 rounded-md border p-3" data-attr="webhook-url-section">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">Webhook URL</div>
          {error ? (
            <p className="mt-1 text-xs text-red-500">{error}</p>
          ) : !summary ? (
            <p className="mt-1 text-xs text-muted-foreground">Loading...</p>
          ) : (
            <>
              <code className="mt-1 block break-all font-mono text-xs" data-testid="webhook-url-prefix">
                {summary.urlPrefix}…
              </code>
              <p className="mt-1 text-xs text-muted-foreground">
                Created {formatWhen(summary.createdAt)}. Rotated {formatWhen(summary.rotatedAt)}. Last request{' '}
                {formatWhen(summary.lastDeliveryAt)}.
              </p>
            </>
          )}
        </div>
        <Button variant="outline" size="sm" onClick={() => setConfirming(true)} data-attr="webhook-rotate">
          <RotateCw className="mr-1 h-3.5 w-3.5" />
          Rotate URL
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Talyn hides the end of the URL. To get a new URL, rotate it.
      </p>

      <ConfirmDialog
        open={confirming}
        title="Rotate the URL?"
        description="The old URL stops working at once. Talyn makes a new URL and signing secret."
        confirmLabel="Rotate URL"
        busy={rotating}
        onConfirm={() => void rotate()}
        onCancel={() => setConfirming(false)}
      />
      {reveal && <WebhookRevealDialog reveal={reveal} onClose={() => setReveal(null)} />}
    </div>
  );
}
