import { and, eq } from 'drizzle-orm';
import { parseNeedsHumanSentinel, type TaskResult, type TaskStatus } from '@talyn/shared';
import { getDbClient } from '../../db/client.js';
import {
  tasks as tasksTable,
  repositories as repositoriesTable,
} from '../../db/schema.js';
import { captureWorkspaceEvent } from '../analytics.js';
import { patchTaskMetadata } from '../taskMetadataMutex.js';
import { emitTaskStatus, emitTaskUpdate } from '../websocket.js';
import { linkTaskToPullRequest } from '../prCache.js';
import { clearWatched } from '../cloudProviders/taskWatch.js';
import { getPostHogCodeClient } from './credentials.js';
import { postHogCodeStreamer } from './streamer.js';
import type { PostHogCodeClient, PostHogRun, PostHogRunStatus } from './client.js';
import { extractContentText, type AcpLogEntry } from './acpConverter.js';
import type { CloudTaskRow } from '../cloudProviders/types.js';

const TERMINAL: ReadonlySet<PostHogRunStatus> = new Set([
  'completed',
  'failed',
  'cancelled',
]);

/**
 * A cloud run can finish its work yet sit in `in_progress` forever — the
 * PostHog API only flips to `completed` on certain finalisation paths, so a
 * background agent that reached end-of-turn just stays "running". We detect
 * that and auto-complete: the run's `updated_at` stops advancing once the
 * agent is idle (idle keepalive logs don't bump it), and we confirm the log
 * actually ended on a `turn_complete` so we never kill a long silent tool.
 */
const IDLE_FINALIZE_MS =
  Number(process.env.POSTHOG_CODE_IDLE_TIMEOUT_MS) || 10 * 60 * 1000;
/** Don't re-pull the log tail more often than this per task while stale. */
const IDLE_RECHECK_MS = 5 * 60 * 1000;
/** How far back from `updated_at` to read the log tail for confirmation. */
const IDLE_TAIL_WINDOW_MS = 5 * 60 * 1000;

/**
 * Reconciles FastOwl tasks that were delegated to PostHog Code. PostHog
 * owns the agent loop on its own sandbox; we poll each in-flight run and
 * drive the local task to `completed` or `failed`.
 *
 * Cloud tasks have no FastOwl agent — they're identified purely by a
 * `posthogRunId` on `task.metadata`. recoverStuckTasks() in taskQueue is
 * taught to leave them alone.
 */
class PostHogCodePoller {
  /** Per-task throttle for the idle-confirmation log fetch (taskId → ms). */
  private lastIdleCheck = new Map<string, number>();
  /** Per-task throttle for the resume re-check of an idle-finalized task. */
  private lastReviveCheck = new Map<string, number>();

  // NOTE: this poller no longer drives its own `setInterval` loop. The generic
  // cloud-task scheduler (`cloudProviders/poller.ts`) loads in-flight tasks and
  // calls `reconcileTask` via the provider wrapper. Keeping a second loop here
  // would re-introduce the `select()`-all transcript egress leak, so it's gone.

  /**
   * Reconcile one cloud task row — the entry point the generic cloud
   * poller (cloudProviders/poller.ts) calls via the provider wrapper.
   * Extracts the PostHog ids from metadata and delegates to the existing
   * per-task reconcile. No-op for a row that isn't a started PostHog run.
   */
  async reconcileTask(row: CloudTaskRow): Promise<void> {
    const posthogTaskId = row.metadata.posthogTaskId as string | undefined;
    const posthogRunId = row.metadata.posthogRunId as string | undefined;
    if (!posthogTaskId || !posthogRunId) return;
    await this.reconcile({
      id: row.id,
      workspaceId: row.workspaceId,
      title: row.title,
      repositoryId: row.repositoryId,
      posthogTaskId,
      lastStatus: row.metadata.posthogStatus as string | undefined,
      localStatus: row.status,
      completedAt: row.completedAt,
      transcriptEmpty: row.transcriptEmpty,
      watched: row.watched,
    });
  }

