import type { AdminFleetAlerts, AdminHostAlert } from '@talyn/shared';
import { listFleetHosts, type FleetHostView } from '../fleetHosts.js';
import { hostHealthFromStats, probe } from './fleetProxy.js';

/**
 * The host alerts the console shows as a banner on every page.
 *
 * The conditions are the ones each host reports on `GET /v1/stats` — the same
 * ones the YAS control plane raises its alerts from (`disk_low`,
 * `hibernate_upload_failing`, `bake_failing`). The control plane has no API for
 * its raised alerts (they live in its memory and its logs), so the console asks
 * the hosts, and so it shows a condition as soon as a host reports it rather
 * than after the control plane's sustain time.
 *
 * A host that stopped reporting is an alert too, but only for a day: a host
 * retired from the fleet stays in the registry, and a banner that can never
 * clear is a banner nobody reads.
 */

/** Every console page polls this, so the answer is shared for this long. */
export const ALERTS_CACHE_MS = 15_000;

/** An offline host older than this is a retired host, not an alert. */
export const OFFLINE_ALERT_WINDOW_MS = 24 * 60 * 60_000;

let cached: { at: number; value: AdminFleetAlerts } | null = null;
let inFlight: Promise<AdminFleetAlerts> | null = null;

/** For tests. */
export function resetHostAlertsCache(): void {
  cached = null;
  inFlight = null;
}

export async function listHostAlerts(
  now: number = Date.now(),
  read: (host: FleetHostView) => Promise<unknown | null> = readStats,
): Promise<AdminFleetAlerts> {
  if (cached && now - cached.at < ALERTS_CACHE_MS) return cached.value;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const value = await computeHostAlerts(now, read);
      cached = { at: now, value };
      return value;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

async function readStats(host: FleetHostView): Promise<unknown | null> {
  const result = await probe(host.name, (client) => client.stats());
  return result.ok ? result.value : null;
}

export async function computeHostAlerts(
  now: number,
  read: (host: FleetHostView) => Promise<unknown | null>,
): Promise<AdminFleetAlerts> {
  const hosts = await listFleetHosts(now);
  const alerts: AdminHostAlert[] = [];
  await Promise.all(
    hosts.map(async (host) => {
      if (!host.online) {
        if (now - host.reportedAt.getTime() < OFFLINE_ALERT_WINDOW_MS) {
          alerts.push({
            host: host.name,
            kind: 'host_offline',
            severity: 'critical',
            detail: `No report since ${host.reportedAt.toISOString()}.`,
          });
        }
        return;
      }
      const stats = await read(host);
      if (!stats) return;
      for (const c of hostHealthFromStats(stats).conditions ?? []) {
        alerts.push({ host: host.name, kind: c.kind, severity: c.severity, detail: c.detail });
      }
    }),
  );
  const rank = (a: AdminHostAlert) => (a.severity === 'critical' ? 0 : 1);
  alerts.sort((a, b) => rank(a) - rank(b) || a.host.localeCompare(b.host) || a.kind.localeCompare(b.kind));
  return { alerts, checkedAt: new Date(now).toISOString() };
}
