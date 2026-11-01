import type { Workbench } from '@talyn/shared';

/** Order sessions by their last change, then creation time and ID. */
export function compareSessionActivity(a: Pick<Workbench, 'updatedAt' | 'createdAt' | 'id'>, b: Pick<Workbench, 'updatedAt' | 'createdAt' | 'id'>): number {
  return b.updatedAt.localeCompare(a.updatedAt) || b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id);
}

export function newestSessions<T extends Pick<Workbench, 'updatedAt' | 'createdAt' | 'id'>>(sessions: T[]): T[] {
  return [...sessions].sort(compareSessionActivity);
}
