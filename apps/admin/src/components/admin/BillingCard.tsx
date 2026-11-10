import { useState } from 'react';
import { formatBoxHours, formatBoxHoursPrecise, formatBoxHoursUsage, formatUsd, type AdminBillingLot, type AdminBillingView } from '@talyn/shared';
import { api } from '../../lib/api';
import { useAdminQuery } from '../../hooks/useAdminQuery';
import { absolute, relativeAge } from '../../lib/format';
import { Pill } from '../layout/Page';
import { StatCard } from '../ui/StatCard';
import { toast } from '../../stores/toast';
import { MIN_REASON_LENGTH } from './ConfirmMutationDialog';

/**
 * One account's usage billing: tier, this period's meter, open boxes, credit
 * lots and auto top-up, plus the two actions an operator has (grant credits,
 * reverse a lot).
 *
 * The confirmation is part of the card, not a browser dialog: an action opens a
 * panel that states what will happen and asks for the reason, and only its
 * confirm button sends the request. On failure the panel stays open with the
 * typed reason intact. The grant carries one idempotency key per opened panel,
 * so a double click or a retry after a dropped response grants once.
 */

type Action =
  | { kind: 'grant'; key: string }
  | { kind: 'reverse'; lot: AdminBillingLot };

function newKey(): string {
  return globalThis.crypto?.randomUUID?.() ?? `k-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function BillingCard({ userId, email, canMutate }: { userId: string; email: string; canMutate: boolean }) {
  const { data, error, initialLoading, refresh } = useAdminQuery(() => api.admin.users.billing(userId), {
    deps: [userId],
  });
  const [action, setAction] = useState<Action | null>(null);

  if (!data) {
    return (
      <section className="mt-6" aria-label="Usage billing">
        <Heading />
        {initialLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {error ?? 'Could not load billing.'}
          </div>
        )}
      </section>
    );
  }

  const usage = data.usage;
  const usedPct = usage && usage.includedWsec > 0 ? Math.min(100, (usage.usedWsec / usage.includedWsec) * 100) : null;

  return (
    <section className="mt-6" aria-label="Usage billing">
      <Heading />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Tier" value={data.tier} hint={`from ${data.source}`} />
        <StatCard
          label="Box-hours this period"
          value={usage ? formatBoxHoursUsage(usage.usedWsec, usage.includedWsec) : '—'}
          barPct={usedPct}
          tone={usage?.exhaustedAt ? 'critical' : 'default'}
          hint={`${absolute(data.period.start)} to ${absolute(data.period.end)}${usage ? '' : ' (no usage yet)'}`}
        />
        <StatCard label="Credit balance" value={formatUsd(data.creditBalanceMicros)} hint="live lots only" />
        <StatCard
          label="Open boxes"
          value={`${data.openBoxes.length}`}
          tone={usage?.exhaustedAt ? 'critical' : 'default'}
          hint={usage?.exhaustedAt ? `exhausted ${relativeAge(usage.exhaustedAt)} ago` : undefined}
        />
      </div>

      {usage && (usage.creditMicrosUsed > 0 || usage.uncoveredMicros > 0) && (
        <p className="mt-2 text-xs text-muted-foreground">
          Credits used this period: {formatUsd(usage.creditMicrosUsed)}. Overage the credits did not cover:{' '}
          {formatUsd(usage.uncoveredMicros)}.
        </p>
      )}

      {usage && (usage.resetUsedWsec ?? 0) > 0 && (
        <p className="mt-2 text-xs text-muted-foreground" data-testid="billing-reset-hours">
          Usage resets cleared {formatBoxHours(usage.resetUsedWsec ?? 0)} box-hours this period (not in the figure above).
        </p>
      )}

      <h3 className="mb-1 mt-4 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Auto top-up</h3>
      {data.autoTopup ? (
        <div className="rounded-lg border border-border bg-card p-3 text-xs">
          <div>
            {data.autoTopup.enabled ? 'On' : 'Off'}: buys the ${data.autoTopup.pack} pack below{' '}
            {formatUsd(data.autoTopup.triggerMicros)}, up to {formatUsd(data.autoTopup.monthlyLimitMicros)} a month (
            {formatUsd(data.autoTopup.monthSpentMicros)} spent this month).
          </div>
          {data.autoTopup.lastFailure && (
            <div className="mt-1 text-destructive">
              Last failure{data.autoTopup.lastFailureAt ? ` ${relativeAge(data.autoTopup.lastFailureAt)} ago` : ''}:{' '}
              {data.autoTopup.lastFailure}
            </div>
          )}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">Never configured.</p>
      )}

      <div className="mb-1 mt-4 flex items-center justify-between">
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Credit lots</h3>
        {canMutate && (
          <button
            onClick={() => setAction({ kind: 'grant', key: newKey() })}
            className="rounded-md border border-border px-2.5 py-1 text-xs hover:bg-accent"
          >
            Grant credits
          </button>
        )}
      </div>
      {action?.kind === 'grant' && (
        <GrantPanel
          userId={userId}
          email={email}
          idempotencyKey={action.key}
          onCancel={() => setAction(null)}
          onDone={() => {
            setAction(null);
            refresh();
          }}
        />
      )}
      {data.lots.length === 0 ? (
        <p className="text-xs text-muted-foreground">No credit lots.</p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border bg-card text-xs">
          {data.lots.map((lot) => (
            <li key={lot.id} className="px-3 py-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono">{lot.source}</span>
                <span>
                  {formatUsd(lot.remainingMicros)} of {formatUsd(lot.totalMicros)}
                </span>
                <span className="text-muted-foreground" title={absolute(lot.expiresAt)}>
                  {lot.live ? `expires ${absolute(lot.expiresAt)}` : lot.remainingMicros > 0 ? 'expired' : 'spent'}
                </span>
                {canMutate && lot.live && (
                  <button
                    onClick={() => setAction({ kind: 'reverse', lot })}
                    className="ml-auto rounded-md border border-border px-2 py-0.5 hover:bg-accent"
                  >
                    Reverse
                  </button>
                )}
              </div>
              {action?.kind === 'reverse' && action.lot.id === lot.id && (
                <ReversePanel
                  userId={userId}
                  lot={lot}
                  onCancel={() => setAction(null)}
                  onDone={() => {
                    setAction(null);
                    refresh();
                  }}
                />
              )}
            </li>
          ))}
        </ul>
      )}

      <h3 className="mb-1 mt-4 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Open boxes</h3>
      {data.openBoxes.length === 0 ? (
        <p className="text-xs text-muted-foreground">None running.</p>
      ) : (
        <IntervalList rows={data.openBoxes.map((b) => ({ ...b, endedAt: null, endReason: null, billedWsec: 0 }))} />
      )}

      <h3 className="mb-1 mt-4 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        Recent usage intervals
      </h3>
      {data.recentIntervals.length === 0 ? (
        <p className="text-xs text-muted-foreground">No usage recorded.</p>
      ) : (
        <IntervalList rows={data.recentIntervals} />
      )}
    </section>
  );
}

function Heading() {
  return (
    <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Usage billing</h2>
  );
}

function IntervalList({ rows }: { rows: AdminBillingView['recentIntervals'] }) {
  return (
    <ul className="divide-y divide-border rounded-lg border border-border bg-card text-xs">
      {rows.map((r) => (
        <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5">
          <span className="font-mono">{r.subjectKind}</span>
          <span>{r.size}</span>
          <span title={absolute(r.startedAt)}>started {relativeAge(r.startedAt)} ago</span>
          {r.endedAt ? (
            <span className="text-muted-foreground">
              ended {r.endReason ?? ''} · {formatBoxHoursPrecise(r.billedWsec)} box-hours billed
            </span>
          ) : (
            <>
              <Pill tone="warn">running</Pill>
              <span className="text-muted-foreground">
                {formatBoxHoursPrecise(r.billedWsec)} box-hours billed so far
              </span>
            </>
          )}
        </li>
      ))}
    </ul>
  );
}

function ActionPanel({
  summary,
  actionLabel,
  destructive,
  reasonId,
  onCancel,
  onSubmit,
  disabled,
  children,
}: {
  summary: string;
  actionLabel: string;
  destructive?: boolean;
  reasonId: string;
  onCancel: () => void;
  onSubmit: (reason: string) => Promise<void>;
  disabled?: boolean;
  children?: React.ReactNode;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const ready = reason.trim().length >= MIN_REASON_LENGTH && !disabled && !busy;

  async function submit() {
    setBusy(true);
    setFailure(null);
    try {
      await onSubmit(reason.trim());
    } catch (err) {
      setFailure(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <div role="group" aria-label={actionLabel} className="my-2 space-y-2 rounded-md border border-border bg-background p-3 text-xs">
      <p>{summary}</p>
      {children}
      <label htmlFor={reasonId} className="block font-medium">
        Reason
      </label>
      <textarea
        id={reasonId}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        rows={2}
        placeholder={`At least ${MIN_REASON_LENGTH} characters. It goes into the audit log.`}
        className="w-full rounded-md border border-border bg-card px-2 py-1"
      />
      {failure && <p role="alert" className="text-destructive">{failure}</p>}
      <div className="flex gap-2">
        <button
          onClick={() => void submit()}
          disabled={!ready}
          className={`rounded-md px-2.5 py-1 text-xs text-white disabled:opacity-50 ${destructive ? 'bg-destructive' : 'bg-primary'}`}
        >
          {busy ? 'Working…' : actionLabel}
        </button>
        <button onClick={onCancel} disabled={busy} className="rounded-md border border-border px-2.5 py-1 hover:bg-accent">
          Cancel
        </button>
      </div>
    </div>
  );
}

function GrantPanel({
  userId,
  email,
  idempotencyKey,
  onCancel,
  onDone,
}: {
  userId: string;
  email: string;
  idempotencyKey: string;
  onCancel: () => void;
  onDone: () => void;
}) {
  const [amount, setAmount] = useState('');
  const parsed = Number(amount);
  const valid = amount.trim() !== '' && Number.isFinite(parsed) && parsed > 0;
  return (
    <ActionPanel
      summary={`Grant credits to ${email}. The lot expires in 12 months and lifts any exhaustion.`}
      actionLabel={valid ? `Grant $${parsed.toFixed(2)}` : 'Grant credits'}
      reasonId="grant-reason"
      onCancel={onCancel}
      disabled={!valid}
      onSubmit={async (reason) => {
        await api.admin.users.grantCredits(userId, { amountUsd: parsed, reason, idempotencyKey });
        toast.success('Credits granted');
        onDone();
      }}
    >
      <label htmlFor="grant-amount" className="block font-medium">
        Amount (USD)
      </label>
      <input
        id="grant-amount"
        inputMode="decimal"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        className="w-32 rounded-md border border-border bg-card px-2 py-1"
      />
    </ActionPanel>
  );
}

function ReversePanel({
  userId,
  lot,
  onCancel,
  onDone,
}: {
  userId: string;
  lot: AdminBillingLot;
  onCancel: () => void;
  onDone: () => void;
}) {
  return (
    <ActionPanel
      summary={`Reverse this lot. The ${formatUsd(lot.remainingMicros)} still in it is removed and cannot be restored except by a new grant.`}
      actionLabel="Reverse lot"
      destructive
      reasonId={`reverse-reason-${lot.id}`}
      onCancel={onCancel}
      onSubmit={async (reason) => {
        await api.admin.users.reverseCreditLot(userId, lot.id, { reason });
        toast.success('Lot reversed');
        onDone();
      }}
    />
  );
}
