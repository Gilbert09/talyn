import type { ReviewRankProfile } from '@talyn/shared';

/** The database default is an empty object until training stores statistics. */
export function readProfileStats(value: unknown): ReviewRankProfile['featureStats'] {
  const stats = value as Partial<NonNullable<ReviewRankProfile['featureStats']>> | null;
  if (!stats || !Array.isArray(stats.mean) || !Array.isArray(stats.sd) ||
      stats.mean.length !== stats.sd.length ||
      !stats.mean.every(Number.isFinite) || !stats.sd.every((v) => Number.isFinite(v) && v >= 0)) return null;
  return { mean: stats.mean, sd: stats.sd };
}
