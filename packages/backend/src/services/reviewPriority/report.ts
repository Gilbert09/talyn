import type { ReviewRankingRecorder } from '@talyn/shared';

type Snapshot = Parameters<ConstructorParameters<typeof ReviewRankingRecorder>[0]>[1] & {
  snapshot_id: string; session_id: string; session_started_at: string; viewer_login: string;
  recorded_at: string; sort_mode: string; assigned_arm: 'control' | 'candidate' | null; filtered: boolean;
  candidate_count: number; chunk_count: number; chunk_index: number; candidates: Array<{
    pr_id: string; repo: string; pr_number: number; displayed_rank: number; gate: string;
    request_first_seen_at?: string | null;
    experiment?: { assigned: string; served: string; fallback: string | null; modelVersion: string; latencyMs: number } | null;
  }>;
};
export interface RankingReportEvent {
  workspaceId: string; userId: string; event: string; receivedAt: Date; payload: unknown;
}
export interface RankingReportOutcome {
  workspaceId: string; viewerLogin: string; reviewId: string; repo: string; prNumber: number;
  createdAt: Date | null; submittedAt: Date;
}
const DAY = 86_400_000;

/** Descriptive monitoring. Review submissions and PR opens are separate measurements. */
export function summarizeRankingExperiment(
  events: RankingReportEvent[], outcomes: RankingReportOutcome[], asOf: Date,
) {
  const groups = new Map<string, { event: RankingReportEvent; chunks: Snapshot[] }>();
  const audit = { incompleteSnapshots: 0, mixedAssignments: 0, unknownReviewStart: 0,
    missingCandidate: 0, noPrecedingSnapshot: 0, fallbackRows: 0, candidateRows: 0, maximumReportedUploadLoss: 0, conflictingChunks: 0, incompleteSessions: 0 };
  for (const event of events) {
    if (event.receivedAt > asOf || event.event !== 'pr_review_queue_snapshot') continue;
    const p = event.payload as Snapshot;
    const key = JSON.stringify([event.workspaceId, event.userId, p.snapshot_id]);
    const group = groups.get(key) ?? { event, chunks: [] };
    group.chunks.push(p);
    groups.set(key, group);
    audit.maximumReportedUploadLoss = Math.max(audit.maximumReportedUploadLoss, Number(p.upload_dropped_events) || 0);
  }
  const snapshots = [...groups.values()].flatMap(({ event, chunks }) => {
    const unique = new Map(chunks.map((p) => [p.chunk_index, p]));
    const p = chunks[0];
    const rows = [...unique.values()].sort((a, b) => a.chunk_index - b.chunk_index).flatMap((c) => c.candidates);
    const conflicting = chunks.some((c) => JSON.stringify(c) !== JSON.stringify(unique.get(c.chunk_index)));
    if (conflicting) audit.conflictingChunks++;
    if (conflicting || unique.size !== p.chunk_count || rows.length !== p.candidate_count ||
        new Set(rows.map((r) => r.pr_id)).size !== rows.length ||
        chunks.some((c) => c.session_id !== p.session_id || c.recorded_at !== p.recorded_at ||
          c.assigned_arm !== p.assigned_arm || c.candidate_count !== p.candidate_count ||
          c.chunk_count !== p.chunk_count || c.filtered !== p.filtered || c.sort_mode !== p.sort_mode ||
          c.viewer_login !== p.viewer_login || c.session_started_at !== p.session_started_at)) {
      audit.incompleteSnapshots++;
      return [];
    }
    for (const row of rows) {
      audit.candidateRows++;
      audit.fallbackRows += Number(!!row.experiment?.fallback);
    }
    return [{ ...event, ...p, candidates: rows, at: Date.parse(p.recorded_at) }];
  }).sort((a, b) => a.at - b.at);
  const sessions = new Map<string, {
    user: string; workspace: string; login: string; arm: string | null; start: number;
    mixed: boolean; complete: boolean; completed: Set<string>; openedSeconds: number | null;
  }>();
  for (const { event, chunks } of groups.values()) {
    const p = { ...event, ...chunks[0] };
    const complete = snapshots.some((s) => s.workspaceId === p.workspaceId && s.userId === p.userId && s.snapshot_id === p.snapshot_id);
    const key = JSON.stringify([p.workspaceId, p.userId, p.session_id]);
    const session = sessions.get(key) ?? {
      user: p.userId, workspace: p.workspaceId, login: p.viewer_login.toLowerCase(),
      arm: p.assigned_arm, start: Date.parse(p.session_started_at), mixed: false, complete: true,
      completed: new Set<string>(), openedSeconds: null,
    };
    session.complete &&= complete;
    session.mixed ||= session.arm !== p.assigned_arm || p.candidates.some((c) =>
      c.experiment && c.experiment.assigned !== session.arm);
    sessions.set(key, session);
  }
  for (const event of events) {
    if (event.receivedAt > asOf || event.event !== 'pr_review_candidate_opened') continue;
    const p = event.payload as { session_id: string; observed_at: string };
    const session = sessions.get(JSON.stringify([event.workspaceId, event.userId, p.session_id]));
    const seconds = session && (Date.parse(p.observed_at) - session.start) / 1000;
    if (session && seconds !== undefined && seconds >= 0) session.openedSeconds = Math.min(session.openedSeconds ?? Infinity, seconds);
  }
  const decisions = new Map<string, { user: string; arm: string; hit: number }>();
  const groupedOutcomes = new Map<string, RankingReportOutcome[]>();
  for (const outcome of outcomes) {
    const key = JSON.stringify([outcome.viewerLogin.toLowerCase(), outcome.reviewId]);
    const copies = groupedOutcomes.get(key) ?? [];
    copies.push(outcome);
    groupedOutcomes.set(key, copies);
  }
  const attemptedSnapshots = new Set<string>();
  for (const copies of groupedOutcomes.values()) {
    if (copies.some((o) => o.createdAt) || copies[0].submittedAt > asOf) continue;
    const at = copies[0].submittedAt.getTime();
    for (const p of snapshots.filter((snapshot) => copies.some((o) => o.workspaceId === snapshot.workspaceId) &&
      snapshot.viewer_login.toLowerCase() === copies[0].viewerLogin.toLowerCase() && snapshot.at < at && snapshot.at >= at - DAY)) {
      attemptedSnapshots.add(JSON.stringify([p.workspaceId, p.userId, p.snapshot_id]));
    }
  }
  const orderedOutcomes = [...groupedOutcomes.values()].sort((a, b) =>
    (a[0].createdAt ?? a[0].submittedAt).getTime() - (b[0].createdAt ?? b[0].submittedAt).getTime());
  for (const copies of orderedOutcomes) {
    const outcome = copies.find((o) => o.createdAt) ?? copies[0];
    if (outcome.submittedAt > asOf) continue;
    const at = outcome.createdAt?.getTime() ?? outcome.submittedAt.getTime();
    const eligible = [...sessions.values()].filter((s) => copies.some((o) => o.workspaceId === s.workspace) &&
      s.login === outcome.viewerLogin.toLowerCase() && s.start < at && outcome.submittedAt.getTime() < s.start + DAY)
      .sort((a, b) => b.start - a.start);
    const session = eligible[0];
    if (!session) continue;
    session.completed.add(outcome.reviewId);
    if (!outcome.createdAt) {
      audit.unknownReviewStart++;
      continue;
    }
    // Incomplete or filtered latest observations must not make an older queue eligible.
    const priorGroups = [...groups.values()].filter((g) => g.event.workspaceId === session.workspace &&
      g.event.userId === session.user && Date.parse(g.chunks[0].recorded_at) < at &&
      Date.parse(g.chunks[0].recorded_at) >= at - DAY)
      .sort((a, b) => Date.parse(b.chunks[0].recorded_at) - Date.parse(a.chunks[0].recorded_at));
    const latest = priorGroups[0]?.chunks[0];
    const snapshot = latest && snapshots.find((p) => p.workspaceId === session.workspace &&
      p.userId === session.user && p.snapshot_id === latest.snapshot_id);
    if (!snapshot || snapshot.filtered || !session.complete || session.mixed || !session.arm) { audit.noPrecedingSnapshot++; continue; }
    const key = JSON.stringify([snapshot.workspaceId, snapshot.userId, snapshot.snapshot_id]);
    if (attemptedSnapshots.has(key)) continue;
    attemptedSnapshots.add(key);
    const chosen = snapshot.candidates.find((c) => c.repo.toLowerCase() === outcome.repo.toLowerCase() && c.pr_number === outcome.prNumber);
    if (!chosen) { audit.missingCandidate++; continue; }
    if (session.start + DAY <= asOf.getTime() && !decisions.has(key) && snapshot.candidate_count > 3 && snapshot.sort_mode === 'priority') {
      decisions.set(key, { user: session.user, arm: session.arm, hit: Number(chosen.displayed_rank <= 3) });
    }
  }
  audit.incompleteSessions = [...sessions.values()].filter((s) => !s.complete).length;
  audit.mixedAssignments = [...sessions.values()].filter((s) => s.mixed).length;
  const mean = (values: number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
  const arms = Object.fromEntries(['control', 'candidate'].map((arm) => {
    const mature = [...sessions.values()].filter((s) => s.complete && !s.mixed && s.arm === arm && s.start + DAY <= asOf.getTime());
    const users = [...new Set(mature.map((s) => s.user))];
    const hits = [...decisions.values()].filter((d) => d.arm === arm);
    const hitUsers = [...new Set(hits.map((d) => d.user))];
    const queues = snapshots.filter((p) => p.assigned_arm === arm && !p.filtered && p.sort_mode === 'priority');
    const latency = queues.flatMap((p) => p.candidates[0]?.experiment ? [p.candidates[0].experiment.latencyMs] : []).sort((a, b) => a - b);
    return [arm, {
      inferenceP95Ms: latency.length ? latency[Math.ceil(latency.length * 0.95) - 1] : null,
      meanOverdueReadyCount: mean(queues.map((p) => p.candidates.filter((c) =>
        (c.gate === 'actionable' || c.gate === 'blocking_others') && c.request_first_seen_at &&
        p.at - Date.parse(c.request_first_seen_at) >= 7 * DAY).length)),
      meanBlockingCount: mean(queues.map((p) => p.candidates.filter((c) => c.gate === 'blocking_others').length)),
      reviewers: users.length, matureSessions: mature.length,
      sessionsWithoutReviews: mature.filter((s) => !s.completed.size).length,
      completedReviews: mature.reduce((sum, s) => sum + s.completed.size, 0),
      macroReviewsPerSession: mean(users.map((u) => mean(mature.filter((s) => s.user === u).map((s) => s.completed.size))!)),
      meanSecondsToOpen: mean(mature.flatMap((s) => s.openedSeconds === null ? [] : [s.openedSeconds])),
      informativeChoices: hits.length,
      macroHit3: mean(hitUsers.map((u) => mean(hits.filter((d) => d.user === u).map((d) => d.hit))!)),
    }];
  }));
  return { asOf: asOf.toISOString(), arms, audit, promotionProven: false,
    limits: ['Descriptive monitoring, not a significance or promotion test.',
      'A PR open measures navigation, not review start.',
      'Incomplete sessions are excluded. Overdue means a ready request observed at least seven days ago.',
      'Upload loss is a maximum reported counter, not a total across devices.',
      'Account submissions can include agent work. Useful review quality needs separate assessment.',
      'Webhook outcomes need an independent completeness audit before model training.'] };
}
