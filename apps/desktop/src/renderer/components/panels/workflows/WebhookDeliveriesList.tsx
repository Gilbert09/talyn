import { useCallback, useEffect, useRef, useState } from 'react';
import type { InboundDelivery, InboundDeliveryOutcome, InboundDeliverySummary } from '@talyn/shared';
import { api } from '../../../lib/api';
import { captureAnalyticsException } from '../../../lib/analytics';
import { toast } from '../../../stores/toast';
import { Badge } from '../../ui/badge';
import { Button } from '../../ui/button';
import { formatWhen } from './webhookFields';

const PAGE = 25;

export const DELIVERY_OUTCOME_LABELS: Record<InboundDeliveryOutcome | 'waiting', string> = {
  handled: 'Handled',
  ignored: 'No rule matched',
  failed: 'Failed',
  waiting: 'Waiting',
};

function outcomeVariant(outcome: InboundDeliveryOutcome | null): 'success' | 'error' | 'secondary' {
  if (outcome === 'handled') return 'success';
  if (outcome === 'failed') return 'error';
  return 'secondary';
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function relative(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 60) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** One webhook rule's stored requests, newest first, paged by `receivedAt`. */
export function useWebhookDeliveries(ruleId: string) {
  const [rows, setRows] = useState<InboundDeliverySummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const ruleRef = useRef(ruleId);
  ruleRef.current = ruleId;

  const fetchPage = useCallback((cursor: string | null) => {
    setLoading(true);
    api.workflows
      .deliveries(ruleId, { limit: PAGE, cursor })
      .then((page) => {
        if (ruleRef.current !== ruleId) return;
        setRows((prev) => {
          if (!cursor) return page;
          const seen = new Set(prev.map((r) => r.id));
          return [...prev, ...page.filter((r) => !seen.has(r.id))];
        });
        setHasMore(page.length === PAGE);
        setError(null);
      })
      .catch((err: unknown) => {
        if (ruleRef.current !== ruleId) return;
        setError(err instanceof Error ? err.message : 'Could not load the deliveries');
      })
      .finally(() => setLoading(false));
  }, [ruleId]);

  useEffect(() => {
    setRows([]);
    setHasMore(false);
    fetchPage(null);
  }, [fetchPage]);

  const loadMore = useCallback(() => {
    const last = rows[rows.length - 1];
    if (last) fetchPage(last.receivedAt);
  }, [rows, fetchPage]);

  const reload = useCallback(() => fetchPage(null), [fetchPage]);

  return { rows, loading, error, hasMore, loadMore, reload };
}

function DeliveryDetail({ ruleId, deliveryId }: { ruleId: string; deliveryId: string }) {
  const [delivery, setDelivery] = useState<InboundDelivery | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setDelivery(null);
    api.workflows
      .delivery(ruleId, deliveryId)
      .then((d) => { if (active) setDelivery(d); })
      .catch((err: unknown) => {
        if (active) setError(err instanceof Error ? err.message : 'Could not load this delivery');
      });
    return () => { active = false; };
  }, [ruleId, deliveryId]);

  if (error) return <p className="text-xs text-red-500">{error}</p>;
  if (!delivery) return <p className="text-xs text-muted-foreground">Loading...</p>;
  const headers = Object.entries(delivery.headers);
  return <div className="space-y-2" data-attr="webhook-delivery-detail">
    <div>
      <div className="mb-1 text-xs font-medium text-muted-foreground">Body</div>
      <pre data-testid="webhook-delivery-payload" className="max-h-80 overflow-auto rounded bg-muted px-2 py-1.5 font-mono text-xs">
        {JSON.stringify(delivery.payload, null, 2)}
      </pre>
    </div>
    <div>
      <div className="mb-1 text-xs font-medium text-muted-foreground">Headers</div>
      {headers.length === 0 ? (
        <p className="text-xs text-muted-foreground">Talyn kept no headers for this request.</p>
      ) : (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 font-mono text-xs">
          {headers.map(([name, value]) => <div key={name} className="contents">
            <dt className="text-muted-foreground">{name}</dt>
            <dd className="break-all">{value}</dd>
          </div>)}
        </dl>
      )}
    </div>
  </div>;
}

function DeliveryRow({ ruleId, row, onReplayed }: {
  ruleId: string;
  row: InboundDeliverySummary;
  onReplayed: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [replaying, setReplaying] = useState(false);

  const replay = async () => {
    setReplaying(true);
    try {
      await api.workflows.replayDelivery(ruleId, row.id);
      toast.success('Replay started');
      onReplayed();
    } catch (err) {
      captureAnalyticsException(err, { flow: 'webhook_replay' });
      toast.error('Could not replay', err instanceof Error ? err.message : undefined);
    } finally {
      setReplaying(false);
    }
  };

  return <div className="space-y-1.5 px-4 py-3" data-attr="webhook-delivery-row">
    <div className="flex flex-wrap items-center gap-2 text-[13px]">
      <Badge variant={outcomeVariant(row.outcome)}>{DELIVERY_OUTCOME_LABELS[row.outcome ?? 'waiting']}</Badge>
      <span className="font-medium">{row.eventType}</span>
      {row.replayOf && <Badge variant="outline">Replay</Badge>}
      <span className="text-xs text-muted-foreground">
        {row.attempts} attempt{row.attempts === 1 ? '' : 's'}
      </span>
      <span className="text-xs text-muted-foreground">{formatBytes(row.payloadBytes)}</span>
      <span className="ml-auto text-xs text-muted-foreground" title={formatWhen(row.receivedAt)}>
        {relative(row.receivedAt)}
      </span>
      <Button
        variant="ghost"
        size="sm"
        className="h-6 px-2 text-xs"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? 'Hide body' : 'Show body'}
      </Button>
      <Button
        variant="outline"
        size="sm"
        className="h-6 px-2 text-xs"
        disabled={replaying}
        onClick={() => void replay()}
      >
        {replaying ? 'Replaying...' : 'Replay'}
      </Button>
    </div>
    {row.error && <p className="text-xs text-red-500">{row.error}</p>}
    {open && <DeliveryDetail ruleId={ruleId} deliveryId={row.id} />}
  </div>;
}

/** The requests a webhook rule received. Talyn keeps each one for 7 days. */
export function WebhookDeliveriesList({ ruleId }: { ruleId: string }) {
  const { rows, loading, error, hasMore, loadMore, reload } = useWebhookDeliveries(ruleId);

  if (error && rows.length === 0) return <p className="px-3 py-2 text-[13px] text-red-500">{error}</p>;
  if (loading && rows.length === 0) {
    return <p className="px-3 py-2 text-[13px] text-muted-foreground">Loading deliveries...</p>;
  }
  if (rows.length === 0) {
    return <p className="px-3 py-2 text-[13px] text-muted-foreground">
      No requests yet. Send a request to the URL to see it here.
    </p>;
  }

  return <div className="divide-y">
    {rows.map((row) => <DeliveryRow key={row.id} ruleId={ruleId} row={row} onReplayed={reload} />)}
    {error && <p className="px-3 py-2 text-xs text-red-500">{error}</p>}
    {hasMore && (
      <div className="p-3">
        <Button variant="outline" size="sm" onClick={loadMore} disabled={loading}>
          {loading ? 'Loading...' : 'Load more'}
        </Button>
      </div>
    )}
  </div>;
}
