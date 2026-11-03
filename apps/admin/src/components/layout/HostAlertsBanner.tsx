import { Link } from 'react-router-dom';
import { AlertTriangle } from 'lucide-react';
import type { AdminHostAlert } from '@talyn/shared';
import { api } from '../../lib/api';
import { useAdminQuery } from '../../hooks/useAdminQuery';
import { ROUTES, routeTo } from '../../lib/routes';
import { cn } from '../../lib/utils';

/**
 * Host alerts, on every page of the console.
 *
 * The conditions each host reports (`disk_low`, `hibernate_upload_failing`,
 * `bake_failing`) and hosts that stopped reporting. On 2026-11-03 the fleet
 * store on hetzner-64 filled twice in one afternoon and the only signal was a
 * log line nobody read; a banner here is on the screen an operator already has
 * open.
 *
 * A failed read shows nothing rather than an error strip: this banner is extra
 * information on top of a page, and the Hosts page says when a host cannot be
 * reached.
 */
const POLL_MS = 30_000;

export const ALERT_LABEL: Record<string, string> = {
  disk_low: 'Disk low',
  hibernate_upload_failing: 'Hibernation uploads failing',
  bake_failing: 'Bakes failing',
  host_offline: 'Host not reporting',
};

export function HostAlertsBanner() {
  const { data } = useAdminQuery(() => api.admin.fleet.alerts(), { intervalMs: POLL_MS });
  const alerts = data?.alerts ?? [];
  if (alerts.length === 0) return null;
  const critical = alerts.some((a) => a.severity === 'critical');

  return (
    <div
      role="alert"
      className={cn(
        'border-b px-4 py-2 text-xs',
        critical
          ? 'border-destructive/40 bg-destructive/10 text-destructive'
          : 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300'
      )}
    >
      <ul className="space-y-1">
        {alerts.map((alert) => (
          <AlertLine key={`${alert.host}:${alert.kind}`} alert={alert} />
        ))}
      </ul>
    </div>
  );
}

function AlertLine({ alert }: { alert: AdminHostAlert }) {
  return (
    <li className="flex items-start gap-2">
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0">
        <Link to={routeTo(ROUTES.fleetHost, { host: alert.host })} className="font-medium underline">
          {alert.host}
        </Link>
        : {ALERT_LABEL[alert.kind] ?? alert.kind}
        {alert.severity === 'critical' ? ' (critical)' : ''}
        {alert.detail && <span className="opacity-80">. {alert.detail}</span>}
      </span>
    </li>
  );
}
