import { eq } from 'drizzle-orm';
import type { WSEvent, WorkbenchWsPayloads } from '@talyn/shared';
import { getPoolDbClient } from '../../db/client.js';
import { workbenches, workbenchChats, tasks, repositories } from '../../db/schema.js';
import { canViewItem, type ViewableItem } from './access.js';

export const SPACE_EVENT_TYPES = new Set<WSEvent['type']>([
  'workbench:updated', 'workbench:deleted', 'workbench:chat', 'workbench:event',
  'task:status', 'task:update', 'task:event', 'task:deleted',
]);

const TTL_MS = 60_000;
const MAX_CACHE_ENTRIES = 10_000;
type Entry<T> = { until: number; value: Promise<T> };
const items = new Map<string, Entry<ViewableItem | null>>();
const chats = new Map<string, Entry<string | null>>();
const viewers = new Map<string, Entry<boolean>>();

function cached<T>(cache: Map<string, Entry<T>>, key: string, load: () => Promise<T>): Promise<T> {
  const existing = cache.get(key);
  if (existing && existing.until > Date.now()) return existing.value;
  if (cache.size >= MAX_CACHE_ENTRIES) {
    for (const [id, entry] of cache) if (entry.until <= Date.now()) cache.delete(id);
    if (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
  }
  const entry = { until: Date.now() + TTL_MS, value: load() };
  cache.set(key, entry);
  void entry.value.catch(() => { if (cache.get(key) === entry) cache.delete(key); });
  return entry.value;
}

export function resetSpaceEventCache(): void {
  items.clear();
  chats.clear();
  viewers.clear();
}

export function spaceItem(kind: 'workbench' | 'chat' | 'task', id: string): Promise<ViewableItem | null> {
  if (kind === 'chat') {
    return cached(chats, id, async () => {
      const [row] = await getPoolDbClient().select({ workbenchId: workbenchChats.workbenchId })
        .from(workbenchChats).where(eq(workbenchChats.id, id)).limit(1);
      return row?.workbenchId ?? null;
    }).then((workbenchId) => workbenchId ? spaceItem('workbench', workbenchId) : null);
  }
  return cached(items, `${kind}:${id}`, async () => {
    const db = getPoolDbClient();
    if (kind === 'task') {
      const [row] = await db.select({ workspaceId: tasks.workspaceId, spaceId: tasks.spaceId, repoFullName: repositories.name })
        .from(tasks).leftJoin(repositories, eq(repositories.id, tasks.repositoryId)).where(eq(tasks.id, id)).limit(1);
      return row ?? null;
    }
    const columns = { workspaceId: workbenches.workspaceId, spaceId: workbenches.spaceId, repoFullName: workbenches.repoFullName };
    const [row] = await db.select(columns).from(workbenches).where(eq(workbenches.id, id)).limit(1);
    return row ?? null;
  });
}

export function mayViewSpaceItem(userId: string, item: ViewableItem): Promise<boolean> {
  const key = JSON.stringify([userId, item.workspaceId, item.spaceId, item.repoFullName]);
  return cached(viewers, key, () => canViewItem(userId, item));
}

// Script output and unrelated workspace events never enter the space channel.
export async function spaceEvent(event: WSEvent): Promise<{ item: ViewableItem; event: WSEvent } | null> {
  let kind: 'workbench' | 'chat' | 'task';
  let id: string;
  let outgoing = event;
  switch (event.type) {
    case 'workbench:updated': {
      const { workbench } = event.payload as WorkbenchWsPayloads['workbench:updated'];
      kind = 'workbench';
      id = workbench.id;
      const existing = items.get(`${kind}:${id}`);
      if (existing && (await existing.value)?.spaceId !== (workbench.spaceId ?? null)) {
        items.delete(`${kind}:${id}`);
        viewers.clear();
      }
      outgoing = { ...event, payload: { workbench: {
        ...workbench, sandboxId: null, deviceId: null, localPath: null, keptWorktree: null,
      } } };
      break;
    }
    case 'workbench:deleted':
      kind = 'workbench';
      id = (event.payload as WorkbenchWsPayloads['workbench:deleted']).id;
      break;
    case 'workbench:chat':
      kind = 'workbench';
      id = (event.payload as WorkbenchWsPayloads['workbench:chat']).chat.workbenchId;
      break;
    case 'workbench:event':
      kind = 'chat';
      id = (event.payload as WorkbenchWsPayloads['workbench:event']).chatId;
      break;
    case 'task:status': {
      const payload = event.payload as { taskId: string; status: string };
      kind = 'task';
      id = payload.taskId;
      outgoing = { ...event, payload: { taskId: id, status: payload.status } };
      break;
    }
    case 'task:update': {
      const payload = event.payload as { taskId: string; updates: Record<string, unknown> };
      kind = 'task';
      id = payload.taskId;
      const existing = items.get(`task:${id}`);
      if (existing && payload.updates && 'spaceId' in payload.updates &&
          (await existing.value)?.spaceId !== payload.updates.spaceId) {
        items.delete(`task:${id}`);
        viewers.clear();
      }
      const updates = Object.fromEntries(Object.entries(payload.updates ?? {}).filter(([key]) =>
        ['status', 'title', 'branch', 'completedAt', 'updatedAt', 'spaceId'].includes(key)));
      outgoing = { ...event, payload: { taskId: id, updates } };
      break;
    }
    case 'task:event':
    case 'task:deleted':
      kind = 'task';
      id = (event.payload as { taskId: string }).taskId;
      break;
    default:
      return null;
  }
  if (typeof id !== 'string' || !id) return null;
  const item = await spaceItem(kind, id);
  return item?.spaceId ? { item, event: outgoing } : null;
}
