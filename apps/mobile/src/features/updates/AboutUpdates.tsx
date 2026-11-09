import { AppText, Row } from '../../components/UI';
import { longTime } from '../../lib/time';
import type { AppInfo } from '../settings/about';
import { appUpdates, useAppUpdates } from './appUpdates';
import type { UpdateController } from './controller';
import { updateStatusLabel } from './model';

function Value({ children }: { children: string }) {
  return <AppText variant="meta" tone="muted" selectable>{children}</AppText>;
}

/** The update rows in Settings → About: what runs now, and a check the person starts. */
export function AboutUpdates({ info, controller = appUpdates() }: { info: AppInfo; controller?: UpdateController }) {
  const updates = useAppUpdates(controller);
  const busy = updates.phase === 'checking' || updates.phase === 'downloading';
  const status = <AppText variant="meta" tone={updates.phase === 'failed' ? 'warning' : 'muted'}>{updateStatusLabel(updates)}</AppText>;
  const running = info.update ? [info.update, longTime(info.createdAt)].filter(Boolean).join(' · ') : 'Built-in version';
  return <>
    {info.channel ? <Row title="Update channel" trailing={<Value>{info.channel}</Value>} /> : null}
    {info.runtime ? <Row title="Runtime version" trailing={<Value>{info.runtime.slice(0, 12)}</Value>}
      accessibilityLabel={`Runtime version ${info.runtime}`} /> : null}
    {updates.phase === 'off' ? null : <Row title="Running update" trailing={<Value>{running}</Value>} />}
    {updates.phase === 'ready'
      ? <Row title="Restart to update" subtitle={status} onPress={() => { void updates.restart(); }} />
      : <Row title="Check for updates" subtitle={status} disabled={updates.phase === 'off' || busy}
        accessibilityLabel={`Check for updates. ${updateStatusLabel(updates)}.`} onPress={() => { void updates.check('manual'); }} />}
  </>;
}
