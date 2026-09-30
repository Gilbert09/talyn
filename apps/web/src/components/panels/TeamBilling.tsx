import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, CreditCard, Download, Loader2, UserPlus, Users, X } from 'lucide-react';
import {
  TEAM_MIN_SEATS,
  teamPriceFor,
  type BillingOrder,
  type BillingStatus,
  type TeamDetail,
  type TeamPricing,
} from '@talyn/shared';
import { api } from '../../lib/api';
import { trackEvent } from '../../lib/analytics';
import { openExternal } from '../../lib/openExternal';
import { useBillingStore } from '../../stores/billing';
import { useWorkspaceStore } from '../../stores/workspace';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { ConfirmDialog } from '../ui/confirm-dialog';
import { Input } from '../ui/input';
import { Textarea } from '../ui/textarea';

/**
 * The team plan in Settings → Billing: seats one buyer pays for, each giving a
 * GitHub account Unlimited on its own account. Nothing is shared.
 *
 * Three views. A seated member always sees who pays for them — that is a fact
 * about their plan, not a feature, so it does not wait on the `teams` flag. An
 * admin sees the team; everybody else sees the offer to start one. Those two
 * are behind the flag, and the backend refuses them without it anyway.
 */
export function TeamBilling({ status }: { status: BillingStatus }) {
  const teamsOffered = useWorkspaceStore((s) => s.features?.teams === true);
  const team = status.team;

  if (team?.isAdmin && teamsOffered) return <TeamAdminPanel teamId={team.id} />;
  if (team?.hasSeat) {
    return <TeamMemberCard name={team.name} active={team.active} paidPersonallyToo={team.paidPersonallyToo} />;
  }
  if (!team && teamsOffered) return <StartTeamCard />;
  return null;
}

function formatMoney(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: currency.toUpperCase(),
    }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

