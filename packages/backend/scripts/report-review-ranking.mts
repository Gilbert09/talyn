import 'dotenv/config';
import { getPoolDbClient } from '../src/db/client.js';
import { summarizeRankingExperiment } from '../src/services/reviewPriority/report.js';
import { loadRankingReportData } from '../src/services/reviewPriority/reportData.js';

const [startArg, endArg, mode] = process.argv.slice(2);
const start = new Date(startArg);
const end = new Date(endArg);
if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start >= end || end.getTime() > Date.now() ||
    (mode !== undefined && mode !== '--audit-only')) {
  throw new Error('Usage: report-review-ranking.mts START_ISO END_ISO [--audit-only]. Use a completed observation window.');
}
const db = getPoolDbClient();
const { events, outcomes } = await loadRankingReportData(db, start, end);
const report = summarizeRankingExperiment(events, outcomes, end);
const { arms, ...audit } = report;
console.log(JSON.stringify(mode === '--audit-only' ? {
  ...audit,
  exposure: Object.fromEntries(Object.entries(arms).map(([arm, data]) => [arm, {
    reviewers: data.reviewers, matureSessions: data.matureSessions, inferenceP95Ms: data.inferenceP95Ms,
  }])),
} : report, null, 2));
process.exit(0);
