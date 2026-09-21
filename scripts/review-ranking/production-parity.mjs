import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  comparePRByPriority,
  replayPRPriorityTrace,
  PR_PRIORITY_SCORER_VERSION,
} from '@talyn/shared';

const snapshots = JSON.parse(readFileSync(0, 'utf8'));
const counts = {};
const increment = (key) => { counts[key] = (counts[key] ?? 0) + 1; };
const results = snapshots.map((snapshot) => {
  const failures = new Set();
  const verdicts = new Map();
  const targets = [];
  for (const candidate of snapshot.candidates) {
    const trace = candidate.priority_trace;
    if (!trace) {
      failures.add('missing_trace');
      continue;
    }
    try {
      if (!['server', 'client'].includes(trace.source) || trace.target.id !== candidate.pr_id ||
          trace.scoredAt > snapshot.at * 1000 ||
          (trace.source === 'server' && !/^[a-f0-9]{64}$/.test(trace.modelVersion ?? ''))) {
        throw new Error('Invalid provenance');
      }
      const replayed = replayPRPriorityTrace(trace);
      if (replayed.gate !== candidate.gate || replayed.score !== candidate.score) {
        failures.add('score_mismatch');
      }
      verdicts.set(candidate.pr_id, replayed);
      targets.push({
        id: candidate.pr_id,
        summary: { createdAt: candidate.created_at ?? undefined },
      });
    } catch {
      failures.add('invalid_trace');
    }
  }
  if (!snapshot.candidates.length) failures.add('empty_queue');
  if (!failures.size && snapshot.sort_mode === 'priority') {
    targets.sort((left, right) => comparePRByPriority(left, right, verdicts));
    if (targets.some((target, index) => target.id !== snapshot.candidates[index].pr_id)) {
      failures.add('order_mismatch');
    }
  }
  for (const reason of failures) increment(reason);
  return {
    snapshot_id: snapshot.snapshot_id,
    passed: failures.size === 0,
    failures: [...failures].sort(),
    order_checked: !failures.size && snapshot.sort_mode === 'priority',
  };
});
const scorer = import.meta.resolve('@talyn/shared');
const code = createHash('sha256');
for (const file of ['prPriority.js', 'reviewRank.js']) {
  code.update(file);
  code.update(readFileSync(new URL(file, scorer)));
}
process.stdout.write(JSON.stringify({
  scorer_version: PR_PRIORITY_SCORER_VERSION,
  runtime_sha256: code.digest('hex'),
  snapshots: results,
  counts,
  all_passed: results.length > 0 && results.every((result) => result.passed),
}));
