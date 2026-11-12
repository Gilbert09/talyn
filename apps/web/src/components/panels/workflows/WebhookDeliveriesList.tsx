import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, RotateCcw } from 'lucide-react';
import type { InboundDelivery, InboundDeliveryOutcome, InboundDeliverySummary } from '@talyn/shared';
import { api } from '../../../lib/api';
import { captureAnalyticsException } from '../../../lib/analytics';
import { toast } from '../../../stores/toast';
import { Badge } from '../../ui/badge';
import { Button } from '../../ui/button';

const PAGE = 25;

const OUTCOME_LABELS: Record<InboundDeliveryOutcome | 'waiting', string> = {
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

/** A webhook rule's stored requests, paged by `receivedAt`, newest first. */
export function useWebhookDeliveries(ruleId: string) {
  const [deliveries, setDeliveries] = useState<InboundDeliverySummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);

  const fetchPage = useCallback(
    (cursor: string | null) => {
      setLoading(true);
      api.workflows
        .deliveries(ruleId, { limit: PAGE, cursor })
        .then((rows) => {
          setDeliveries((prev) => (cursor ? [...prev, ...rows] : rows));
          setHasMore(rows.length === PAGE);
          setError(null);
        })
        .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Could not load the requests'))
        .finally(() => setLoading(false));
    },
    [ruleId]
  );

  useEffect(() => {
    setDeliveries([]);
    setHasMore(false);
    fetchPage(null);
  }, [fetchPage]);

  const loadMore = useCallback(() => {
    const last = deliveries[deliveries.length - 1];
    if (last) fetchPage(last.receivedAt);
  }, [deliveries, fetchPage]);

  const reload = useCallback(() => fetchPage(null), [fetchPage]);

  return { deliveries, loading, error, hasMore, loadMore, reload };
}

function DeliveryDetail({ ruleId, deliveryId }: { ruleId: string; deliveryId: string }) {
  const [detail, setDetail] = useState<InboundDelivery | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    api.workflows
      .delivery(ruleId, deliveryId)
      .then((next) => { if (active) setDetail(next); })
      .catch((err: unknown) => { if (active) setError(err instanceof Error ? err.message : 'Could not load this request'); });
    return () => { active = false; };
  }, [ruleId, deliveryId]);

  if (error) return <p className="text-xs text-red-500">{error}</p>;
  if (!detail) return <p className="text-xs text-muted-foreground">Loading...</p>;

  const headers = Object.entries(detail.headers ?? {});
  const body = typeof detail.payload === 'string' ? detail.payload : JSON.stringify(detail.payload, null, 2);
  return (
    <div className="space-y-2" data-attr="webhook-delivery-detail">
      <div>
        <div className="text-xs font-medium text-muted-foreground">Headers</div>
        {headers.length === 0 ? (
          <p className="text-xs text-muted-foreground">Talyn kept no headers for this request.</p>
        ) : (
          <dl className="mt-1 space-y-0.5 font-mono text-xs">
            {headers.map(([name, value]) => (
              <div key={name} className="flex gap-2">
                <dt className="text-muted-foreground">{name}:</dt>
                <dd className="break-all">{value}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>
      <div>
        <div className="text-xs font-medium text-muted-foreground">Body</div>
        <pre className="mt-1 max-h-80 overflow-auto rounded bg-muted p-2 font-mono text-xs" data-testid="webhook-delivery-payload">
          {body}
        </pre>
      </div>
    </div>
  );
}

/**
 * The requests a webhook rule received. Each row opens to show the body and
 * the headers Talyn kept. Replay sends a stored request through the rule again.
 */
export function WebhookDeliveriesList({ ruleId }: { ruleId: string }) {
  const { deliveries, loading, error, hasMore, loadMore, reload } = useWebhookDeliveries(ruleId);
  const [openId, setOpenId] = useState<string | null>(null);
  const [replaying, setReplaying] = useState<string | null>(null);

  const replay = async (delivery: InboundDeliverySummary) => {
    setReplaying(delivery.id);
    try {
      await api.workflows.replayDelivery(ruleId, delivery.id);
      toast.success('Request sent again');
      reload();
    } catch (err) {
      captureAnalyticsException(err, { flow: 'webhook_replay' });
      toast.error('Could not replay', err instanceof Error ? err.message : undefined);
    } finally {
      setReplaying(null);
    }
  };

  if (error) return <p className="p-4 text-sm text-red-500">{error}</p>;
  if (loading && deliveries.length === 0) {
    return <p className="p-4 text-sm text-muted-foreground">Loading requests...</p>;
  }
  if (deliveries.length === 0) {
    return (
      <p className="p-4 text-sm text-muted-foreground">
        No requests yet. Send a POST request to the webhook URL to start this automation.
      </p>
    );
  }

  return (
    <div className="divide-y" data-attr="webhook-deliveries">
      {deliveries.map((delivery) => {
        const open = openId === delivery.id;
        const outcomeKey = delivery.outcome ?? 'waiting';
        return (
          <div key={delivery.id} className="px-4 py-3" data-attr="webhook-delivery-row">
            <div className="flex items-center gap-2 text-sm">
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-2 text-left"
                aria-expanded={open}
                aria-label={`Request ${delivery.eventType} ${relative(delivery.receivedAt)}`}
                onClick={() => setOpenId(open ? null : delivery.id)}
              >
                {open ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
                <Badge variant={outcomeVariant(delivery.outcome)}>{OUTCOME_LABELS[outcomeKey]}</Badge>
                <span className="truncate font-medium">{delivery.eventType}</span>
                {delivery.replayOf && <Badge variant="outline">Replay</Badge>}
                <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                  {delivery.attempts} {delivery.attempts === 1 ? 'attempt' : 'attempts'} · {formatBytes(delivery.payloadBytes)} ·{' '}
                  {relative(delivery.receivedAt)}
                </span>
              </button>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs"
                disabled={replaying !== null}
                aria-label={`Replay request ${delivery.id}`}
                onClick={() => void replay(delivery)}
              >
                <RotateCcw className="mr-1 h-3.5 w-3.5" />
                Replay
              </Button>
            </div>
            {delivery.error && <p className="mt-1 text-xs text-red-500">{delivery.error}</p>}
            {open && (
              <div className="mt-2">
                <DeliveryDetail ruleId={ruleId} deliveryId={delivery.id} />
              </div>
            )}
          </div>
        );
      })}

      {hasMore && (
        <div className="p-3">
          <Button variant="outline" size="sm" onClick={loadMore} disabled={loading}>
            {loading ? 'Loading...' : 'Load more'}
          </Button>
        </div>
      )}
    </div>
  );
}
