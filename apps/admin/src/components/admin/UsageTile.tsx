import { formatBoxHours, formatUsd } from '@talyn/shared';
import { api } from '../../lib/api';
import { useAdminQuery } from '../../hooks/useAdminQuery';
import { StatCard } from '../ui/StatCard';

/** Box-hours and credits across every account, from one aggregate query. */
export function UsageTile() {
  const { data, error } = useAdminQuery(() => api.admin.usageSummary(), { intervalMs: 60_000 });
  if (!data) {
    return error ? (
      <p className="mb-3 text-xs text-destructive">Usage summary unavailable: {error}</p>
    ) : null;
  }
  return (
    <div aria-label="Usage this period" className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
      <StatCard
        label="Box-hours, current periods"
        value={formatBoxHours(data.periodBoxWsec)}
        hint={`${data.ownersWithUsage} owner${data.ownersWithUsage === 1 ? '' : 's'} with usage`}
      />
      <StatCard
        label="Owners exhausted"
        value={`${data.ownersExhausted}`}
        tone={data.ownersExhausted > 0 ? 'warn' : 'default'}
      />
      <StatCard label="Credits sold this month" value={formatUsd(data.creditsSoldMicros)} />
      <StatCard label="Credits granted this month" value={formatUsd(data.creditsGrantedMicros)} />
    </div>
  );
}
