/**
 * Memory review: a thread that Talyn starts on a schedule to clean up the
 * workspace memory (`workbenchMemory.ts`). It merges entries that say the same
 * thing, settles entries that disagree, and forgets entries that a newer entry
 * replaced. Every change shows as a `talyn_memory` card in the thread, and a
 * person can restore a forgotten entry in the app.
 *
 * Off by default: each review boots a sandbox and spends the workspace's own
 * agent subscription. `settings.memoryReview` sets the cadence; the
 * `memoryReview` feature flag gates the whole feature.
 */

/** How often Talyn reviews the workspace memory. */
export type MemoryReviewCadence = 'off' | 'daily' | 'weekly' | 'monthly';
export const MEMORY_REVIEW_CADENCES: readonly MemoryReviewCadence[] = ['off', 'daily', 'weekly', 'monthly'];

export const MEMORY_REVIEW_CADENCE_LABELS: Record<MemoryReviewCadence, string> = {
  off: 'Off',
  daily: 'Daily',
  weekly: 'Weekly',
  monthly: 'Monthly',
};

export function isMemoryReviewCadence(value: unknown): value is MemoryReviewCadence {
  return MEMORY_REVIEW_CADENCES.includes(value as MemoryReviewCadence);
}

/** The cadence a workspace's settings ask for. Unset or unknown: off. */
export function memoryReviewCadenceOf(settings: { memoryReview?: unknown } | null | undefined): MemoryReviewCadence {
  const value = settings?.memoryReview;
  return isMemoryReviewCadence(value) ? value : 'off';
}

/** A review needs at least two live entries: one entry cannot overlap another. */
export const MIN_ENTRIES_FOR_MEMORY_REVIEW = 2;

/**
 * The start of the period that `now` is in, in UTC: the day, the ISO week
 * (Monday) or the month. A scheduled review runs at most once per period, and
 * this instant is its key, so two replicas that sweep at the same time compute
 * the same key. Null for `off`.
 */
export function memoryReviewPeriodStart(cadence: MemoryReviewCadence, now: Date): Date | null {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();
  switch (cadence) {
    case 'daily':
      return new Date(Date.UTC(y, m, d));
    case 'weekly': {
      // getUTCDay: Sunday is 0. Days since Monday: (day + 6) % 7.
      const sinceMonday = (now.getUTCDay() + 6) % 7;
      return new Date(Date.UTC(y, m, d - sinceMonday));
    }
    case 'monthly':
      return new Date(Date.UTC(y, m, 1));
    default:
      return null;
  }
}

/** The start of the period after the one that `now` is in. Null for `off`. */
export function nextMemoryReviewPeriodStart(cadence: MemoryReviewCadence, now: Date): Date | null {
  const start = memoryReviewPeriodStart(cadence, now);
  if (!start) return null;
  const y = start.getUTCFullYear();
  const m = start.getUTCMonth();
  const d = start.getUTCDate();
  if (cadence === 'daily') return new Date(Date.UTC(y, m, d + 1));
  if (cadence === 'weekly') return new Date(Date.UTC(y, m, d + 7));
  return new Date(Date.UTC(y, m + 1, 1));
}

/** The session source of a memory review thread. */
export interface MemoryReviewSessionSource {
  kind: 'memory_review';
  runId: string;
}

/** What started a review: the schedule, or a person with "Review now". */
export type MemoryReviewTrigger = 'schedule' | 'manual';

/**
 * `starting`: the period is claimed and the thread is being created.
 * `started`: Talyn created the thread. `failed`: it could not, and `error` says why.
 */
export type MemoryReviewStatus = 'starting' | 'started' | 'failed';

/** One review, as `GET /workbenches/memory/reviews` returns it. */
export interface MemoryReviewRun {
  id: string;
  workspaceId: string;
  trigger: MemoryReviewTrigger;
  status: MemoryReviewStatus;
  /** The review thread. Null when the review failed before it started one. */
  workbenchId: string | null;
  error: string | null;
  createdAt: string;
}

/** `GET /workbenches/memory/reviews`. */
export interface MemoryReviewState {
  cadence: MemoryReviewCadence;
  /** The most recent reviews, newest first. */
  runs: MemoryReviewRun[];
}

/** The name the review thread gets. */
export const MEMORY_REVIEW_THREAD_NAME = 'Memory review';

/** The first message of a review thread. */
export function memoryReviewPrompt(): string {
  return [
    'You are the memory review for this Talyn workspace. Clean up the workspace memory.',
    'You can see every memory entry in the workspace: workspace, repository and thread entries.',
    '',
    '## Steps',
    '1. List all entries with `talyn_memory_list`. Read the body of each entry with `talyn_memory_read`.',
    '2. Find these problems:',
    '   - Overlap: two or more entries that record the same fact, or one entry that repeats part of another.',
    '   - Contradiction: two entries that say different things about the same subject.',
    '   - Replaced: an entry that a newer entry corrects or makes out of date.',
    '3. Fix each problem:',
    '   - Overlap in the same scope: write one merged entry with `talyn_memory_write`.',
    '     Keep the best name, the type, and every useful detail. Then forget the other entries with `talyn_memory_forget`.',
    '   - Overlap across scopes: keep the entry in the narrowest scope where the fact applies.',
    '     When a repository or thread entry only repeats a workspace entry, forget the narrower one.',
    '   - Contradiction: the entry with the newer `updated` time usually wins.',
    '     Write the current fact into the winning entry, then forget the other entry.',
    '     When the evidence is not clear, change nothing and report the conflict.',
    '   - Replaced: forget the old entry.',
    '',
    '## Rules',
    '- Change only entries that have a problem. Do not rewrite an entry only to change its style.',
    '- Do not add facts that are not in the entries. You cannot check the repositories from here.',
    '- Keep the scope of an entry. To write a repository entry, send `scope: "repository"` and its `repository_id`.',
    '  To write a thread entry, send `scope: "thread"` and its `thread_id`. Otherwise send `scope: "workspace"`.',
    '- Keep the limits: name 64 characters, description 200 characters, body 8 KB.',
    '- Use the entry id, not the name, when you read or forget an entry.',
    '- Do not save notes about this review. Do not start sessions or tasks.',
    '',
    '## Report',
    'At the end, reply with a short report. List each change: merged, updated or forgotten, with the entry names and the reason.',
    'Then list each conflict that a person must decide. If you found no problems, say so in one sentence.',
  ].join('\n');
}
