import {
  ADMIN_FLEET_NOT_CONFIGURED,
  ADMIN_FLEET_UNREACHABLE,
  ADMIN_HOST_NOT_DIALABLE,
  ADMIN_HOST_OFFLINE,
  type AdminFleetHost,
  type AdminFleetLiveErrorCode,
  type AdminHostBoxCounts,
  type AdminHostCondition,
  type AdminHostHealth,
} from '@talyn/shared';
import { FleetClient, type FleetSandbox } from '../selfHosted/client.js';
import {
  fleetApiToken,
  fleetGatewayToken,
  fleetPinnedEndpoint,
} from '../selfHosted/credentials.js';
import { getFleetHost, listFleetHosts, type FleetHostView } from '../fleetHosts.js';

/**
 * How the operator console reaches fleetd.
 *
 * # The degradation contract
 *
 * The fleet page is the page you open BECAUSE a host is misbehaving. If one
 * dead box can fail the request, the console is unavailable exactly when it is
 * needed. So every READ goes through `probe()`, which never throws: an
 * unreachable host renders as a row with a reason attached.
 *
 * MUTATIONS do not degrade. A drain that could not reach fleetd is a 502 with
 * the upstream message, because the operator must know the box was not told.
 * Softening that into "probably fine" is how a host stays live through an
 * incident somebody believes they drained.
 *
 * # Timeouts
 *
 * Reads use 5s: a page fanning out over hosts cannot hang 20s on one dead box,
 * and a host that has not answered in five seconds over a private link is not
 * about to. Golden GC and rebake use 60s — those are genuinely slow, and their
 * failure mode is an operator staring at a spinner rather than a page-wide
 * stall.
 */

/** A console read. Short, because a fan-out is only as fast as its slowest leg. */
export const ADMIN_READ_TIMEOUT_MS = 5_000;
/** GC and rebake genuinely take this long. */
export const ADMIN_SLOW_MUTATION_TIMEOUT_MS = 60_000;

export class HostUnknownError extends Error {
  readonly status = 404;
  readonly code = 'host_unknown';
  constructor(name: string) {
    super(`No fleet host named "${name}" has ever reported in.`);
    this.name = 'HostUnknownError';
  }
}

export class HostNotDialableError extends Error {
  readonly status = 409;
  readonly code = ADMIN_HOST_NOT_DIALABLE;
  constructor(name: string) {
    super(`Host "${name}" has advertised no API endpoint, so there is nowhere to dial.`);
    this.name = 'HostNotDialableError';
  }
}

export class HostOfflineError extends Error {
  readonly status = 409;
  readonly code = ADMIN_HOST_OFFLINE;
  constructor(name: string, reportedAt: Date) {
    super(`Host "${name}" last reported at ${reportedAt.toISOString()} and is presumed gone.`);
    this.name = 'HostOfflineError';
  }
}

export class FleetNotConfiguredError extends Error {
  readonly status = 503;
  readonly code = ADMIN_FLEET_NOT_CONFIGURED;
  constructor() {
    super('FLEET_API_TOKEN is not set on this deployment.');
    this.name = 'FleetNotConfiguredError';
  }
}

/** Map a proxy error onto its HTTP response, or return false. */
export function handleFleetProxyError(err: unknown, res: {
  status: (code: number) => { json: (body: unknown) => unknown };
}): boolean {
  if (
    err instanceof HostUnknownError ||
    err instanceof HostNotDialableError ||
    err instanceof HostOfflineError ||
    err instanceof FleetNotConfiguredError
  ) {
    res.status(err.status).json({ success: false, error: err.message, code: err.code });
    return true;
  }
  return false;
}

/**
 * A client aimed at one named host.
 *
 * Distinct from `resolveFleetTarget`, which is workspace-scoped and needs the
 * workspace's Claude token — the wrong shape entirely for an operator asking
 * about a specific box.
 *
 * A STALE HOST IS NEVER DIALLED unless `allowOffline`. Registration does not
 * imply reachability (see the header comment on services/fleetHosts.ts): the
 * report is outbound and dispatch is inbound. Dialling a host whose last
 * report is minutes old means waiting the full timeout to be told what the
 * registry already knew.
 */
