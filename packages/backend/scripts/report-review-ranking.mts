import 'dotenv/config';
import { and, gte, lt } from 'drizzle-orm';
import { getPoolDbClient } from '../src/db/client.js';
import { reviewRankingEvents, reviewRankingOutcomes } from '../src/db/schema.js';
import { summarizeRankingExperiment } from '../src/services/reviewPriority/report.js';

const [startArg, endArg] = process.argv.slice(2);
const start = new Date(startArg);
const end = new Date(endArg);
if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start >= end || end.getTime() > Date.now()) {
  throw new Error('Usage: report-review-ranking.mts START_ISO END_ISO. Use a completed observation window.');
}
const db = getPoolDbClient();
const events = await db.select().from(reviewRankingEvents).where(and(
  gte(reviewRankingEvents.recordedAt, start), lt(reviewRankingEvents.recordedAt, end),
)).limit(250001);
const outcomes = await db.select().from(reviewRankingOutcomes).where(and(
  gte(reviewRankingOutcomes.submittedAt, start), lt(reviewRankingOutcomes.submittedAt, end),
)).limit(250001);
if (events.length > 250000 || outcomes.length > 250000) throw new Error('Window exceeds the report limit. Split it before analysis.');
console.log(JSON.stringify(summarizeRankingExperiment(events, outcomes, end), null, 2));
process.exit(0);
