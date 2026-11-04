import { type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { AdminSessionDetail } from '@talyn/shared';
import { api } from '../../lib/api';
import { useAdminQuery } from '../../hooks/useAdminQuery';
import { Page, Pill } from '../../components/layout/Page';
import { CopyableId } from '../../components/ui/CopyableId';
import { absolute, bytes, duration, mib, relativeAge, shortSha, usd } from '../../lib/format';
import { boxSizeLabel, isAsleep, looksWedged, runClaim, sleepSeconds } from '../../lib/fleetView';
import { ROUTES, routeTo } from '../../lib/routes';
import { SandboxStatePill, SessionStatusPill } from './sessionPills';

/**
 * One session or thread, read-only.
 *
 * What an operator needs to answer "why is this session stuck": its status and
 * the fleet's live view of its box, the chats and whether a turn is running,
 * the recent turn times, what kind of events the agent emitted, the setup
 * timing and learned steps for its repository, and the last checkpoint of
 * unsaved work.
 *
 * The transcript CONTENT is deliberately absent. The events table shows only
 * the type words (`assistant`, `result/success`), which say what the agent was
 * doing without showing another tenant's conversation.
 */
const POLL_MS = 10_000;

export function SessionDetailPage() {
  const { sessionId = '' } = useParams();
  const { data, error, loading, initialLoading, refresh } = useAdminQuery(
    () => api.admin.sessions.get(sessionId),
    { intervalMs: POLL_MS, deps: [sessionId], enabled: Boolean(sessionId) }
  );

  if (!data) {
    return (
      <Page title="Session" backTo={ROUTES.sessions} backLabel="Sessions" onRefresh={refresh}>
        {initialLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {error ?? 'Session not found.'}
          </div>
        )}
      </Page>
    );
  }

  const box = data.sandbox;
  const host = box?.host ?? data.fleetHost;

  return (
    <Page
      title={data.title}
      subtitle={
        <span className="flex flex-wrap items-center gap-3 text-xs">
          <CopyableId value={data.id} />
          {data.kind === 'thread' && <Pill tone="muted">thread</Pill>}
          <SessionStatusPill session={data} />
          {data.ownerEmail && <span>{data.ownerEmail}</span>}
          <span title={absolute(data.createdAt)}>created {relativeAge(data.createdAt)} ago</span>
          <span title={absolute(data.lastActivityAt)}>active {relativeAge(data.lastActivityAt)} ago</span>
        </span>
      }
      backTo={ROUTES.sessions}
      backLabel="Sessions"
      onRefresh={refresh}
      refreshing={loading}
    >
      {data.statusMessage && (
        <div
          className={
            data.status === 'error' || data.status === 'archiveError'
              ? 'mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive'
              : 'mb-4 rounded-md border border-border bg-card px-3 py-2 text-sm'
          }
        >
          {data.statusMessage}
        </div>
      )}

      <dl className="grid grid-cols-1 gap-2 rounded-lg border border-border bg-card p-3 text-sm sm:grid-cols-4">
        <Field
          label="Workspace"
          value={
            <Link to={routeTo(ROUTES.workspace, { workspaceId: data.workspaceId })} className="hover:underline">
              {data.workspaceName ?? data.workspaceId}
            </Link>
          }
        />
        <Field label="Repository" value={data.repoFullName || '—'} />
        <Field label="Branch" value={data.branch ? `${data.branch} ← ${data.baseBranch}` : '—'} />
        <Field label="Agent" value={`${data.agent}${data.model ? ` · ${data.model}` : ''}`} />
        <Field label="Runtime" value={data.runtime} />
        <Field label="Internet access" value={data.internetAccess ? 'on' : 'off'} />
        <Field
          label="Pull request"
          value={
            data.pullRequest ? (
              <a href={data.pullRequest.url} target="_blank" rel="noreferrer" className="hover:underline">
                {data.pullRequest.owner}/{data.pullRequest.repo}#{data.pullRequest.number} ({data.pullRequest.state})
              </a>
            ) : (
              '—'
            )
          }
        />
        <Field
          label="Started from"
          value={
            data.source === 'slack' ? (
              data.slackPermalink ? (
                <a href={data.slackPermalink} target="_blank" rel="noreferrer" className="hover:underline">
                  Slack
                </a>
              ) : (
                'Slack'
              )
            ) : (
              'the app'
            )
          }
        />
        {data.threadId && (
          <Field
            label="Thread"
            value={
              <Link to={routeTo(ROUTES.session, { sessionId: data.threadId })} className="hover:underline">
                open the thread
              </Link>
            }
          />
        )}
        <Field
          label="Last checkpoint"
          value={
            data.workCheckpoint ? (
              <span title={absolute(data.workCheckpoint.at)}>
                {shortSha(data.workCheckpoint.sha)}
                {data.workCheckpoint.at && ` · ${relativeAge(data.workCheckpoint.at)} ago`}
                {data.workCheckpoint.bytes != null && ` · ${bytes(data.workCheckpoint.bytes)}`}
              </span>
            ) : (
              'none'
            )
          }
        />
        {data.archivedAt && <Field label="Archived" value={`${relativeAge(data.archivedAt)} ago`} />}
        {data.archiveFailures > 0 && <Field label="Archive failures" value={String(data.archiveFailures)} />}
      </dl>

      <Section title="Sandbox">
        <dl className="grid grid-cols-1 gap-2 rounded-lg border border-border bg-card p-3 text-sm sm:grid-cols-4">
          <Field label="Recorded state" value={<SandboxStatePill state={data.sandboxState} runtime={data.runtime} />} />
          <Field
            label="Host"
            value={
              host ? (
                <Link to={routeTo(ROUTES.fleetHost, { host })} className="hover:underline">
                  {host}
                </Link>
              ) : (
                '—'
              )
            }
          />
          <Field label="Sandbox id" value={data.sandboxId ? <CopyableId value={data.sandboxId} /> : '—'} />
          <Field
            label="Size"
            value={
              (box && boxSizeLabel(box)) ??
              (data.sandboxSize ? `${data.sandboxSize} (chosen)` : 'the repository default')
            }
          />
          {box && (
            <>
              <Field label="Fleet state" value={<LiveBoxState box={box} />} />
              <Field
                label="Memory"
                value={
                  box.memUsedMib != null
                    ? `${mib(box.memUsedMib)} of ${mib(box.memMib)}`
                    : box.memMib != null
                      ? `${mib(box.memMib)} ceiling`
                      : '—'
                }
              />
              <Field label="Disk" value={box.diskMib ? mib(box.diskMib) : '—'} />
              <Field label="Cost" value={usd(box.costUsd)} />
              {runClaim(box) !== 'active' && (
                <Field label="Claim" value={box.supersededReason ?? runClaim(box)} />
              )}
            </>
          )}
          {data.fleetSandboxId && data.fleetSandboxId !== data.sandboxId && (
            <Field label="Fleet sandbox id" value={<CopyableId value={data.fleetSandboxId} />} />
          )}
          {data.moveSandboxId && <Field label="Moving to" value={<CopyableId value={data.moveSandboxId} />} />}
          {data.keptSandboxIds.length > 0 && (
            <Field label="Kept boxes" value={data.keptSandboxIds.join(', ')} />
          )}
          {data.memoryRestorePending && <Field label="Memory restore" value={data.memoryRestorePending} />}
        </dl>
        {data.sandboxError && (
          <p className="mt-2 text-xs text-muted-foreground">
            Couldn&apos;t read the box from the fleet: {data.sandboxError}
          </p>
        )}
        {box && (
          <p className="mt-2 text-xs">
            <Link
              to={`${routeTo(ROUTES.fleetRun, { runId: box.runId })}${box.host ? `?host=${encodeURIComponent(box.host)}` : ''}`}
              className="underline"
            >
              Open the box on the Runs page
            </Link>
          </p>
        )}
      </Section>

      <Section title={`Chats (${data.chats.length})`}>
        <SimpleTable
          empty="No chats"
          head={['Chat', 'Status', 'Turns', 'Queued', 'Turn started', 'Updated']}
          rows={data.chats.map((c) => [
            <span key="t" className={c.closedAt ? 'text-muted-foreground' : undefined}>
              {c.title}
              <span className="ml-1 text-xs text-muted-foreground">
                {c.agent}
                {c.model ? ` · ${c.model}` : ''}
                {c.closedAt ? ' · closed' : ''}
              </span>
            </span>,
            <Pill
              key="s"
              tone={c.status === 'running' ? 'info' : c.status === 'error' ? 'critical' : 'muted'}
              title={c.statusMessage ?? undefined}
            >
              {c.status.replace('_', ' ')}
            </Pill>,
            String(c.turnCount),
            c.queuedCount ? String(c.queuedCount) : '—',
            c.turnStartedAt ? `${relativeAge(c.turnStartedAt)} ago` : '—',
            `${relativeAge(c.updatedAt)} ago`,
          ])}
        />
      </Section>

      <Section title="Recent turns">
        <SimpleTable
          empty="No turn has finished yet"
          head={['Turn', 'Took', 'Model', 'Tools', 'Calls', 'Ended']}
          rows={data.turns.map((t) => [
            `${t.turn}${data.chats.length > 1 ? ` (${chatTitle(data, t.chatId)})` : ''}`,
            duration(Math.round(t.wallMs / 1000)),
            duration(Math.round(t.modelMs / 1000)),
            duration(Math.round(t.toolMs / 1000)),
            String(t.calls),
            `${relativeAge(t.at)} ago`,
          ])}
        />
      </Section>

      <Section title="Recent events">
        <SimpleTable
          empty="No events"
          head={['Seq', 'Turn', 'Event', 'Chat', 'At']}
          rows={data.events.map((e) => [
            String(e.seq),
            String(e.turn),
            <span key="e" className="font-mono text-xs">
              {e.type ?? '?'}
              {e.subtype ? `/${e.subtype}` : ''}
            </span>,
            chatTitle(data, e.chatId),
            <span key="a" title={absolute(e.at)}>
              {relativeAge(e.at)} ago
            </span>,
          ])}
        />
      </Section>

      {data.setup && (
        <Section title="Setup">
          <p className="mb-2 text-sm">
            {data.setup.timing ? (
              <>
                The newest box setup took {duration(Math.round(data.setup.timing.totalMs / 1000))}
                {data.setup.timing.repositoryMs != null &&
                  `: repository setup ${duration(Math.round(data.setup.timing.repositoryMs / 1000))}`}
                , learned steps {duration(Math.round(data.setup.timing.learnedMs / 1000))}.{' '}
                <span className="text-muted-foreground">
                  {data.setup.timing.thisSession ? 'This session’s box.' : 'Another session’s box.'}{' '}
                  {data.setup.timing.measuredAt && `Measured ${relativeAge(data.setup.timing.measuredAt)} ago.`}
                </span>
              </>
            ) : (
              <span className="text-muted-foreground">No box setup has been timed for this repository.</span>
            )}
          </p>
          <SimpleTable
            empty="No learned steps"
            head={['Step', 'State', 'Sessions', 'Typical', 'Box failures']}
            rows={data.setup.steps.map((s) => [
              <span key="c" className="font-mono text-xs" title={s.command}>
                {s.command}
              </span>,
              s.boxDisabled ? (
                <Pill key="p" tone="critical" title={s.boxLastFailure ?? undefined}>
                  off after failures
                </Pill>
              ) : s.disabled ? (
                <Pill key="p" tone="muted">
                  off
                </Pill>
              ) : s.live ? (
                <Pill key="p" tone="good">
                  live
                </Pill>
              ) : (
                <Pill key="p" tone="muted">
                  waiting
                </Pill>
              ),
              String(s.sessionCount),
              s.typicalDurationMs != null ? duration(Math.round(s.typicalDurationMs / 1000)) : '—',
              s.boxFailureCount ? (
                <span key="f" title={s.boxLastFailure ?? undefined}>
                  {s.boxFailureCount}
                </span>
              ) : (
                '—'
              ),
            ])}
          />
        </Section>
      )}
    </Page>
  );
}