export async function fleetClientForHost(
  name: string,
  opts: { timeoutMs?: number; allowOffline?: boolean } = {}
): Promise<{ client: FleetClient; host: FleetHostView }> {
  const token = fleetApiToken();
  if (!token) throw new FleetNotConfiguredError();

  const host = await getFleetHost(name);
  if (!host) throw new HostUnknownError(name);
  if (!host.apiEndpoint) throw new HostNotDialableError(name);
  if (!host.online && !opts.allowOffline) throw new HostOfflineError(name, host.reportedAt);

  return {
    client: new FleetClient(host.apiEndpoint, token, {
      timeoutMs: opts.timeoutMs ?? ADMIN_READ_TIMEOUT_MS,
    }),
    host,
  };
}

export type Probe<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; code: AdminFleetLiveErrorCode };

/**
 * Run a read against one host without ever throwing.
 *
 * This is the whole degradation contract in one function. `FleetCapacityError`
 * is what an unreachable host produces (the client maps network failures onto
 * it), so it becomes `unreachable` rather than propagating.
 */
export async function probe<T>(
  name: string,
  fn: (client: FleetClient) => Promise<T>,
  opts: { timeoutMs?: number; allowOffline?: boolean } = {}
): Promise<Probe<T>> {
  try {
    const { client } = await fleetClientForHost(name, opts);
    return { ok: true, value: await fn(client) };
  } catch (err) {
    return { ok: false, ...describe(err) };
  }
}

function describe(err: unknown): { error: string; code: AdminFleetLiveErrorCode } {
  if (err instanceof HostOfflineError) return { error: err.message, code: ADMIN_HOST_OFFLINE };
  if (err instanceof HostNotDialableError) {
    return { error: err.message, code: ADMIN_HOST_NOT_DIALABLE };
  }
  if (err instanceof FleetNotConfiguredError) {
    return { error: err.message, code: ADMIN_FLEET_NOT_CONFIGURED };
  }
  return {
    error: err instanceof Error ? err.message : String(err),
    code: ADMIN_FLEET_UNREACHABLE,
  };
}

/**
 * Run a read across every ONLINE host concurrently.
 *
 * Bounded by the registry, which is a handful of boxes — a semaphore is
 * premature, but everything fans out through here so adding one later is a
 * one-line change rather than an audit of call sites.
 *
 * Reads only. Mutations are always addressed to one named host: a fan-out
 * mutation with one shared `reason` produces N audit rows from a single click
 * with no way to tell which host actually accepted it.
 */
export async function fanOutHosts<T>(
  fn: (client: FleetClient, host: FleetHostView) => Promise<T>,
  opts: { timeoutMs?: number } = {}
): Promise<Array<{ host: FleetHostView; result: Probe<T> }>> {
  const hosts = await listFleetHosts();
  const online = hosts.filter((h) => h.online && h.apiEndpoint);
  const settled = await Promise.all(
    online.map(async (host) => ({
      host,
      result: await probe(host.name, (client) => fn(client, host), opts),
    }))
  );
  return settled;
}

/**
 * Every sandbox that is live right now, with the host holding it.
 *
 * # Why this cannot just be a fan-out any more
 *
 * It used to be `fanOutHosts(c => c.listSandboxes())`, which asks each box for
 * its own records. That still works — for records this backend dispatched
 * DIRECTLY, holding FLEET_API_TOKEN. fleetd resolves that shared token to the
 * EMPTY tenant, deliberately: `Principal.Operator` answers "may I see the
 * host?" and never "may I see the customers?", so an operator credential reads
 * runs through exactly the same tenant-scoped accessor as anyone else.
 *
 * A sandbox dispatched through the gateway belongs to tenant `talyn`. So after
 * the cutover the fan-out returns rows for nothing, every gateway-dispatched
 * run reads as having no live data, and the console quietly falls back to the
 * task row's last-known status — which is the one shape an operator page must
 * not have, because it looks like a working page.
 *
 * So when a gateway is configured the live set comes from IT: its index names
 * the ids and their hosts, and each id is then read back for the record only
 * the host can produce (status, phase, slot, memory, cost). N+1, and it earns
 * it — the index lists LIVE rows only, which is a handful.
 *
 * The operator surface is untouched and stays a direct dial: capacity, stats,
 * metrics, goldens and drain are host questions the gateway does not serve, and
 * splitting them is deliberate rather than incidental.
 *
 * Never throws, like every other read here.
 */
