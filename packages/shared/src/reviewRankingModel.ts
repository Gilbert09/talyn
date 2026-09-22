import type { PRPriorityTarget } from './prPriority.js';

export const REVIEW_RANKING_EXPERIMENT = 'priority-shared-v1';
export const SHARED_RANKING_FEATURES = [
  'log_request_age', 'recency_quantile', 'is_newest', 'in_newest_three',
  'log_creation_age', 'bot_author', 'log_queue_size', 'recency_x_deep_queue',
] as const;

export interface SharedRankingModel {
  schemaVersion: number;
  usage: string;
  version: string;
  featureNames: string[];
  hidden: number;
  mean: number[];
  scale: number[];
  parameters: number[];
}

export interface RankingExperimentTrace {
  experiment: string;
  assigned: 'control' | 'candidate';
  served: 'control' | 'candidate';
  modelVersion: string;
  baselineScore: number;
  candidateScore: number | null;
  features: number[] | null;
  fallback: string | null;
  latencyMs: number;
}

/** Missing request times refuse the whole queue instead of changing the feature meaning. */
export function sharedRankingFeatures(rows: PRPriorityTarget[], now: number): number[][] {
  if (!Number.isFinite(now) || rows.length > 2500) throw new Error('invalid_queue');
  const requested = rows.map((r) => Date.parse(r.reviewRequestedFirstSeenAt ?? ''));
  const created = rows.map((r) => Date.parse(r.summary.createdAt ?? r.createdAt ?? ''));
  if ([...requested, ...created].some((t) => !Number.isFinite(t) || t > now)) {
    throw new Error('missing_or_future_timestamp');
  }
  return rows.map((row, i) => {
    const newer = requested.filter((t) => t > requested[i]).length;
    const quantile = newer / Math.max(rows.length - 1, 1);
    return [
      Math.log1p((now - requested[i]) / 3_600_000), quantile,
      Number(newer === 0), Number(newer < 3), Math.log1p((now - created[i]) / 3_600_000),
      Number(row.summary.prAuthorIsBot ?? /\[bot\]$/i.test(row.summary.author ?? '')),
      Math.log1p(rows.length), quantile * Number(rows.length > 10),
    ];
  });
}

export function validateSharedRankingModel(model: SharedRankingModel): void {
  const dimension = SHARED_RANKING_FEATURES.length;
  if (model.schemaVersion !== 1 || model.usage !== 'production_experiment' ||
      !model.version || JSON.stringify(model.featureNames) !== JSON.stringify(SHARED_RANKING_FEATURES) ||
      !Number.isInteger(model.hidden) || model.hidden < 1 || model.hidden > 128 ||
      model.mean.length !== dimension || model.scale.length !== dimension ||
      model.parameters.length !== (2 * dimension + 2) * model.hidden ||
      [...model.mean, ...model.scale, ...model.parameters].some((v) => !Number.isFinite(v)) ||
      model.scale.some((v) => v <= 0)) throw new Error('invalid_model');
}

export function predictSharedRanking(model: SharedRankingModel, features: number[][]): number[] {
  validateSharedRankingModel(model);
  const d = model.mean.length;
  if (!features.length) return [];
  if (features.some((row) => row.length !== d || row.some((v) => !Number.isFinite(v)))) {
    throw new Error('invalid_features');
  }
  const z = features.map((row) => row.map((v, j) => Math.max(-8, Math.min(8, (v - model.mean[j]) / model.scale[j]))));
  const mean = model.mean.map((_, j) => z.reduce((sum, row) => sum + row[j], 0) / z.length);
  const end = 2 * d * model.hidden;
  const result = z.map((row) => {
    const design = [...row, ...mean];
    let score = 0;
    for (let h = 0; h < model.hidden; h++) {
      let activation = model.parameters[end + h];
      for (let j = 0; j < design.length; j++) activation += design[j] * model.parameters[j * model.hidden + h];
      score += Math.tanh(activation) * model.parameters[end + model.hidden + h];
    }
    return score;
  });
  if (result.some((v) => !Number.isFinite(v))) throw new Error('nonfinite_prediction');
  return result;
}