  private async reconcile(task: {
    id: string;
    workspaceId: string;
    title: string;
    repositoryId: string | null;
    posthogTaskId: string;
    lastStatus?: string;
    localStatus: TaskStatus;
    completedAt: Date | null;
    transcriptEmpty: boolean;
    watched: boolean;
  }): Promise<void> {
    const client = await getPostHogCodeClient(task.workspaceId);
    if (!client) return; // credentials removed mid-run; leave as-is.

    // Revival candidate: an idle run we optimistically completed (see
    // maybeFinalizeIdle) that may have resumed. Re-check is throttled so we
    // don't re-poll every idle-finalized task each 10s tick.
    const reviving =
      task.localStatus === 'completed' || task.localStatus === 'needs_human';
    if (reviving) {
      const lastCheck = this.lastReviveCheck.get(task.id) ?? 0;
      if (Date.now() - lastCheck < IDLE_RECHECK_MS) return;
      this.lastReviveCheck.set(task.id, Date.now());
    }

    const remote = await client.getTask(task.posthogTaskId);
    const run = remote.latest_run ?? null;
    const status = run?.status;
    if (!status) return;

    // Decide whether a completed task's remote run has resumed. If it hasn't,
    // this returns without touching the task (and stops tracking it once the
    // remote run is genuinely terminal). If it has, the task is flipped back to
    // `in_progress` and we fall through to normal reconcile below.
    if (reviving) {
      const revived = await this.maybeRevive(task, run, status);
      if (!revived) {
        // Not resuming — but a finished run with NO transcript is exactly what
        // the generic poller's backfill window re-selects this task for, and
        // returning here is what made that window pointless. PostHog flushes its
        // durable session log asynchronously, so the single attempt made at the
        // instant the run ended often found nothing; this is the retry.
        const terminalRunId = run?.id;
        if (terminalRunId && TERMINAL.has(status) && task.transcriptEmpty) {
          postHogCodeStreamer.ensure({
            taskId: task.id,
            workspaceId: task.workspaceId,
            posthogTaskId: task.posthogTaskId,
            posthogRunId: terminalRunId,
            backfillOnly: true,
          });
        }
        return;
      }
    }

    // The real run id lives on `latest_run.id`. Early FastOwl builds
    // mis-stored the task id here (the `run/` endpoint returns the task),
    // so trust the live value and self-heal the stored metadata below.
    const runId = run?.id;

    // Drive the log stream into the task transcript. `ensure` is
    // idempotent and self-heals across reconnects/backend restarts.
    // Live streaming is view-gated (taskWatch) — the SSE firehose plus
    // full-transcript persists are pure UI bytes, so nobody watching
    // means no stream.
    //   - terminal but no transcript yet (run finished unwatched, or
    //     while the backend was down): one-shot durable backfill from
    //     S3 — the stream self-terminates once drained.
    //   - running AND watched: keep a live SSE stream open.
    //   - otherwise (unwatched, or terminal with a transcript): tear
    //     down any lingering stream — `stop` persists what's buffered.
    const isTerminal = TERMINAL.has(status);
    if (runId && isTerminal && task.transcriptEmpty) {
      // `backfillOnly` is what makes this the "one-shot durable backfill" the
      // comment above describes. Without it, `ensure` opens the LIVE SSE stream
      // first — and for a finished run whose Redis stream has been trimmed that
      // endpoint answers 200 with nothing, so the tail loop reconnects four
      // times, finds nothing new, breaks, and never reads the S3 log at all. The
      // fallback only triggers on an explicit 404 / "Stream not available", which
      // a trimmed-but-alive stream doesn't produce. Result: a silently empty
      // transcript, which is what most completed tasks had.
      postHogCodeStreamer.ensure({
        taskId: task.id,
        workspaceId: task.workspaceId,
        posthogTaskId: task.posthogTaskId,
        posthogRunId: runId,
        backfillOnly: true,
      });
    } else if (runId && !isTerminal && task.watched) {
      postHogCodeStreamer.ensure({
        taskId: task.id,
        workspaceId: task.workspaceId,
        posthogTaskId: task.posthogTaskId,
        posthogRunId: runId,
      });
    } else if (postHogCodeStreamer.isActive(task.id)) {
      postHogCodeStreamer.stop(task.id);
    }

    const prUrl = findPullRequestUrl(run);

    // Keep metadata fresh (status + run id + PR url + log url) even while running.
    await patchTaskMetadata(task.id, (existing) => ({
      ...existing,
      posthogStatus: status,
      posthogRunId: runId ?? existing.posthogRunId,
      posthogLogUrl: run?.log_url ?? existing.posthogLogUrl,
      posthogPrUrl: prUrl ?? existing.posthogPrUrl,
    }));
    emitTaskUpdate(task.workspaceId, task.id, {
      metadata: { posthogStatus: status, posthogPrUrl: prUrl ?? undefined },
    });

    // A run that's done working but stuck in `in_progress` — auto-complete it.
    if (run && status === 'in_progress' && runId) {
      await this.maybeFinalizeIdle(task, client, run, runId, prUrl);
    }

    if (!TERMINAL.has(status)) return;

    // Did the agent stop for a person? Ask on EVERY terminal path, because
    // PostHog puts the agent's own closing words in different places
    // depending on how the run ended — `error_message` when it lands `failed`
    // (which is what the incident behind this actually did), `final_message`
    // when it lands `completed`. Only an exact sentinel counts, so an infra
    // failure can never be mistaken for a refusal.
    const needsHuman =
      parseNeedsHumanSentinel(run?.error_message) ??
      parseNeedsHumanSentinel(finalMessageOf(run));
    if (needsHuman) {
      // Still link the PR: the agent may well have pushed work before hitting
      // the wall, and the human it is handing to needs somewhere to go.
      if (prUrl && task.repositoryId) {
        await this.linkPr(task, run, prUrl);
      }
      await this.finalize(task, 'needs_human', {
        success: false,
        summary: needsHuman.reason,
        needsHuman,
        output: stringifyOutput(run?.output),
      });
      return;
    }

    if (status === 'completed') {
      if (prUrl && task.repositoryId) {
        await this.linkPr(task, run, prUrl);
      }
      // PostHog Code runs are reviewed in PostHog itself (the PR), so there's
      // nothing for FastOwl to approve — land straight in `completed`.
      const result: TaskResult = {
        success: true,
        summary: prUrl ? `PostHog Code opened ${prUrl}` : 'PostHog Code run completed',
        output: stringifyOutput(run?.output),
      };
      await this.finalize(task, 'completed', result);
    } else {
      // failed | cancelled
      const result: TaskResult = {
        success: false,
        error:
          (run?.error_message ?? undefined) ||
          `PostHog Code run ${status}`,
      };
      await this.finalize(task, 'failed', result);
    }
  }

