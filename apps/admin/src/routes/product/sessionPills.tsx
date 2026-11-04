import type { AdminSessionSummary } from '@talyn/shared';
import { Pill } from '../../components/layout/Page';

/** A session's own status, with "stuck" called out over a plain "provisioning". */
export function SessionStatusPill({
  session,
}: {
  session: Pick<AdminSessionSummary, 'status' | 'stuckProvisioning' | 'statusMessage'>;
}) {
  const title = session.statusMessage ?? undefined;
  if (session.stuckProvisioning) {
    return (
      <Pill tone="warn" title={title ?? 'Provisioning with no change for 20 minutes'}>
        stuck provisioning
      </Pill>
    );
  }
  switch (session.status) {
    case 'ready':
      return <Pill tone="good">ready</Pill>;
    case 'provisioning':
      return (
        <Pill tone="info" title={title}>
          provisioning
        </Pill>
      );
    case 'moving':
      return (
        <Pill tone="info" title={title ?? 'Moving to a fresh sandbox'}>
          moving
        </Pill>
      );
    case 'error':
      return (
        <Pill tone="critical" title={title}>
          error
        </Pill>
      );
    case 'archiveError':
      return (
        <Pill tone="critical" title={title}>
          archive failed
        </Pill>
      );
    case 'archived':
      return <Pill tone="muted">archived</Pill>;
    default:
      return <Pill tone="muted">{session.status}</Pill>;
  }
}

/** The fleet's view of the session's box, as Talyn last recorded it. */
export function SandboxStatePill({ state, runtime }: { state: string; runtime: string }) {
  if (runtime === 'local') return <Pill tone="muted">local worktree</Pill>;
  switch (state) {
    case 'running':
      return <Pill tone="info">running</Pill>;
    case 'suspended':
      return (
        <Pill tone="muted" title="Asleep, which is normal between turns">
          asleep
        </Pill>
      );
    case 'creating':
      return <Pill tone="info">creating</Pill>;
    case 'lost':
      return (
        <Pill tone="critical" title="The fleet no longer has the box">
          lost
        </Pill>
      );
    case 'error':
      return <Pill tone="critical">error</Pill>;
    case 'deleted':
    case 'none':
      return <Pill tone="muted">{state === 'none' ? 'no box' : 'deleted'}</Pill>;
    default:
      return <Pill tone="muted">{state}</Pill>;
  }
}