function chatTitle(data: AdminSessionDetail, chatId: string): string {
  return data.chats.find((c) => c.id === chatId)?.title ?? chatId;
}

function LiveBoxState({ box }: { box: NonNullable<AdminSessionDetail['sandbox']> }) {
  if (isAsleep(box)) {
    const slept = sleepSeconds(box);
    return (
      <Pill tone="muted" title={box.sleep?.uploadError ? `Upload failed: ${box.sleep.uploadError}` : undefined}>
        asleep · {box.sleep?.kind === 'storage' ? 'in storage' : 'local'}
        {slept != null && ` · ${duration(slept)}`}
      </Pill>
    );
  }
  if (looksWedged(box)) return <Pill tone="critical">wedged?</Pill>;
  return <Pill tone="info">{box.sandboxStatus ?? box.status ?? 'unknown'}</Pill>;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-5">
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h2>
      {children}
    </section>
  );
}

function SimpleTable({ head, rows, empty }: { head: string[]; rows: ReactNode[][]; empty: string }) {
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">{empty}</p>;
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full text-sm">
        <thead className="bg-muted/40 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
          <tr>
            {head.map((h) => (
              <th key={h} className="px-3 py-1.5 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((cells, i) => (
            <tr key={i} className="border-t border-border">
              {cells.map((cell, j) => (
                <td key={j} className="max-w-[28rem] truncate px-3 py-1.5">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Field({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 truncate text-sm">{value}</dd>
    </div>
  );
}
