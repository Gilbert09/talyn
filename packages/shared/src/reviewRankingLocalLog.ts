export interface ReviewRankingLocalEvent {
  event: string;
  properties: Record<string, unknown>;
  stored_at: number;
}

export interface ReviewRankingStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const MAX_AGE_MS = 7 * 86_400_000;
export const REVIEW_RANKING_LOG_MAX_CHARS = 1_000_000;

function key(workspaceId: string): string {
  return `talyn-review-ranking-local-v1:${workspaceId}`;
}

export function readReviewRankingLog(
  storage: ReviewRankingStorage,
  workspaceId: string,
  now = Date.now(),
): ReviewRankingLocalEvent[] {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(key(workspaceId)) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is ReviewRankingLocalEvent =>
      !!item && typeof item === 'object' && typeof item.event === 'string' &&
      typeof item.stored_at === 'number' && item.stored_at > now - MAX_AGE_MS &&
      item.stored_at <= now && !!item.properties && typeof item.properties === 'object' &&
      item.properties.workspace_id === workspaceId,
    );
  } catch {
    return [];
  }
}

/** Keep bounded snapshots on this device. This function has no network path. */
export function appendReviewRankingLog(
  storage: ReviewRankingStorage,
  event: string,
  properties: Record<string, unknown>,
  now = Date.now(),
): void {
  const workspaceId = properties.workspace_id;
  if (typeof workspaceId !== 'string' || !workspaceId) return;
  try {
    let entries = readReviewRankingLog(storage, workspaceId, now);
    entries.push({ event, properties, stored_at: now });
    let serialized = JSON.stringify(entries);
    while (serialized.length > REVIEW_RANKING_LOG_MAX_CHARS && entries.length) {
      const oldest = entries[0].properties.snapshot_id;
      // Remove a whole snapshot, including its exposure and open events.
      entries = entries.filter((entry) => entry.properties.snapshot_id !== oldest);
      serialized = JSON.stringify(entries);
    }
    storage.setItem(key(workspaceId), serialized);
  } catch {
    // A full or disabled store must not interrupt a review.
  }
}