  private async linkPr(
    task: { id: string; workspaceId: string; repositoryId: string | null },
    run: PostHogRun | null,
    prUrl: string,
  ): Promise<void> {
    const parsed = parsePrUrl(prUrl);
    if (!parsed || !task.repositoryId) return;
    const db = getDbClient();
    const repoRows = await db
      .select({ defaultBranch: repositoriesTable.defaultBranch })
      .from(repositoriesTable)
      .where(and(
        eq(repositoriesTable.id, task.repositoryId),
        eq(repositoriesTable.workspaceId, task.workspaceId),
      ))
      .limit(1);
    if (!repoRows[0]) return;
    const baseBranch = repoRows[0]?.defaultBranch || 'main';

    try {
      const rowId = await linkTaskToPullRequest({
        workspaceId: task.workspaceId,
        repositoryId: task.repositoryId,
        taskId: task.id,
        owner: parsed.owner,
        repo: parsed.repo,
        number: parsed.number,
        url: prUrl,
        title: '',
        author: '',
        headBranch: headBranchOf(run),
        baseBranch,
        headSha: '',
      });
      await patchTaskMetadata(task.id, (existing) => ({
        ...existing,
        pullRequest: {
          id: rowId,
          number: parsed.number,
          url: prUrl,
          createdAt: new Date().toISOString(),
        },
      }));
    } catch (err) {
      console.warn(
        `[posthogCode] failed to link PR for task ${task.id.slice(0, 8)}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  /**
   * Auto-complete a run that's done working but stuck in `in_progress`.
   * Gated on (a) the run's `updated_at` being stale past IDLE_FINALIZE_MS,
   * and (b) the session log having ended on a turn/task completion (not an
   * in-flight tool call) — so a long silent tool is never cut short. The
   * log-tail confirmation is throttled per task to avoid refetching every
   * tick while a run is stale-but-still-working.
   */
  private async maybeFinalizeIdle(
    task: { id: string; workspaceId: string; repositoryId: string | null; posthogTaskId: string },
    client: PostHogCodeClient,
    run: PostHogRun,
    runId: string,
    prUrl: string | null,
  ): Promise<void> {
    const updatedAtMs = run.updated_at ? Date.parse(run.updated_at) : NaN;
    if (Number.isNaN(updatedAtMs)) return;
    if (Date.now() - updatedAtMs < IDLE_FINALIZE_MS) {
      // Active recently — clear any throttle so a later idle spell re-checks.
      this.lastIdleCheck.delete(task.id);
      return;
    }

    const lastCheck = this.lastIdleCheck.get(task.id) ?? 0;
    if (Date.now() - lastCheck < IDLE_RECHECK_MS) return;
    this.lastIdleCheck.set(task.id, Date.now());

    let entries: AcpLogEntry[];
    try {
      const page = await client.getSessionLogs(task.posthogTaskId, runId, {
        after: new Date(updatedAtMs - IDLE_TAIL_WINDOW_MS).toISOString(),
        limit: 5000,
      });
      entries = page.entries;
    } catch {
      return; // can't confirm → leave it; we'll retry next window.
    }
    if (!lastFlowEventIsTurnComplete(entries)) return;

    // The agent may have ended this turn by handing back to a person. This
    // path is why the check matters: it is the one that writes `success: true`,
    // so a refusal reaching it is not merely mis-labelled, it is recorded as a
    // WIN. The closing text has to be reassembled from the log tail — an agent
    // message arrives as a run of chunks, and the sentinel line can be split
    // across them.
    const needsHuman = parseNeedsHumanSentinel(finalAgentMessageText(entries));

    const idleMin = Math.round((Date.now() - updatedAtMs) / 60_000);
    console.log(
      `[posthogCode] task ${task.id.slice(0, 8)}: run idle ${idleMin}m after turn_complete — ` +
        `auto-finalizing as ${needsHuman ? 'needs_human' : 'completed'}`,
    );
    postHogCodeStreamer.stop(task.id);
    if (prUrl && task.repositoryId) await this.linkPr(task, run, prUrl);
    await this.finalize(
      task,
      needsHuman ? 'needs_human' : 'completed',
      needsHuman
        ? {
            success: false,
            summary: needsHuman.reason,
            needsHuman,
            output: stringifyOutput(run.output),
          }
        : {
            success: true,
            summary: prUrl
              ? `PostHog Code went idle after opening ${prUrl}`
              : 'PostHog Code run went idle — auto-completed',
            output: stringifyOutput(run.output),
          },
    );
    // This completion is optimistic: the remote run is still `in_progress`, just
    // idle. Mark it revivable so the cloud poller keeps re-checking it — if the
    // run resumes (e.g. CI it was waiting on finished), maybeRevive flips the
    // task back to `in_progress`.
    await this.markReviveEligible(task.id);
  }

  /**
   * Re-check an idle-finalized (locally `completed`) task's remote run.
   * Returns true and flips the task back to `in_progress` when the run has
   * resumed — fresh activity (`updated_at`) past our finalize time. Returns
   * false (leaving the task completed) when the run is still idle, and clears
   * the revivable flag once the run reaches a genuinely terminal state so it
   * stops being a candidate.
   */
  private async maybeRevive(
    task: { id: string; workspaceId: string; completedAt: Date | null },
    run: PostHogRun | null,
    status: PostHogRunStatus,
  ): Promise<boolean> {
    if (TERMINAL.has(status)) {
      // Remote genuinely finished — our completion stands. Stop tracking it.
      await this.clearReviveEligible(task.id);
      this.lastReviveCheck.delete(task.id);
      return false;
    }
    // Non-terminal remote. Resumed iff there's activity since we finalized —
    // `updated_at` advancing past `completedAt`. Idle keepalives don't bump
    // `updated_at`, and finalize only fires after IDLE_FINALIZE_MS of staleness,
    // so a still-idle run never trips this (no revive/finalize ping-pong).
    const updatedAtMs = run?.updated_at ? Date.parse(run.updated_at) : NaN;
    const completedAtMs = task.completedAt ? task.completedAt.getTime() : 0;
    if (Number.isNaN(updatedAtMs) || updatedAtMs <= completedAtMs) return false;

    this.lastReviveCheck.delete(task.id);
    const now = new Date();
    await getDbClient()
      .update(tasksTable)
      .set({ status: 'in_progress', result: null, completedAt: null, updatedAt: now })
      .where(eq(tasksTable.id, task.id));
    await this.clearReviveEligible(task.id);
    emitTaskStatus(task.workspaceId, task.id, 'in_progress');
    console.log(
      `[posthogCode] task ${task.id.slice(0, 8)}: remote run resumed after idle-finalize — revived to in_progress`,
    );
    return true;
  }

  private async markReviveEligible(taskId: string): Promise<void> {
    await patchTaskMetadata(taskId, (existing) => ({ ...existing, reviveEligible: true }));
  }

  private async clearReviveEligible(taskId: string): Promise<void> {
    await patchTaskMetadata(taskId, (existing) =>
      existing.reviveEligible ? { ...existing, reviveEligible: false } : existing,
    );
  }

  private async finalize(
    task: { id: string; workspaceId: string },
    status: TaskStatus,
    result: TaskResult,
  ): Promise<void> {
    this.lastIdleCheck.delete(task.id);
    clearWatched(task.id);
    const now = new Date();
    await getDbClient()
      .update(tasksTable)
      .set({
        status,
        result,
        completedAt: status === 'completed' ? now : null,
        updatedAt: now,
      })
      .where(eq(tasksTable.id, task.id));
    emitTaskStatus(task.workspaceId, task.id, status, result);
    void this.captureOutcome(task, status, result, now);
  }

  /**
   * Server-side analytics for the terminal transition — the renderer can't
   * see runs that finish while the app is closed. One projected read (type,
   * createdAt, small cloud metadata — never the transcript) funds the
   * durations and PR linkage on the event. Best-effort.
   */
  private async captureOutcome(
    task: { id: string; workspaceId: string },
    status: TaskStatus,
    result: TaskResult,
    finishedAt: Date,
  ): Promise<void> {
    try {
      const rows = await getDbClient()
        .select({
          type: tasksTable.type,
          createdAt: tasksTable.createdAt,
          metadata: tasksTable.metadata,
        })
        .from(tasksTable)
        .where(eq(tasksTable.id, task.id))
        .limit(1);
      const row = rows[0];
      if (!row) return;
      const meta = (row.metadata ?? {}) as Record<string, unknown>;
      const dispatchedAtMs = Date.parse(String(meta.dispatchedAt ?? ''));
      captureWorkspaceEvent(
        task.workspaceId,
        // Three-way, not two. Folding a refusal into `task_failed` is what
        // made this class of stop invisible in the funnels: the rate of
        // `task_needs_human` is the signal that tells us whether the sentinel
        // prompt over-triggers, and there is nowhere else to read it.
        status === 'completed'
          ? 'task_completed'
          : status === 'needs_human'
            ? 'task_needs_human'
            : 'task_failed',
        {
          task_id: task.id,
          task_type: row.type,
          provider: 'posthog_code',
          opened_pr: Boolean(meta.pullRequest || meta.posthogPrUrl),
          duration_total_ms: finishedAt.getTime() - new Date(row.createdAt).getTime(),
          ...(Number.isNaN(dispatchedAtMs)
            ? {}
            : { duration_run_ms: finishedAt.getTime() - dispatchedAtMs }),
          ...(result.error ? { error_reason: result.error } : {}),
        },
      );
    } catch {
      // Analytics must never affect task processing.
    }
  }
}

/**
 * Walk a session-log tail backwards and decide whether the run is sitting
 * at end-of-turn (vs mid-work). Returns true if the most recent meaningful
 * event is a `turn_complete`/`task_complete`; false if it's an in-flight
 * tool call, agent message, or error (still working / not a clean end), or
 * if no end-of-turn marker is present. Idle keepalives (`console`,
 * `usage_update`, `progress`) are skipped. Pure — exported for tests.
 */
export function lastFlowEventIsTurnComplete(entries: AcpLogEntry[]): boolean {
  for (let i = entries.length - 1; i >= 0; i--) {
    const method = entries[i]?.notification?.method;
    if (method === '_posthog/turn_complete' || method === '_posthog/task_complete') {
      return true;
    }
    if (method === '_posthog/error') return false;
    if (method === 'session/update') {
      const su = (
        entries[i]?.notification?.params as
          | { update?: { sessionUpdate?: string } }
          | undefined
      )?.update?.sessionUpdate;
      if (
        su === 'tool_call' ||
        su === 'tool_call_update' ||
        su === 'agent_message' ||
        su === 'agent_message_chunk' ||
        su === 'agent_thought' ||
        su === 'agent_thought_chunk' ||
        su === 'user_message'
      ) {
        return false; // last real event was work, not a turn end
      }
    }
  }
  return false;
}

/**
 * The agent's closing message, reassembled from a session-log tail.
 *
 * Walks back to the `turn_complete`/`task_complete` marker and then collects
 * the contiguous run of agent-message events immediately before it, IN ORDER.
 * The reassembly is the whole job: PostHog streams an agent message as a run
 * of `agent_message_chunk`s, so the sentinel line is routinely split across
 * several entries and reading any one of them finds nothing.
 *
 * Stops at the first non-message event (a tool call, a user message) so this
 * only ever returns the final thing the agent SAID, not a transcript.
 * Pure — exported for tests.
 */
export function finalAgentMessageText(entries: AcpLogEntry[]): string | null {
  let i = entries.length - 1;
  for (; i >= 0; i--) {
    const method = entries[i]?.notification?.method;
    if (method === '_posthog/turn_complete' || method === '_posthog/task_complete') break;
  }
  if (i < 0) return null;

  const parts: string[] = [];
  for (let j = i - 1; j >= 0; j--) {
    const note = entries[j]?.notification;
    if (!note) continue;
    if (note.method !== 'session/update') {
      // Keepalives sit between chunks and must not end the run.
      if (
        note.method === '_posthog/console' ||
        note.method === '_posthog/sandbox_output'
      ) {
        continue;
      }
      break;
    }
    const update = (note.params as { update?: { sessionUpdate?: string; content?: unknown } })
      ?.update;
    const su = update?.sessionUpdate;
    if (su === 'agent_message' || su === 'agent_message_chunk') {
      parts.push(extractContentText(update?.content));
      continue;
    }
    break;
  }
  if (parts.length === 0) return null;
  return parts.reverse().join('');
}

const PR_URL_RE = /https?:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/;

/**
 * The PR this run opened, or null.
 *
 * Reads ONE structured field — `output.pr_url`, which PostHog's runner writes
 * when the run actually opens a pull request (`output.pr_urls` is the same
 * statement when there was more than one). Everything else in the run is
 * ignored, and that restraint is the entire point of this function.
 *
 * It used to `JSON.stringify` the whole run AND the remote task record and take
 * the first thing matching {@link PR_URL_RE}. Both halves of that were wrong:
 *
 *   - The task record carries `description`, which is the user's prompt. A loop
 *     whose prompt names a PR claimed authorship of it on every single firing.
 *   - The run carries `output.final_message`, the agent's closing prose, which
 *     cites pull requests it merely read. A loop that reviews PRs for a living
 *     writes one of those every time it runs.
 *
 * What that produced in practice: a "Daily PR" loop on PostHog/posthog filed
 * two of its runs against #99835 — a PR authored by the user, opened the day
 * before, off a branch no loop had ever touched, and already merged. The task's
 * own summary then read "PostHog Code opened <url>".
 *
 * `run.branch` is not a usable substitute either: a run that pushed nothing
 * reports `main`.
 *
 * The cost of this being strict is that a PR goes unlinked if PostHog ever
 * renames the field. That is the right way round — the link is a claim about
 * authorship, and a missing link is visibly nothing while a wrong one reads as
 * fact.
 */
export function findPullRequestUrl(run: PostHogRun | null): string | null {
  const output = run?.output;
  if (!output || typeof output !== 'object') return null;
  const record = output as Record<string, unknown>;

  const single = asPrUrl(record.pr_url);
  if (single) return single;
  if (Array.isArray(record.pr_urls)) {
    for (const candidate of record.pr_urls) {
      const url = asPrUrl(candidate);
      if (url) return url;
    }
  }
  return null;
}

/**
 * The agent's closing prose, if the runner recorded one.
 *
 * Note the company this keeps: the comment above is a write-up of what went
 * wrong the last time something in this file read `final_message`. That
 * incident was a REGEX SWEEP over prose looking for a URL the text merely
 * mentioned. This is the opposite: an exact, agreed prefix that the agent is
 * instructed to emit and nothing else produces (see
 * {@link parseNeedsHumanSentinel}, which only accepts it as the final line).
 * Reading the field is not the hazard — inferring from it is.
 */
function finalMessageOf(run: PostHogRun | null): string | null {
  const output = run?.output;
  if (!output || typeof output !== 'object') return null;
  const value = (output as Record<string, unknown>).final_message;
  return typeof value === 'string' ? value : null;
}

/** A value is a PR URL only if the whole of it is one. */
function asPrUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = value.trim().match(PR_URL_RE);
  return match && match[0] === value.trim() ? match[0] : null;
}

/** The branch the run pushed, preferring the runner's own record of it. */
function headBranchOf(run: PostHogRun | null): string {
  const output = run?.output;
  if (output && typeof output === 'object') {
    const head = (output as Record<string, unknown>).head_branch;
    if (typeof head === 'string' && head.trim()) return head.trim();
  }
  return run?.branch ?? '';
}

function parsePrUrl(
  url: string,
): { owner: string; repo: string; number: number } | null {
  const match = url.match(/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/);
  if (!match) return null;
  return { owner: match[1], repo: match[2], number: Number(match[3]) };
}

function stringifyOutput(output: unknown): string | undefined {
  if (output == null) return undefined;
  if (typeof output === 'string') return output;
  try {
    return JSON.stringify(output);
  } catch {
    return undefined;
  }
}

export const postHogCodePoller = new PostHogCodePoller();
