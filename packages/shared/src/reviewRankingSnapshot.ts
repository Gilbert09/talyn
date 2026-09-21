import { reviewRankFeatures, REVIEW_RANK_FEATURES, type ReviewRankProfile } from './reviewRank.js';
import type { PRPriorityTarget, PRPriorityVerdict } from './prPriority.js';

export const REVIEW_RANKING_SNAPSHOT_VERSION = 1;
export const REVIEW_RANKING_CHUNK_SIZE = 25;

export interface ReviewRankingRow extends PRPriorityTarget {
  workspaceId: string;
  number: number;
  priority?: PRPriorityVerdict | null;
  summary: PRPriorityTarget['summary'] & { headSha?: string; updatedAt?: string };
}

export interface ReviewRankingContext {
  workspaceId: string;
  viewerLogin: string;
  sortMode: 'newest' | 'oldest' | 'priority';
  /** Used for local change detection. Never sent to analytics. */
  filterKey: string;
  filtered: boolean;
  profile: ReviewRankProfile | null;
  priorityById?: Map<string, PRPriorityVerdict> | null;
  repositoryScope?: string[];
}

export function reviewRankingCandidate(
  row: ReviewRankingRow,
  rank: number,
  context: ReviewRankingContext,
) {
  const s = row.summary;
  const teams = s.reviewRequestVia
    ? [...new Set(s.reviewRequestVia.teams.map((team) => team.toLowerCase()))].sort()
    : null;
  const verdict = context.priorityById?.get(row.id) ?? row.priority;
  const features = verdict?.trace
    ? verdict.trace.rankInputs?.features ?? null
    : context.profile
    ? reviewRankFeatures({
        author: s.author,
        repoFullName: `${row.owner}/${row.repo}`,
        dirs: s.topDirs,
        teams: s.reviewRequestVia?.teams,
        additions: s.additions,
        deletions: s.deletions,
      }, context.profile).map((value) => Number.isFinite(value) ? value : null)
    : null;
  return {
    pr_id: row.id,
    repo: `${row.owner}/${row.repo}`,
    pr_number: row.number,
    head_sha: s.headSha ?? null,
    displayed_rank: rank,
    created_at: s.createdAt ?? row.createdAt ?? null,
    request_first_seen_at: row.reviewRequestedFirstSeenAt ?? null,
    summary_updated_at: s.updatedAt ?? null,
    affinity_features: features,
    affinity_features_source: verdict?.trace?.source ?? 'client_profile',
    direct_request: s.reviewRequestVia?.direct ?? null,
    requested_team_count: teams?.length ?? null,
    requested_teams: teams,
    bot_author: s.prAuthorIsBot ?? null,
    draft: s.draft ?? null,
    additions: s.additions ?? null,
    deletions: s.deletions ?? null,
    checks: s.checks ? { ...s.checks } : null,
    mergeable: s.mergeable ?? null,
    review_decision: s.effectiveReviewDecision ?? s.reviewDecision ?? null,
    previous_review: s.viewerLatestReview ? { ...s.viewerLatestReview } : null,
    human_threads: s.unresolvedHumanReviewThreads ?? null,
    bot_threads: s.unresolvedBotReviewThreads ?? null,
    viewer_threads: s.unresolvedThreadsOpenedByViewer ?? null,
    gate: verdict?.gate ?? null,
    score: verdict?.score ?? null,
    priority_trace: verdict?.trace ?? null,
  };
}

type Capture = (event: string, properties: Record<string, unknown>) => void;

/** Record full queues. A queue entry alone is not evidence of exposure. */
export class ReviewRankingRecorder {
  private fingerprint: string | null = null;
  private snapshotId: string | null = null;
  private workspaceId: string | null = null;
  private recordedAt = 0;
  private ranks = new Map<string, number>();
  private visible = new Set<string>();

  constructor(
    private capture: Capture,
    private makeId: () => string,
  ) {}

  record(rows: ReviewRankingRow[], context: ReviewRankingContext, now: number): string {
    if (rows.some((row) => row.workspaceId !== context.workspaceId)) {
      throw new Error('The queue belongs to another workspace');
    }
    const candidates = rows.map((row, index) => reviewRankingCandidate(row, index + 1, context));
    const scope = context.repositoryScope
      ? [...new Set(context.repositoryScope.map((repo) => repo.toLowerCase()))].sort()
      : null;
    const model = context.profile?.model;
    const clientModel = model ? {
      installed: model.installed,
      events: model.nEvents,
      weights: model.weights,
      feature_stats: context.profile?.featureStats,
    } : null;
    const fingerprint = JSON.stringify([
      context.workspaceId, context.viewerLogin, context.sortMode, context.filterKey,
      candidates.map((candidate) => ({
        ...candidate,
        priority_trace: candidate.priority_trace
          ? { ...candidate.priority_trace, scoredAt: 0 }
          : null,
      })), clientModel, scope,
    ]);
    if (fingerprint === this.fingerprint && now - this.recordedAt < 300_000 && this.snapshotId) {
      return this.snapshotId;
    }
    this.fingerprint = fingerprint;
    this.recordedAt = now;
    this.snapshotId = this.makeId();
    this.workspaceId = context.workspaceId;
    this.ranks = new Map(candidates.map((candidate) => [candidate.pr_id, candidate.displayed_rank]));
    this.visible.clear();
    const chunkCount = Math.max(1, Math.ceil(candidates.length / REVIEW_RANKING_CHUNK_SIZE));
    for (let chunk = 0; chunk < chunkCount; chunk++) {
      this.capture('pr_review_queue_snapshot', {
        schema_version: REVIEW_RANKING_SNAPSHOT_VERSION,
        snapshot_id: this.snapshotId,
        workspace_id: context.workspaceId,
        viewer_login: context.viewerLogin,
        recorded_at: new Date(now).toISOString(),
        sort_mode: context.sortMode,
        filtered: context.filtered,
        repository_scope: scope,
        candidate_count: candidates.length,
        chunk_index: chunk,
        chunk_count: chunkCount,
        affinity_feature_names: [...REVIEW_RANK_FEATURES],
        client_model: clientModel,
        model_source: candidates.length > 0 && candidates.every((candidate) => candidate.priority_trace)
          ? 'scoring_trace' : 'client_profile',
        candidates: candidates.slice(
          chunk * REVIEW_RANKING_CHUNK_SIZE,
          (chunk + 1) * REVIEW_RANKING_CHUNK_SIZE,
        ),
      });
    }
    return this.snapshotId;
  }

  observe(ids: string[], now: number): void {
    const fresh = [...new Set(ids)].filter((id) => this.ranks.has(id) && !this.visible.has(id));
    if (!this.snapshotId || fresh.length === 0) return;
    for (const id of fresh) this.visible.add(id);
    this.capture('pr_review_rows_visible', {
      schema_version: REVIEW_RANKING_SNAPSHOT_VERSION,
      snapshot_id: this.snapshotId,
      workspace_id: this.workspaceId,
      observed_at: new Date(now).toISOString(),
      pr_ids: fresh,
    });
  }

  open(id: string, now: number): void {
    if (!this.snapshotId || !this.ranks.has(id)) return;
    this.capture('pr_review_candidate_opened', {
      schema_version: REVIEW_RANKING_SNAPSHOT_VERSION,
      snapshot_id: this.snapshotId,
      workspace_id: this.workspaceId,
      observed_at: new Date(now).toISOString(),
      pr_id: id,
      rank: this.ranks.get(id),
    });
  }
}
