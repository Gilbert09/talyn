import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Copy, Plus, RefreshCw, X } from 'lucide-react';
import type {
  WebhookConnectionSummary,
  WebhookPayloadCondition,
  WebhookPayloadOp,
  WebhookSecretReveal,
  WorkflowConditions,
  WorkflowInput,
} from '@talyn/shared';
import {
  emptyWebhookPayloadCondition,
  parseWebhookPath,
  WEBHOOK_PAYLOAD_OP_LABELS,
  WEBHOOK_PAYLOAD_OPS,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_WORKFLOW_CONDITION_SPECS,
} from '@talyn/shared';
import { api } from '../../../lib/api';
import { captureAnalyticsException } from '../../../lib/analytics';
import { toast } from '../../../stores/toast';
import { Button } from '../../ui/button';
import { ConfirmDialog } from '../../ui/confirm-dialog';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../ui/dialog';
import { Input } from '../../ui/input';
import { Select } from '../../ui/select';

/** Removes payload tests that have no path and no value, so a row the user added and left empty is not a save error. */
export function withoutEmptyPayloadTests(input: WorkflowInput): WorkflowInput {
  const tests = input.conditions?.payloadMatches;
  if (!tests) return input;
  const kept = tests.filter((t) => t.path.trim() !== '' || (t.value ?? '').trim() !== '');
  const conditions = { ...input.conditions };
  if (kept.length > 0) conditions.payloadMatches = kept;
  else delete conditions.payloadMatches;
  return { ...input, conditions };
}

/** The problem with one path, or null. An empty path is not a problem until the rule is saved. */
export function payloadPathProblem(path: string): string | null {
  if (!path.trim() || parseWebhookPath(path)) return null;
  return 'This is not a valid path. Use keys and indexes, like issue.labels[0].name.';
}

/** The "Payload matches" list: one row per test on the JSON body. */
export function WebhookPayloadConditions({ conditions, onChange }: {
  conditions: WorkflowConditions;
  onChange: (next: WorkflowConditions) => void;
}) {
  const tests = conditions.payloadMatches ?? [];
  const setTests = (next: WebhookPayloadCondition[]) => {
    const out = { ...conditions };
    if (next.length > 0) out.payloadMatches = next;
    else delete out.payloadMatches;
    onChange(out);
  };
  const setTest = (i: number, next: WebhookPayloadCondition) => setTests(tests.map((t, j) => (j === i ? next : t)));
  const setOp = (i: number, op: WebhookPayloadOp) => {
    const current = tests[i]!;
    setTest(i, op === 'exists' ? { path: current.path, op } : { path: current.path, op, value: current.value ?? '' });
  };

  return <div className="space-y-2">
    <div className="text-xs font-medium text-muted-foreground">{WEBHOOK_WORKFLOW_CONDITION_SPECS[0]!.label}</div>
    {tests.length === 0 ? (
      <p className="text-sm text-muted-foreground">No tests. Every request to the URL starts the automation.</p>
    ) : tests.map((test, i) => {
      const problem = payloadPathProblem(test.path);
      return <div key={i} className="space-y-1" data-attr="webhook-payload-test">
        <div className="flex items-center gap-2">
          <Input
            aria-label={`Path ${i + 1}`}
            className="flex-1 font-mono text-xs"
            placeholder="issue.labels[0].name"
            value={test.path}
            onChange={(e) => setTest(i, { ...test, path: e.target.value })}
          />
          <Select
            aria-label={`Test ${i + 1}`}
            className="w-32"
            value={test.op}
            onChange={(e) => setOp(i, e.target.value as WebhookPayloadOp)}
          >
            {WEBHOOK_PAYLOAD_OPS.map((op) => <option key={op} value={op}>{WEBHOOK_PAYLOAD_OP_LABELS[op]}</option>)}
          </Select>
          {test.op !== 'exists' && (
            <Input
              aria-label={`Value ${i + 1}`}
              className="flex-1 text-xs"
              placeholder="opened"
              value={test.value ?? ''}
              onChange={(e) => setTest(i, { ...test, value: e.target.value })}
            />
          )}
          <button
            type="button"
            className="rounded p-1 text-muted-foreground hover:text-foreground"
            aria-label={`Remove test ${i + 1}`}
            onClick={() => setTests(tests.filter((_, j) => j !== i))}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        {problem && <p className="text-xs text-red-500" role="alert">{problem}</p>}
      </div>;
    })}
    <Button
      size="sm"
      variant="outline"
      data-attr="webhook-payload-add"
      onClick={() => setTests([...tests, emptyWebhookPayloadCondition()])}
    >
      <Plus className="mr-1 h-3.5 w-3.5" />
      Add test
    </Button>
  </div>;
}

