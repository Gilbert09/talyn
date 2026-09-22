import { z } from 'zod';
import { replayPRPriorityTrace, type PRPriorityTrace } from '@talyn/shared';

const number = z.number().finite();
const text = z.string().max(256);
const time = z.string().datetime({ offset: true });
const optionalTime = time.nullish();
const checks = z.object({
  total: number.optional(), passed: number.optional(), failed: number.optional(),
  inProgress: number.optional(), skipped: number.optional(),
});
const previous = z.object({ state: text, submittedAt: time.nullish() });
const trace = z.object({
  schemaVersion: z.literal(1), scorerVersion: text, source: z.enum(['server', 'client']),
  modelVersion: text.nullable(), scoredAt: number, taskActive: z.boolean(),
  pooledScore: number.optional(),
  rankInputs: z.object({
    features: z.array(number.nullable()).max(64), weights: z.array(number).max(64),
    stats: z.object({ mean: z.array(number).max(64), sd: z.array(number).max(64) }).nullable(),
  }).nullable(),
  target: z.object({
    id: text, createdAt: optionalTime, reviewRequestedFirstSeenAt: optionalTime,
    taskId: text.nullish(), mergeQueued: z.boolean().optional(),
    summary: z.object({
      state: text.optional(), draft: z.boolean().optional(), createdAt: optionalTime,
      mergeable: text.optional(), blockingReason: text.optional(),
      reviewDecision: text.nullish(), effectiveReviewDecision: text.nullish(),
      checks: checks.optional(), unresolvedHumanReviewThreads: number.optional(),
      unresolvedBotReviewThreads: number.optional(), unresolvedThreadsOpenedByViewer: number.optional(),
      additions: number.optional(), deletions: number.optional(),
      viewerLatestReview: previous.nullish(),
      reviewRequestVia: z.object({ direct: z.boolean(), teams: z.array(text).max(100) }).nullish(),
      autoMergeBy: text.nullish(), prAuthorIsBot: z.boolean().optional(),
      stack: z.object({
        parentPrId: text.nullish(), childPrIds: z.array(text).max(2500).optional(),
        rootPrId: text.optional(), depth: number.optional(), size: number.optional(), position: number.optional(),
      }).nullish(),
    }),
  }),
});
const experiment = z.object({
  experiment: text, assigned: z.enum(['control', 'candidate']), served: z.enum(['control', 'candidate']),
  modelVersion: text, baselineScore: number, candidateScore: number.nullable(),
  features: z.array(number).length(8).nullable(), fallback: text.nullable(), latencyMs: number,
});
const candidate = z.object({
  pr_id: text, repo: text, pr_number: number.int().positive(), head_sha: text.nullable(),
  displayed_rank: number.int().positive(), created_at: optionalTime,
  request_first_seen_at: optionalTime, summary_updated_at: optionalTime,
  affinity_features: z.array(number.nullable()).max(64).nullable(), affinity_features_source: text,
  direct_request: z.boolean().nullable(), requested_team_count: number.nullable(),
  requested_teams: z.array(text).max(100).nullable(), bot_author: z.boolean().nullable(),
  draft: z.boolean().nullable(), additions: number.nullable(), deletions: number.nullable(),
  checks: checks.nullable(), mergeable: text.nullable(), review_decision: text.nullable(),
  previous_review: previous.nullable(), human_threads: number.nullable(),
  bot_threads: number.nullable(), viewer_threads: number.nullable(),
  gate: z.enum(['blocking_others', 'actionable', 'waiting_on_author', 'not_ready']).nullable(),
  score: number.nullable(), priority_trace: trace.nullable(), experiment: experiment.nullish(),
});

const common = {
  upload_dropped_events: number.int().nonnegative().optional(),
  schema_version: z.literal(1), workspace_id: text, snapshot_id: z.string().uuid(),
  session_id: z.string().uuid(), session_started_at: time,
};
const snapshot = z.object({
  ...common, viewer_login: text, recorded_at: time,
  assigned_arm: z.enum(['control', 'candidate']).nullable(),
  sort_mode: z.enum(['newest', 'oldest', 'priority']), filtered: z.boolean(),
  repository_scope: z.array(text).max(500), candidate_count: number.int().min(0).max(2500),
  chunk_index: number.int().min(0).max(99), chunk_count: number.int().min(1).max(100),
  affinity_feature_names: z.array(text).max(64),
  candidates: z.array(candidate).max(25), model_source: text,
}).superRefine((value, ctx) => {
  if (value.chunk_count !== Math.max(1, Math.ceil(value.candidate_count / 25)) ||
      value.chunk_index >= value.chunk_count ||
      value.candidates.length !== Math.min(25, value.candidate_count - value.chunk_index * 25) ||
      value.candidates.some((c, i) => c.displayed_rank !== value.chunk_index * 25 + i + 1)) {
    ctx.addIssue({ code: 'custom', message: 'Invalid snapshot chunks' });
  }
  for (const c of value.candidates) {
    if (!value.repository_scope.some((repo) => repo.toLowerCase() === c.repo.toLowerCase())) {
      ctx.addIssue({ code: 'custom', message: 'Candidate outside repository scope' });
    }
    if (c.priority_trace) {
      try {
        const result = replayPRPriorityTrace(c.priority_trace as PRPriorityTrace);
        if (c.priority_trace.target.id !== c.pr_id || result.score !== c.score || result.gate !== c.gate) throw new Error();
      } catch {
        ctx.addIssue({ code: 'custom', message: 'Invalid priority replay' });
      }
    }
  }
});
export const rankingEventSchema = z.discriminatedUnion('event', [
  z.object({ id: z.string().uuid(), event: z.literal('pr_review_queue_snapshot'), properties: snapshot }),
  z.object({ id: z.string().uuid(), event: z.literal('pr_review_rows_visible'), properties: z.object({
    ...common, observed_at: time, pr_ids: z.array(text).max(2500),
  }) }),
  z.object({ id: z.string().uuid(), event: z.literal('pr_review_candidate_opened'), properties: z.object({
    ...common, observed_at: time, pr_id: text, rank: number.int().positive(),
  }) }),
]);
export const rankingBatchSchema = z.object({
  enabled: z.boolean(), resume: z.boolean().optional(), events: z.array(rankingEventSchema).max(20),
});
