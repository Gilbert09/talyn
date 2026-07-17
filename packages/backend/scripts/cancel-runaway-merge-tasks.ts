/**
 * One-off ops script — cancel the runaway merge-queue fix tasks.
 *
 * Context: a merge-queue v2 bug re-fired "Get <ref> mergeable (merge queue)"
 * pr_response runs in a loop, dispatching thousands of live PostHog Code runs.
 * This scopes strictly to THOSE tasks (type=pr_response, that exact title
 * shape, still active) and cancels each the same way POST /tasks/:id/stop does:
 * best-effort remote cancel (stops the vendor run + its stray commits), stop
 * the transcript stream, then mark the row cancelled.
 *
 * Safety: DRY-RUN by default — prints what it would cancel. Set EXECUTE=1 to
 * actually cancel. Requires the backend's normal prod env (DATABASE_URL, etc.).
 *
 *   # inspect only:
 *   npx tsx scripts/cancel-runaway-merge-tasks.ts
 *   # actually cancel:
 *   EXECUTE=1 npx tsx scripts/cancel-runaway-merge-tasks.ts
 */
import { and, eq, inArray, like } from 'drizzle-orm';
import { getPoolDbClient } from '../src/db/client.js';
import { tasks as tasksTable } from '../src/db/schema.js';
import { rowToTask, taskColumnsNoTranscript } from '../src/services/taskSerialize.js';
import { getCloudProvider } from '../src/services/cloudProviders/registry.js';
import { clearWatched } from '../src/services/cloudProviders/taskWatch.js';
import { readCloudTaskProvider } from '@talyn/shared';

const ACTIVE = ['pending', 'queued', 'in_progress'];
const TITLE_LIKE = 'Get %mergeable (merge queue)';
const CONCURRENCY = 6;
const EXECUTE = process.env.EXECUTE === '1';

async function main(): Promise<void> {
  const db = getPoolDbClient();
  const rows = await db
    .select(taskColumnsNoTranscript)
    .from(tasksTable)
    .where(
      and(
        eq(tasksTable.type, 'pr_response'),
        like(tasksTable.title, TITLE_LIKE),
        inArray(tasksTable.status, ACTIVE)
      )
    );

  console.log(
    `[cancel-runaway] ${rows.length} active merge-queue fix task(s) matched` +
      (EXECUTE ? ' — CANCELLING' : ' — DRY RUN (set EXECUTE=1 to cancel)')
  );
  if (rows.length === 0) return;

  // Group by title for a quick per-PR tally so the operator can sanity-check.
  const byTitle = new Map<string, number>();
  for (const r of rows) byTitle.set(r.title, (byTitle.get(r.title) ?? 0) + 1);
  for (const [title, n] of [...byTitle.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`   ${String(n).padStart(4)}  ${title}`);
  }
  if (!EXECUTE) return;

  let cancelled = 0;
  let remoteFailed = 0;
  const queue = [...rows];
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    for (let row = queue.pop(); row; row = queue.pop()) {
      const task = rowToTask(row);
      const provider = getCloudProvider(readCloudTaskProvider(task));
      let remoteCancelError: string | undefined;
      if (provider?.cancel) {
        try {
          await provider.cancel(task);
        } catch (err) {
          remoteFailed++;
          remoteCancelError = err instanceof Error ? err.message : String(err);
        }
      }
      provider?.stopStreaming(task.id);
      clearWatched(task.id);
      const now = new Date();
      await db
        .update(tasksTable)
        .set({
          status: 'cancelled',
          result: {
            success: false,
            error: remoteCancelError
              ? `Cancelled (runaway merge-queue task). Remote run may still finish: ${remoteCancelError}`
              : 'Cancelled (runaway merge-queue task).',
          },
          completedAt: now,
          updatedAt: now,
        })
        .where(eq(tasksTable.id, task.id));
      cancelled++;
      if (cancelled % 100 === 0) console.log(`[cancel-runaway] ${cancelled}/${rows.length}…`);
    }
  });
  await Promise.all(workers);
  console.log(
    `[cancel-runaway] done — ${cancelled} cancelled, ${remoteFailed} remote-cancel failures ` +
      `(those rows are still marked cancelled; the vendor run may finish on its own).`
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[cancel-runaway] failed:', err);
    process.exit(1);
  });
