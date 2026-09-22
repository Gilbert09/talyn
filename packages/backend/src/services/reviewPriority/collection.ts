import { and, asc, eq, inArray, isNull, lt, or } from 'drizzle-orm';
import { z } from 'zod';
import { getPoolDbClient, type Database } from '../../db/client.js';
import { reviewRankingEvents, reviewRankingOutcomes, reviewRankingParticipants } from '../../db/schema.js';
import { githubService } from '../github.js';
import { rankingBatchSchema } from './captureSchema.js';

export async function disableRankingCollection(db: Database, userId: string): Promise<void> {
  await db.update(reviewRankingParticipants).set({ enabled: false, updatedAt: new Date() })
    .where(eq(reviewRankingParticipants.userId, userId));
}

export async function storeRankingEvents(
  db: Database, workspaceId: string, userId: string, viewerLogin: string,
  batch: z.infer<typeof rankingBatchSchema>, now = new Date(),
): Promise<void> {
  const events = batch.enabled ? batch.events : [];
  for (const item of events) {
    const p = item.properties;
    const at = Date.parse('recorded_at' in p ? p.recorded_at : p.observed_at);
    if (p.workspace_id !== workspaceId || at > now.getTime() + 60_000 ||
        at < now.getTime() - 7 * 86_400_000 || Date.parse(p.session_started_at) > at ||
        ('viewer_login' in p && p.viewer_login.toLowerCase() !== viewerLogin.toLowerCase())) {
      throw new Error('Invalid ranking identity or time');
    }
  }
  await db.transaction(async (tx) => {
    await tx.insert(reviewRankingParticipants).values({
      workspaceId, userId, viewerLogin: viewerLogin.toLowerCase(), enabled: batch.enabled, updatedAt: now,
    }).onConflictDoUpdate({
      target: [reviewRankingParticipants.workspaceId, reviewRankingParticipants.userId],
      set: { viewerLogin: viewerLogin.toLowerCase(), enabled: batch.enabled, updatedAt: now },
    });
    if (events.length) await tx.insert(reviewRankingEvents).values(events.map((item) => ({
      workspaceId, userId, eventId: item.id, event: item.event,
      snapshotId: item.properties.snapshot_id, sessionId: item.properties.session_id,
      recordedAt: new Date('recorded_at' in item.properties ? item.properties.recorded_at : item.properties.observed_at),
      payload: item.properties,
    }))).onConflictDoNothing();
  });
}

const outcomeSchema = z.object({
  review: z.object({
    node_id: z.string().max(256), state: z.enum(['commented', 'approved', 'changes_requested']),
    submitted_at: z.string().datetime({ offset: true }),
    user: z.object({ login: z.string().max(256), type: z.literal('User') }),
  }),
  pull_request: z.object({ number: z.number().int().positive() }),
});

/** Read submissions from every authorized repository delivery, including untracked PRs. */
export async function recordRankingOutcome(
  workspaceIds: string[], repo: string, payload: unknown,
): Promise<void> {
  const parsed = outcomeSchema.safeParse(payload);
  if (!parsed.success || !workspaceIds.length) return;
  const { review, pull_request: pr } = parsed.data;
  const login = review.user.login.toLowerCase();
  const db = getPoolDbClient();
  const participants = await db.select({ workspaceId: reviewRankingParticipants.workspaceId })
    .from(reviewRankingParticipants).where(and(
      inArray(reviewRankingParticipants.workspaceId, workspaceIds),
      eq(reviewRankingParticipants.viewerLogin, login), eq(reviewRankingParticipants.enabled, true),
    ));
  for (const { workspaceId } of participants) {
    await db.insert(reviewRankingOutcomes).values({
      workspaceId, reviewId: review.node_id, viewerLogin: login, repo: repo.toLowerCase(),
      prNumber: pr.number, state: review.state.toUpperCase(), submittedAt: new Date(review.submitted_at),
    }).onConflictDoNothing();
  }
}

/** Resolve creation time independently. Missing timestamps stay unknown. */
export async function reconcileRankingOutcomes(): Promise<void> {
  const db = getPoolDbClient();
  const pending = (await db.select({ outcome: reviewRankingOutcomes }).from(reviewRankingOutcomes)
    .innerJoin(reviewRankingParticipants, and(
      eq(reviewRankingParticipants.workspaceId, reviewRankingOutcomes.workspaceId),
      eq(reviewRankingParticipants.viewerLogin, reviewRankingOutcomes.viewerLogin),
      eq(reviewRankingParticipants.enabled, true),
    )).where(and(isNull(reviewRankingOutcomes.createdAt), or(
      isNull(reviewRankingOutcomes.lastCheckedAt),
      lt(reviewRankingOutcomes.lastCheckedAt, new Date(Date.now() - 86_400_000)),
    ))).orderBy(asc(reviewRankingOutcomes.submittedAt)).limit(200)).map((row) => row.outcome);
  for (const workspaceId of new Set(pending.map((row) => row.workspaceId))) {
    const rows = pending.filter((row) => row.workspaceId === workspaceId);
    try {
      await db.update(reviewRankingOutcomes).set({ lastCheckedAt: new Date() }).where(and(
        eq(reviewRankingOutcomes.workspaceId, workspaceId), inArray(reviewRankingOutcomes.reviewId, rows.map((r) => r.reviewId)),
      ));
      const result = await githubService.executeGraphql<{ nodes: Array<null | {
        id: string; createdAt: string; submittedAt: string | null; author: { login: string } | null;
      }> }>(workspaceId,
      'query RankingReviewTimes($ids: [ID!]!) { nodes(ids: $ids) { ... on PullRequestReview { id createdAt submittedAt author { login } } } }',
      { ids: rows.map((row) => row.reviewId) });
      for (const node of result.nodes) {
        const row = rows.find((r) => r.reviewId === node?.id);
        if (!node || !row || node.author?.login.toLowerCase() !== row.viewerLogin ||
            !node.submittedAt || Date.parse(node.submittedAt) !== row.submittedAt.getTime() ||
            !Number.isFinite(Date.parse(node.createdAt)) || Date.parse(node.createdAt) > row.submittedAt.getTime()) continue;
        await db.update(reviewRankingOutcomes).set({ createdAt: new Date(node.createdAt) }).where(and(
          eq(reviewRankingOutcomes.workspaceId, workspaceId), eq(reviewRankingOutcomes.reviewId, row.reviewId),
        ));
      }
    } catch (error) {
      console.warn('[review-ranking] outcome time reconciliation failed', workspaceId, error instanceof Error ? error.message : 'unknown');
    }
  }
  const cutoff = new Date(Date.now() - 90 * 86_400_000);
  await db.delete(reviewRankingEvents).where(lt(reviewRankingEvents.receivedAt, cutoff));
  await db.delete(reviewRankingOutcomes).where(lt(reviewRankingOutcomes.receivedAt, cutoff));
  await db.delete(reviewRankingParticipants).where(lt(reviewRankingParticipants.updatedAt, cutoff));
}
