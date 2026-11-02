import { useEffect, useState } from 'react';
import { Download, Loader2 } from 'lucide-react';
import type { BillingOrder } from '@talyn/shared';
import { api } from '../../../lib/api';
import { openExternal } from '../../../lib/openExternal';
import { Button } from '../../ui/button';
import { Card } from '../../ui/card';

/**
 * Past orders, newest first. Shown for anyone with past orders (a now-free
 * user can still grab an old invoice). Refetched when `planKey` changes: a
 * fresh checkout lands its first order moments after the WS push.
 */
export function OrderHistory({ planKey, fallbackName = 'Talyn' }: { planKey: string; fallbackName?: string }) {
  const [orders, setOrders] = useState<BillingOrder[] | null>(null);
  const [invoiceBusy, setInvoiceBusy] = useState<string | null>(null);
  const [invoiceError, setInvoiceError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.billing
      .orders()
      .then((rows) => {
        if (!cancelled) setOrders(rows);
      })
      .catch(() => {
        if (!cancelled) setOrders([]);
      });
    return () => {
      cancelled = true;
    };
  }, [planKey]);

  const openInvoice = async (orderId: string) => {
    setInvoiceBusy(orderId);
    setInvoiceError(null);
    try {
      const { url } = await api.billing.invoice(orderId);
      await openExternal(url);
    } catch (err) {
      setInvoiceError(err instanceof Error ? err.message : 'Could not fetch the invoice');
    } finally {
      setInvoiceBusy(null);
    }
  };

  if (!orders || orders.length === 0) return null;
  return (
    <div>
      <h3 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground mb-2">Order history</h3>
      <Card className="divide-y p-0">
        {orders.map((order) => (
          <div key={order.id} className="flex items-center gap-3 px-3 py-2">
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-medium truncate">{order.productName ?? fallbackName}</p>
              <p className="text-xs text-muted-foreground">
                {formatRenewalDate(order.createdAt)}
                {order.invoiceNumber ? ` · ${order.invoiceNumber}` : ''}
              </p>
            </div>
            <div className="text-[13px] font-medium tabular-nums">
              {formatOrderAmount(order.amount, order.currency)}
            </div>
            {order.status !== 'paid' && (
              <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground capitalize">
                {order.status.replace('_', ' ')}
              </span>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => openInvoice(order.id)}
              disabled={invoiceBusy !== null}
              className="shrink-0"
              title="Open the invoice in your browser"
            >
              {invoiceBusy === order.id ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Download className="w-3.5 h-3.5" />
              )}
              Invoice
            </Button>
          </div>
        ))}
      </Card>
      {invoiceError && <p className="text-xs text-destructive mt-2">{invoiceError}</p>}
    </div>
  );
}

export function formatRenewalDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  } catch {
    return iso;
  }
}

function formatOrderAmount(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: currency.toUpperCase(),
    }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
}
