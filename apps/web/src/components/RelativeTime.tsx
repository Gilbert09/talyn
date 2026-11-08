import { fullTimeLabel, relativeTimeLabel, useRelativeNow } from '../lib/relativeTime';

/** "5 minutes ago", kept current, with the full date and time on hover. */
export function RelativeTime({ iso, prefix, className }: { iso: string; prefix?: string; className?: string }) {
  const now = useRelativeNow();
  const label = relativeTimeLabel(iso, now);
  if (!label) return null;
  return (
    <time dateTime={iso} title={fullTimeLabel(iso)} className={className}>
      {prefix ? `${prefix} ${label}` : label}
    </time>
  );
}