export async function liveFleetSandboxes(): Promise<{
  live: LiveFleetSandbox[];
  degraded: Array<{ host: string; error: string }>;
}> {
  const gateway = fleetPinnedEndpoint();
  if (!gateway) {
    const settled = await fanOutHosts((client) => client.listSandboxes());
    const live: LiveFleetSandbox[] = [];
    const degraded: Array<{ host: string; error: string }> = [];
    for (const { host, result } of settled) {
      if (!result.ok) {
        degraded.push({ host: host.name, error: result.error });
        continue;
      }
      for (const sandbox of result.value.sandboxes ?? []) {
        live.push({ sandbox, host: host.name });
      }
    }
    return { live, degraded };
  }

  const token = fleetGatewayToken();
  if (!token) {
    return { live: [], degraded: [{ host: gateway, error: new FleetNotConfiguredError().message }] };
  }
  const client = new FleetClient(gateway, token, { timeoutMs: ADMIN_READ_TIMEOUT_MS });

  let refs;
  try {
    ({ sandboxes: refs } = await client.listGatewaySandboxes());
  } catch (err) {
    // One degraded entry keyed by the GATEWAY, not by a host. The console shows
    // it as a reachability problem with the thing that was actually unreachable,
    // rather than blaming every box in the registry for one control plane.
    return {
      live: [],
      degraded: [{ host: gateway, error: err instanceof Error ? err.message : String(err) }],
    };
  }

  const degraded: Array<{ host: string; error: string }> = [];
  const hydrated = await mapLimit(refs ?? [], HYDRATE_CONCURRENCY, async (ref) => {
      try {
        // The gateway's index names no host (a tenant has no use for one), so
        // the host comes from the `X-Fleet-Host` the gateway puts on every
        // sandbox answer. A sleeping box can wake on another host, so this is
        // fresher than the host Talyn recorded at create.
        const [{ sandbox }, host] = await Promise.all([
          client.getSandbox(ref.id),
          client.sandboxHost(ref.id).catch(() => undefined),
        ]);
        return { sandbox, host: host || ref.host || null };
      } catch (err) {
        // One id that could not be read is not a broken page. Reporting it
        // against its own host is what tells an operator WHICH box went quiet.
        degraded.push({
          host: ref.host || gateway,
          error: `${ref.id}: ${err instanceof Error ? err.message : String(err)}`,
        });
        return null;
      }
  });
  return { live: hydrated.filter((x): x is LiveFleetSandbox => x !== null), degraded };
}

/** One live sandbox and the host holding it. Null host: nothing named one. */
export interface LiveFleetSandbox {
  sandbox: FleetSandbox;
  host: string | null;
}

/**
 * Hydrating the gateway index is two reads per sandbox. Sessions sleep instead
 * of ending, so the index holds dozens of ids, and an unbounded fan-out would
 * open them all at once against one control plane.
 */
const HYDRATE_CONCURRENCY = 8;

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * A client that can read and act on ONE sandbox, and the host that holds it.
 *
 * Through the gateway when one is configured: a direct dial with
 * FLEET_API_TOKEN resolves to the EMPTY tenant (see liveFleetSandboxes), so it
 * cannot see a sandbox the gateway placed. Before this the run detail page and
 * Cancel dialled the host directly, which answered "no such sandbox" for every
 * gateway-placed run; Cancel then read that as "already gone" and reported a
 * success while the box kept running.
 */
export async function adminSandboxClient(
  host: string,
  opts: { timeoutMs?: number } = {},
): Promise<{ client: FleetClient; viaGateway: boolean }> {
  const gateway = fleetPinnedEndpoint();
  if (gateway) {
    const token = fleetGatewayToken();
    if (!token) throw new FleetNotConfiguredError();
    return {
      client: new FleetClient(gateway, token, { timeoutMs: opts.timeoutMs ?? ADMIN_READ_TIMEOUT_MS }),
      viaGateway: true,
    };
  }
  const { client } = await fleetClientForHost(host, opts);
  return { client, viaGateway: false };
}

/** One sandbox and the host holding it now. Throws like any client read. */
export async function readAdminSandbox(
  id: string,
  host: string,
): Promise<{ sandbox: FleetSandbox; terminal: boolean; host: string | null }> {
  const { client, viaGateway } = await adminSandboxClient(host);
  const [read, named] = await Promise.all([
    client.getSandbox(id),
    viaGateway ? client.sandboxHost(id).catch(() => undefined) : Promise.resolve(undefined),
  ]);
  return { sandbox: read.sandbox, terminal: read.terminal, host: named || (viaGateway ? null : host) };
}

/** The registry row, as the console's view type, with no live data attached. */
export function toAdminHost(host: FleetHostView): AdminFleetHost {
  return {
    name: host.name,
    apiEndpoint: host.apiEndpoint,
    version: host.version,
    reportedAt: host.reportedAt.toISOString(),
    draining: host.draining,
    runsLive: host.runsLive,
    runsMax: host.runsMax,
    memReservedMib: host.memReservedMib,
    memBudgetMib: host.memBudgetMib,
    diskFreeMib: host.diskFreeMib,
    maxIdleSeconds: host.maxIdleSeconds,
    online: host.online,
    dispatchable: host.dispatchable,
    live: null,
    liveError: null,
    liveErrorCode: null,
  };
}