function errorText(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

function TeamMemberCard({
  name,
  active,
  paidPersonallyToo,
}: {
  name: string;
  active: boolean;
  paidPersonallyToo: boolean;
}) {
  const refresh = useBillingStore((s) => s.refresh);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const leave = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.billing.team.leave();
      trackEvent('team_left');
      setConfirming(false);
      await refresh();
    } catch (err) {
      setError(errorText(err, 'Could not leave the team'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <h3 className="text-lg font-semibold mb-4">Team</h3>
      <Card className="p-4 space-y-3">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <Users className="w-5 h-5 text-primary mt-0.5 shrink-0" />
            <div>
              <p className="font-medium">{name}</p>
              <p className="text-sm text-muted-foreground">
                {active
                  ? 'Your team pays for your Unlimited plan.'
                  : 'Your team is not paying for seats at the moment, so your own plan applies.'}
              </p>
            </div>
          </div>
          <Button variant="outline" size="sm" onClick={() => setConfirming(true)}>
            Leave team
          </Button>
        </div>
        {paidPersonallyToo && active && (
          <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3">
            <AlertCircle className="w-4 h-4 text-amber-600 mt-0.5 shrink-0" />
            <p className="text-sm">
              You also pay for Unlimited yourself. Your team covers you now, so you can cancel
              your own subscription with Manage subscription above.
            </p>
          </div>
        )}
        {error && <p className="text-sm text-destructive">{error}</p>}
      </Card>
      <ConfirmDialog
        open={confirming}
        title={`Leave ${name}?`}
        description="Your seat is freed for someone else, and your account goes back to your own plan."
        confirmLabel="Leave team"
        busy={busy}
        onConfirm={() => void leave()}
        onCancel={() => setConfirming(false)}
      />
    </div>
  );
}

function StartTeamCard() {
  const refresh = useBillingStore((s) => s.refresh);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.billing.team.create({ name });
      trackEvent('team_created');
      await refresh();
    } catch (err) {
      setError(errorText(err, 'Could not create the team'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <h3 className="text-lg font-semibold mb-4">Buying for a team?</h3>
      <Card className="p-4 space-y-3">
        <p className="text-sm text-muted-foreground">
          Pay for everyone on one invoice. You choose who gets a seat by GitHub username, and
          each person gets Unlimited on their own account. Workspaces stay private to each
          person.
        </p>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Team name, e.g. your company"
            maxLength={80}
          />
          <Button type="submit" disabled={busy || !name.trim()} className="gap-2 shrink-0">
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Users className="w-4 h-4" />}
            Start a team
          </Button>
        </form>
        {error && <p className="text-sm text-destructive">{error}</p>}
      </Card>
    </div>
  );
}

function TeamAdminPanel({ teamId }: { teamId: string }) {
  const status = useBillingStore((s) => s.status);
  const startCheckoutPollBurst = useBillingStore((s) => s.startCheckoutPollBurst);
  const [team, setTeam] = useState<TeamDetail | null>(null);
  const [pricing, setPricing] = useState<TeamPricing | null>(null);
  const [orders, setOrders] = useState<BillingOrder[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setTeam(await api.billing.team.get(teamId));
      setLoadError(null);
    } catch (err) {
      setLoadError(errorText(err, 'Could not load the team'));
    }
  }, [teamId]);

  // Reload on every billing status push: a checkout or a seat change lands
  // through the webhook, which pushes a fresh status to every admin.
  useEffect(() => {
    void load();
  }, [load, status]);

  useEffect(() => {
    api.billing.team.pricing().then(setPricing, () => setPricing(null));
  }, []);

  useEffect(() => {
    if (!team?.active) return;
    api.billing.team.orders(teamId).then(setOrders, () => setOrders([]));
  }, [teamId, team?.active]);

  if (loadError) {
    return (
      <div>
        <h3 className="text-lg font-semibold mb-4">Team</h3>
        <Card className="p-4">
          <p className="text-sm text-destructive">{loadError}</p>
        </Card>
      </div>
    );
  }
  if (!team) {
    return (
      <div>
        <h3 className="text-lg font-semibold mb-4">Team</h3>
        <Card className="p-4">
          <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
        </Card>
      </div>
    );
  }

  const run = async (action: () => Promise<unknown>, fallback: string) => {
    setError(null);
    try {
      await action();
      await load();
    } catch (err) {
      setError(errorText(err, fallback));
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold mb-4">Team: {team.name}</h3>
        <Card className="p-4 space-y-4">
          {team.active ? (
            <TeamSubscriptionSummary
              team={team}
              onChangeSeats={(seats) =>
                run(async () => {
                  await api.billing.team.setSeatCount(teamId, seats);
                  trackEvent('team_seat_count_changed', { from: team.seatsPurchased, to: seats });
                  startCheckoutPollBurst();
                }, 'Could not change the seat count')
              }
              onPortal={() =>
                run(async () => {
                  const { url } = await api.billing.team.portal(teamId);
                  await openExternal(url);
                  startCheckoutPollBurst();
                }, 'Could not open billing')
              }
            />
          ) : (
            <BuySeats
              teamId={teamId}
              pricing={pricing}
              onStarted={() => startCheckoutPollBurst()}
            />
          )}

          {team.overAllocated && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3">
              <AlertCircle className="w-4 h-4 text-destructive mt-0.5 shrink-0" />
              <p className="text-sm">
                {team.seatsUsed} people hold seats, but the team pays for {team.seatsPurchased}.
                Remove {team.seatsUsed - team.seatsPurchased} or add seats. Nobody can be added
                until the numbers match.
              </p>
            </div>
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
        </Card>
      </div>

      {team.active && (
        <SeatList
          team={team}
          onAssigned={load}
          onRemove={(seatId) =>
            run(async () => {
              await api.billing.team.removeSeat(teamId, seatId);
              trackEvent('team_seat_removed');
            }, 'Could not remove the seat')
          }
        />
      )}

      <AdminList
        team={team}
        onAdd={(login) => run(() => api.billing.team.addAdmin(teamId, login), 'Could not add the admin')}
        onRemove={(userId) =>
          run(() => api.billing.team.removeAdmin(teamId, userId), 'Could not remove the admin')
        }
      />

      {orders.length > 0 && <TeamOrders teamId={teamId} orders={orders} />}
    </div>
  );
}

function TeamSubscriptionSummary({
  team,
  onChangeSeats,
  onPortal,
}: {
  team: TeamDetail;
  onChangeSeats: (seats: number) => Promise<void>;
  onPortal: () => Promise<void>;
}) {
  const [seats, setSeats] = useState(team.seatsPurchased);
  const [busy, setBusy] = useState<null | 'seats' | 'portal'>(null);
  useEffect(() => {
    setSeats(team.seatsPurchased);
  }, [team.seatsPurchased]);

  return (
    <div className="space-y-4">
      <div>
        <p className="font-medium">
          {team.seatsUsed} of {team.seatsPurchased} seats used
        </p>
        {team.planSource === 'override' ? (
          <p className="text-sm text-muted-foreground">Complimentary — nothing to pay.</p>
        ) : (
          team.currentPeriodEnd && (
            <p className="text-sm text-muted-foreground">
              {team.cancelAtPeriodEnd
                ? `Seats stay active until ${formatDate(team.currentPeriodEnd)}, then end.`
                : `Renews ${formatDate(team.currentPeriodEnd)}.`}
            </p>
          )
        )}
        {team.subscriptionStatus === 'past_due' && (
          <p className="text-sm text-destructive mt-1">
            The last payment failed. Update the payment method in Manage billing.
          </p>
        )}
      </div>
      {team.planSource !== 'override' && (
        <div className="flex flex-wrap items-center gap-2">
          <Input
            type="number"
            min={Math.max(TEAM_MIN_SEATS, team.seatsUsed)}
            value={seats}
            onChange={(e) => setSeats(Number(e.target.value))}
            className="w-24"
            aria-label="Seats"
          />
          <Button
            variant="outline"
            disabled={busy !== null || seats === team.seatsPurchased}
            onClick={async () => {
              setBusy('seats');
              await onChangeSeats(seats);
              setBusy(null);
            }}
          >
            {busy === 'seats' && <Loader2 className="w-4 h-4 animate-spin mr-2" />}
            Change seat count
          </Button>
          {seats !== team.seatsPurchased && (
            <span className="text-sm text-muted-foreground">
              Billed pro rata from today.
            </span>
          )}
          <Button
            variant="outline"
            className="gap-2 ml-auto"
            disabled={busy !== null}
            onClick={async () => {
              setBusy('portal');
              await onPortal();
              setBusy(null);
            }}
          >
            {busy === 'portal' ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <CreditCard className="w-4 h-4" />
            )}
            Manage billing
          </Button>
        </div>
      )}
    </div>
  );
}

function BuySeats({
  teamId,
  pricing,
  onStarted,
}: {
  teamId: string;
  pricing: TeamPricing | null;
  onStarted: () => void;
}) {
  const [seats, setSeats] = useState(3);
  const [period, setPeriod] = useState<'monthly' | 'annual'>('monthly');
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const tiers = pricing?.[period] ?? null;
  // The larger of the two floors: Polar's product may allow one seat, but a
  // team starts at TEAM_MIN_SEATS and the backend refuses fewer.
  const minimum = Math.max(TEAM_MIN_SEATS, tiers?.minimumSeats ?? 0);
  const price = tiers && seats >= minimum ? teamPriceFor(tiers, seats) : null;

  const checkout = async () => {
    setBusy(true);
    setError(null);
    try {
      const { url } = await api.billing.team.checkout(teamId, { period, seats });
      trackEvent('team_checkout_started', { seats, period });
      await openExternal(url);
      onStarted();
      setWaiting(true);
    } catch (err) {
      setError(errorText(err, 'Could not start checkout'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Choose how many seats to buy. You add people by GitHub username once payment
        completes, and you get a seat yourself unless you remove it.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          type="number"
          min={minimum}
          value={seats}
          onChange={(e) => setSeats(Number(e.target.value))}
          className="w-24"
          aria-label="Seats"
        />
        <span className="text-sm">seats</span>
        {(['monthly', 'annual'] as const)
          .filter((p) => pricing?.[p])
          .map((p) => (
            <Button
              key={p}
              size="sm"
              variant={period === p ? 'default' : 'outline'}
              onClick={() => setPeriod(p)}
            >
              {p === 'monthly' ? 'Monthly' : 'Annual'}
            </Button>
          ))}
      </div>
      {tiers && (
        <p className="text-sm">
          {price !== null ? (
            <>
              <span className="font-medium">{formatMoney(price, tiers.currency)}</span>
              <span className="text-muted-foreground">
                {' '}
                a {period === 'monthly' ? 'month' : 'year'} ({formatMoney(Math.round(price / seats), tiers.currency)} a seat)
              </span>
            </>
          ) : (
            <span className="text-muted-foreground">
              Choose at least {minimum} seats
              {tiers.maximumSeats !== null ? ` and at most ${tiers.maximumSeats}` : ''}.
            </span>
          )}
        </p>
      )}
      <Button onClick={() => void checkout()} disabled={busy || waiting || price === null} className="gap-2">
        {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <CreditCard className="w-4 h-4" />}
        Buy {seats} seats
      </Button>
      {waiting && (
        <p className="text-sm text-muted-foreground">
          <Loader2 className="mr-1 inline h-3.5 w-3.5 animate-spin" />
          Finish checkout in your browser. This page updates by itself once payment completes.
        </p>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}

/** Split what somebody pasted into logins: commas, spaces and new lines all separate. */
function parseLogins(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function SeatList({
  team,
  onAssigned,
  onRemove,
}: {
  team: TeamDetail;
  onAssigned: () => Promise<void>;
  onRemove: (seatId: string) => Promise<void>;
}) {
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [failed, setFailed] = useState<Array<{ login: string; reason: string }>>([]);
  const [removing, setRemoving] = useState<{ id: string; login: string } | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);

  const assign = async () => {
    setBusy(true);
    setError(null);
    setFailed([]);
    try {
      const result = await api.billing.team.assignSeats(team.id, { logins: parseLogins(input) });
      trackEvent('team_seats_assigned', {
        assigned: result.assigned.length,
        failed: result.failed.length,
      });
      setFailed(result.failed);
      setInput(result.failed.map((f) => f.login).join(', '));
      await onAssigned();
    } catch (err) {
      setError(errorText(err, 'Could not add those people'));
    } finally {
      setBusy(false);
    }
  };

  const free = Math.max(0, team.seatsPurchased - team.seatsUsed);

  return (
    <div>
      <h3 className="text-lg font-semibold mb-4">Seats</h3>
      <Card className="p-4 space-y-4">
        {/* A textarea, not an input: an input strips the newlines out of a
            pasted column of usernames and joins them into one. */}
        <form
          className="flex items-start gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void assign();
          }}
        >
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="GitHub usernames, separated by commas, spaces or new lines"
            rows={2}
            disabled={free === 0}
          />
          <Button type="submit" disabled={busy || free === 0 || !input.trim()} className="gap-2 shrink-0">
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <UserPlus className="w-4 h-4" />}
            Add
          </Button>
        </form>
        <p className="text-xs text-muted-foreground">
          {free === 0
            ? 'Every seat is taken. Add seats above, or remove someone.'
            : `${free} seat${free === 1 ? '' : 's'} free. A seat works the moment that person signs in to Talyn with GitHub.`}
        </p>
        {failed.length > 0 && (
          <ul className="text-sm text-destructive space-y-0.5">
            {failed.map((f) => (
              <li key={f.login}>
                @{f.login}: {f.reason}
              </li>
            ))}
          </ul>
        )}
        {error && <p className="text-sm text-destructive">{error}</p>}

        {team.seats.length > 0 && (
          <div className="divide-y rounded-md border">
            {team.seats.map((seat) => (
              <div key={seat.id} className="flex items-center gap-3 px-3 py-2">
                {seat.avatarUrl ? (
                  <img src={seat.avatarUrl} alt="" className="w-6 h-6 rounded-full" />
                ) : (
                  <div className="w-6 h-6 rounded-full bg-muted" />
                )}
                <span className="text-sm font-medium">@{seat.githubLogin}</span>
                {!seat.signedUp && (
                  <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                    Not signed in yet
                  </span>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  className="ml-auto"
                  title="Remove this seat"
                  onClick={() => setRemoving({ id: seat.id, login: seat.githubLogin })}
                >
                  <X className="w-4 h-4" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </Card>
      <ConfirmDialog
        open={removing !== null}
        title={removing ? `Remove @${removing.login}'s seat?` : ''}
        description="They go back to their own plan straight away. Their workspaces are not touched."
        confirmLabel="Remove seat"
        busy={removeBusy}
        onConfirm={async () => {
          if (!removing) return;
          setRemoveBusy(true);
          await onRemove(removing.id);
          setRemoveBusy(false);
          setRemoving(null);
        }}
        onCancel={() => setRemoving(null)}
      />
    </div>
  );
}

function AdminList({
  team,
  onAdd,
  onRemove,
}: {
  team: TeamDetail;
  onAdd: (login: string) => Promise<void>;
  onRemove: (userId: string) => Promise<void>;
}) {
  const [login, setLogin] = useState('');
  const [busy, setBusy] = useState(false);

  return (
    <div>
      <h3 className="text-lg font-semibold mb-4">Admins</h3>
      <Card className="p-4 space-y-3">
        <p className="text-sm text-muted-foreground">
          Admins manage seats and billing. An admin does not need a seat.
        </p>
        <div className="divide-y rounded-md border">
          {team.admins.map((admin) => (
            <div key={admin.userId} className="flex items-center gap-3 px-3 py-2">
              <span className="text-sm">
                {admin.githubUsername ? `@${admin.githubUsername}` : admin.email}
              </span>
              {team.admins.length > 1 && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="ml-auto"
                  title="Remove this admin"
                  onClick={() => void onRemove(admin.userId)}
                >
                  <X className="w-4 h-4" />
                </Button>
              )}
            </div>
          ))}
        </div>
        <form
          className="flex gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            await onAdd(login);
            setLogin('');
            setBusy(false);
          }}
        >
          <Input
            value={login}
            onChange={(e) => setLogin(e.target.value)}
            placeholder="GitHub username of someone who uses Talyn"
          />
          <Button type="submit" variant="outline" disabled={busy || !login.trim()} className="shrink-0">
            Add admin
          </Button>
        </form>
      </Card>
    </div>
  );
}

function TeamOrders({ teamId, orders }: { teamId: string; orders: BillingOrder[] }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const open = async (orderId: string) => {
    setBusy(orderId);
    setError(null);
    try {
      const { url } = await api.billing.team.invoice(teamId, orderId);
      await openExternal(url);
    } catch (err) {
      setError(errorText(err, 'Could not fetch the invoice'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div>
      <h3 className="text-lg font-semibold mb-4">Team invoices</h3>
      <Card className="divide-y p-0">
        {orders.map((order) => (
          <div key={order.id} className="flex items-center gap-4 px-4 py-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium truncate">{order.productName ?? 'Talyn Team'}</p>
              <p className="text-xs text-muted-foreground">
                {formatDate(order.createdAt)}
                {order.invoiceNumber ? ` · ${order.invoiceNumber}` : ''}
              </p>
            </div>
            <div className="text-sm font-medium tabular-nums">
              {formatMoney(order.amount, order.currency)}
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void open(order.id)}
              disabled={busy !== null}
              className="gap-1.5 shrink-0"
            >
              {busy === order.id ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Download className="w-3.5 h-3.5" />
              )}
              Invoice
            </Button>
          </div>
        ))}
      </Card>
      {error && <p className="text-sm text-destructive mt-2">{error}</p>}
    </div>
  );
}