async function copy(text: string, label: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`${label} copied`);
  } catch {
    toast.error('Could not copy to clipboard');
  }
}

export function webhookCurlExample(url: string): string {
  return `curl -X POST "${url}" -H 'content-type: application/json' -d '{"action":"opened"}'`;
}

function CopyRow({ label, value, testId }: { label: string; value: string; testId: string }) {
  return <div className="space-y-1">
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
  </div>;
}

/** The URL and signing secret, shown once after create or rotate. Only Done closes it, so a stray click cannot lose the URL. */
export function WebhookSecretDialog({ reveal, onClose }: { reveal: WebhookSecretReveal; onClose: () => void }) {
  return <Dialog open onOpenChange={() => undefined}>
    <DialogContent className="max-w-lg" role="dialog" aria-modal="true" aria-label="Copy your webhook URL">
      <DialogHeader>
        <DialogTitle>Copy your webhook URL</DialogTitle>
        <DialogDescription className="text-xs">Send a POST request with a JSON body to this URL to start the automation.</DialogDescription>
      </DialogHeader>
      <div className="space-y-3">
        <p className="flex items-start gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-2 text-xs text-amber-700 dark:text-amber-300">
          <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
          Copy the URL now. Talyn shows it only once. Anyone with the URL can start this automation.
        </p>
        <CopyRow label="URL" value={reveal.url} testId="webhook-url" />
        <CopyRow label="Signing secret" value={reveal.signingSecret} testId="webhook-signing-secret" />
        <p className="text-xs text-muted-foreground">
          The signature is optional. To sign a request, send the header {WEBHOOK_SIGNATURE_HEADER}: sha256=&lt;hex HMAC-SHA256 of the body with the signing secret&gt;.
        </p>
        <CopyRow label="Example" value={webhookCurlExample(reveal.url)} testId="webhook-curl" />
      </div>
      <DialogFooter>
        <Button size="sm" onClick={onClose}>Done</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

export function formatWhen(iso: string | null): string {
  if (!iso) return 'never';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? 'never' : date.toLocaleString();
}

/** A webhook rule's URL: the prefix, its times, and the rotate flow. */
export function WebhookUrlSection({ ruleId }: { ruleId: string }) {
  const [summary, setSummary] = useState<WebhookConnectionSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [reveal, setReveal] = useState<WebhookSecretReveal | null>(null);

  const load = useCallback(() => {
    api.workflows
      .webhook(ruleId)
      .then((s) => {
        setSummary(s);
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

  return <div className="space-y-2 px-4 py-3" data-attr="webhook-url-section">
    <div className="flex items-center gap-2">
      <h3 className="text-[13px] font-medium">Webhook URL</h3>
      <Button
        size="sm"
        variant="outline"
        className="ml-auto"
        data-attr="webhook-rotate"
        onClick={() => setConfirming(true)}
        disabled={summary === null}
      >
        <RefreshCw className="mr-1 h-3.5 w-3.5" />
        Rotate URL
      </Button>
    </div>
    {error && <p className="text-xs text-red-500">{error}</p>}
    {summary === null && !error && <p className="text-xs text-muted-foreground">Loading...</p>}
    {summary && <>
      <code data-testid="webhook-url-prefix" className="block break-all rounded bg-muted px-2 py-1.5 font-mono text-xs">
        {summary.urlPrefix}…
      </code>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
        <dt className="text-muted-foreground">Created</dt><dd>{formatWhen(summary.createdAt)}</dd>
        <dt className="text-muted-foreground">Rotated</dt><dd>{formatWhen(summary.rotatedAt)}</dd>
        <dt className="text-muted-foreground">Last delivery</dt><dd>{formatWhen(summary.lastDeliveryAt)}</dd>
      </dl>
      <p className="text-xs text-muted-foreground">Talyn shows the full URL only once. If you lost it, rotate the URL to get a new one.</p>
    </>}
    <ConfirmDialog
      open={confirming}
      title="Rotate this URL?"
      description="The old URL stops working at once. Send requests to the new URL after you rotate."
      confirmLabel="Rotate URL"
      busy={rotating}
      onConfirm={() => void rotate()}
      onCancel={() => setConfirming(false)}
    />
    {reveal && <WebhookSecretDialog reveal={reveal} onClose={() => setReveal(null)} />}
  </div>;
}
