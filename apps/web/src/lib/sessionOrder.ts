import type { Workbench } from '@talyn/shared';

/**
 * Order sessions newest first by creation time, then by ID. Not by the last
 * change: a list sorted by activity moves under the pointer every time a
 * session works, which made the sidebar hard to use.
 */
export function compareSessionActivity(a: Pick<Workbench, 'createdAt' | 'id'>, b: Pick<Workbench, 'createdAt' | 'id'>): number {
  return b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id);
}

export function newestSessions<T extends Pick<Workbench, 'createdAt' | 'id'>>(sessions: T[]): T[] {
  return [...sessions].sort(compareSessionActivity);
}
