import { eq, sql } from 'drizzle-orm';
import { getDbClient } from '../../db/client.js';
import { tasks as tasksTable } from '../../db/schema.js';
import { readCloudTaskProvider } from '@fastowl/shared';
import { getCloudProvider } from './registry.js';
import { debugBus } from '../debugBus.js';
import type { CloudTaskRow } from './types.js';

const POLL_INTERVAL_MS = 10_000;

/**
 * Drives every in-progress cloud task to a terminal state. Each tick it
 * loads `in_progress` tasks, resolves the owning provider from the task's
 * metadata, and hands the row to `provider.reconcile`. Provider-specific
 * status mapping / transcript streaming / PR linking all live inside the
 * provider; this loop is just the scheduler. One provider today (PostHog
 * Code); Codex/Claude slot in with no change here.
 */
class CloudTaskPoller {
  private interval: NodeJS.Timeout | null = null;
  private ticking = false;

  init(): void {
    if (this.interval) return;
    debugBus.registerPoller(
      'cloud_task',
      POLL_INTERVAL_MS,
      'Drives every in-progress cloud task (e.g. PostHog Code) to a terminal state — loads in-progress tasks and asks the owning provider to reconcile status, transcript, and PR linkage.',
    );
    this.interval = setInterval(() => {
      void this.tick();
    }, POLL_INTERVAL_MS);
  }

  shutdown(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    const startedAt = Date.now();
    let reconciled = 0;
    let tickError: string | undefined;
    let skipRecord = false;
    try {
      const db = getDbClient();
      // Only the columns the scheduler needs. Crucially we compute the
      // transcript's emptiness in Postgres rather than selecting the
      // `transcript` jsonb — that blob is the cloud-run conversation log
      // (often MBs) and pulling it every 10s for every in-flight task was the
      // dominant source of database egress. The CASE mirrors the old JS check
      // `!Array.isArray(t) || t.length === 0`: only an array runs through
      // `jsonb_array_length` (so it never throws on a non-array), and null /
      // non-array values fall to the `ELSE true` (empty) branch.
      const rows = await db
        .select({
          id: tasksTable.id,
          workspaceId: tasksTable.workspaceId,
          title: tasksTable.title,
          repositoryId: tasksTable.repositoryId,
          metadata: tasksTable.metadata,
          transcriptEmpty: sql<boolean>`CASE WHEN jsonb_typeof(${tasksTable.transcript}) = 'array' THEN jsonb_array_length(${tasksTable.transcript}) = 0 ELSE true END`,
        })
        .from(tasksTable)
        .where(eq(tasksTable.status, 'in_progress'));
      reconciled = rows.length;

      for (const row of rows) {
        const metadata = (row.metadata as Record<string, unknown> | null) ?? {};
        const providerType = readCloudTaskProvider({ metadata });
        const provider = getCloudProvider(providerType);
        if (!provider) continue;

        const taskRow: CloudTaskRow = {
          id: row.id,
          workspaceId: row.workspaceId,
          title: row.title,
          repositoryId: row.repositoryId,
          metadata,
          transcriptEmpty: row.transcriptEmpty,
        };

        try {
          await provider.reconcile(taskRow);
        } catch (err) {
          // Transient API hiccups are fine — retry next tick. A single
          // failed poll must never fail the task.
          console.warn(
            `[cloudPoller] reconcile failed for task ${row.id.slice(0, 8)}:`,
            err instanceof Error ? err.message : err,
          );
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('DATABASE_URL is not set')) {
        skipRecord = true;
        return;
      }
      tickError = msg;
      console.error('[cloudPoller] tick error:', err);
    } finally {
      this.ticking = false;
      if (!skipRecord) {
        debugBus.pollerTick('cloud_task', {
          durationMs: Date.now() - startedAt,
          ok: !tickError,
          summary: tickError
            ? `cloud_task tick failed: ${tickError}`
            : `cloud_task tick — ${reconciled} in-flight`,
          error: tickError,
        });
      }
    }
  }
}

export const cloudTaskPoller = new CloudTaskPoller();