/**
 * The host list, optionally enriched with a live capacity read.
 *
 * `live: false` answers from the registry alone and dials nothing — which is
 * what the console's first paint should use, because a page that waits on N
 * tailnet round trips before showing anything is unusable during the incident
 * it was opened for.
 *
 * With `live: true` this still returns 200 for every host. A box that cannot
 * be reached gets `live: null` plus a reason, never an exception.
 */
export async function listAdminFleetHosts(opts: { live?: boolean } = {}): Promise<AdminFleetHost[]> {
  const hosts = await listFleetHosts();
  if (!opts.live) return hosts.map(toAdminHost);

  return Promise.all(
    hosts.map(async (host) => {
      const base = toAdminHost(host);
      // Offline hosts are not dialled at all — probe() refuses them, and the
      // registry row already carries the last thing they said. Capacity and
      // stats together: capacity is what decides `accepting`, stats carries
      // the health the control plane raises its alerts from.
      const [result, stats] = await Promise.all([
        probe(host.name, (client) => client.capacity()),
        probe(host.name, (client) => client.stats()),
      ]);
      const health = stats.ok ? hostHealthFromStats(stats.value) : {};
      if (result.ok) return { ...base, live: result.value, ...health };
      return { ...base, liveError: result.error, liveErrorCode: result.code, ...health };
    })
  );
}

/**
 * The health, conditions and box counts in a `GET /v1/stats` answer.
 *
 * Read field by field and defensively: `health` and `conditions` are newer
 * than Talyn's FleetStats type, and a host on an older fleetd sends neither.
 * The conditions are the HOST'S OWN (yas `HostHealth.Conditions`), never a copy
 * computed here, so the console and the control plane cannot disagree about
 * what is wrong.
 */
export function hostHealthFromStats(stats: unknown): {
  health: AdminHostHealth | null;
  conditions: AdminHostCondition[] | null;
  boxes: AdminHostBoxCounts | null;
} {
  const raw = (stats ?? {}) as Record<string, unknown>;
  const h = raw.health as Record<string, unknown> | undefined;
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const bake = (h?.bake ?? {}) as Record<string, unknown>;
  const pressure = h?.diskPressure;
  const health: AdminHostHealth | null =
    h && typeof h === 'object'
      ? {
          diskFreeBytes: num(h.diskFreeBytes) ?? 0,
          diskPressure: pressure === 'ok' || pressure === 'low' || pressure === 'critical' ? pressure : null,
          diskCommittedMib: num(h.diskCommittedMib),
          diskReserveMib: num(h.diskReserveMib),
          diskHardFloorMib: num(h.diskHardFloorMib),
          diskTopWriters: Array.isArray(h.diskTopWriters)
            ? (h.diskTopWriters as Array<Record<string, unknown>>)
                .filter((w) => w && typeof w.id === 'string')
                .map((w) => ({
                  id: w.id as string,
                  writtenMib: num(w.writtenMib) ?? 0,
                  rateMibPerMin: num(w.rateMibPerMin) ?? 0,
                }))
            : [],
          hibernateUploadFailing: num(h.hibernateUploadFailing) ?? 0,
          bakeFailingRepos: num(bake.failingRepos) ?? 0,
          bakeMaxConsecutiveFailures: num(bake.maxConsecutiveFailures) ?? 0,
        }
      : null;
  const conditions = Array.isArray(raw.conditions)
    ? (raw.conditions as Array<Record<string, unknown>>)
        .filter((c) => c && typeof c.kind === 'string')
        .map((c) => ({
          kind: c.kind as string,
          severity: c.severity === 'critical' ? ('critical' as const) : ('warning' as const),
          detail: typeof c.detail === 'string' ? c.detail : '',
        }))
    : null;
  const by = raw.runsByStatus as Record<string, unknown> | undefined;
  const count = (k: string) => num(by?.[k]) ?? 0;
  const boxes: AdminHostBoxCounts | null =
    by && typeof by === 'object'
      ? {
          // `running` is the pre-merge name for `busy`; an older record reads back as it.
          running: count('starting') + count('idle') + count('busy') + count('running'),
          asleep: count('suspended'),
          queued: count('queued'),
        }
      : null;
  return { health, conditions, boxes };
}
