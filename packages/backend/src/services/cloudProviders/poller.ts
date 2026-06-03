import { eq } from 'drizzle-orm';
import { getDbClient } from '../../db/client.js';
import { tasks as tasksTable } from '../../db/schema.js';
import { readCloudTaskProvider } from '@fastowl/shared';
import { getCloudProvider } from './registry.js';
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
    try {
      const db = getDbClient();
      const rows = await db
        .select()
        .from(tasksTable)
        .where(eq(tasksTable.status, 'in_progress'));

      for (const row of rows) {
        const metadata = (row.metadata as Record<string, unknown> | null) ?? {};
        const providerType = readCloudTaskProvider({
          provider: (row as { provider?: string }).provider ?? undefined,
          metadata,
        });
        const provider = getCloudProvider(providerType);
        if (!provider) continue;

        const taskRow: CloudTaskRow = {
          id: row.id,
          workspaceId: row.workspaceId,
          title: row.title,
          repositoryId: row.repositoryId,
          metadata,
          transcriptEmpty:
            !Array.isArray(row.transcript) || row.transcript.length === 0,
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
      if (msg.includes('DATABASE_URL is not set')) return;
      console.error('[cloudPoller] tick error:', err);
    } finally {
      this.ticking = false;
    }
  }
}

export const cloudTaskPoller = new CloudTaskPoller();
