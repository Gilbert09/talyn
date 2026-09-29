import { and, eq, exists, gte, lt, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import { reviewRankingEvents, reviewRankingOutcomes, reviewRankingParticipants, users } from '../../db/schema.js';

/** Exclude accounts that disabled collection, including their earlier records. */
export async function loadRankingReportData(db: Database, start: Date, end: Date) {
  const events = await db.select({
    workspaceId: reviewRankingEvents.workspaceId, userId: reviewRankingEvents.userId,
    event: reviewRankingEvents.event, receivedAt: reviewRankingEvents.receivedAt, payload: reviewRankingEvents.payload,
  }).from(reviewRankingEvents)
    .innerJoin(reviewRankingParticipants, and(
      eq(reviewRankingParticipants.workspaceId, reviewRankingEvents.workspaceId),
      eq(reviewRankingParticipants.userId, reviewRankingEvents.userId),
    ))
    .innerJoin(users, eq(users.id, reviewRankingParticipants.userId))
    .where(and(
      eq(reviewRankingParticipants.enabled, true), eq(users.reviewRankingOptOut, false),
      gte(reviewRankingEvents.recordedAt, start), lt(reviewRankingEvents.recordedAt, end),
    )).limit(250001);
  const outcomes = await db.select({
    workspaceId: reviewRankingOutcomes.workspaceId, viewerLogin: reviewRankingOutcomes.viewerLogin,
    reviewId: reviewRankingOutcomes.reviewId, repo: reviewRankingOutcomes.repo,
    prNumber: reviewRankingOutcomes.prNumber, createdAt: reviewRankingOutcomes.createdAt,
    submittedAt: reviewRankingOutcomes.submittedAt,
  }).from(reviewRankingOutcomes).where(and(
    gte(reviewRankingOutcomes.submittedAt, start), lt(reviewRankingOutcomes.submittedAt, end),
    exists(db.select({ id: reviewRankingParticipants.userId }).from(reviewRankingParticipants)
      .innerJoin(users, eq(users.id, reviewRankingParticipants.userId)).where(and(
        eq(reviewRankingParticipants.workspaceId, reviewRankingOutcomes.workspaceId),
        sql`lower(${reviewRankingParticipants.viewerLogin}) = lower(${reviewRankingOutcomes.viewerLogin})`,
        eq(reviewRankingParticipants.enabled, true), eq(users.reviewRankingOptOut, false),
      ))),
  )).limit(250001);
  if (events.length > 250000 || outcomes.length > 250000) {
    throw new Error('Window exceeds the report limit. Split it before analysis.');
  }
  return { events, outcomes };
}
