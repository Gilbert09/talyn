import {
  detectSandboxSize, isComposeFileName, MAX_COMPOSE_FILES, resolveSandboxSize, SANDBOX_SIZES,
  type CachedSandboxSize, type RepositorySandboxSizeResponse, type SandboxSize, type SandboxSizeSetting,
} from '@talyn/shared';
import { eq, sql } from 'drizzle-orm';
import { getDbClient } from '../../db/client.js';
import { repositories } from '../../db/schema.js';
import { githubService } from '../github.js';
import { FleetThrottleError } from '../selfHosted/client.js';
import { appendEvents, listChats, type WorkbenchRow } from './store.js';
import { emitWorkbenchEvents } from './emit.js';

type SizeRow = Pick<typeof repositories.$inferSelect, 'id' | 'workspaceId' | 'name' | 'defaultBranch' | 'settings'>;

/** Inside this window a stored answer is used without asking GitHub for the branch head. */
const FRESH_MS = 6 * 60 * 60_000;
const COMPOSE_DIRECTORIES = ['', 'docker'];
const COMPOSE_MAX_BYTES = 128 * 1024;

export async function getSizeRepository(id: string): Promise<SizeRow | null> {
  const [row] = await getDbClient().select({
    id: repositories.id, workspaceId: repositories.workspaceId, name: repositories.name, defaultBranch: repositories.defaultBranch, settings: repositories.settings,
  }).from(repositories).where(eq(repositories.id, id)).limit(1);
  return row ?? null;
}

/** Detect from the default branch's compose files, once per branch head. A failure to read gives the stored answer, or none. */
export async function detectRepoSandboxSize(workspaceId: string, repo: SizeRow, options: { force?: boolean } = {}): Promise<CachedSandboxSize | null> {
  const cached = repo.settings?.detectedSandboxSize ?? null;
  if (!options.force && cached && Date.now() - Date.parse(cached.at) < FRESH_MS) return cached;
  try {
    const [owner, name] = repo.name.split('/');
    const sha = await githubService.getRefSha(workspaceId, owner, name, repo.defaultBranch);
    if (!options.force && cached?.sha === sha) {
      await mergeSandboxSize(repo.id, { detectedSandboxSize: { ...cached, at: new Date().toISOString() } });
      return cached;
    }
    const listings = await Promise.all(COMPOSE_DIRECTORIES.map(async (dir) => {
      const entries = (await githubService.getDirectoryListing(workspaceId, owner, name, dir, sha)) ?? [];
      return entries
        .filter((entry) => entry.type !== 'dir' && isComposeFileName(entry.name))
        .map((entry) => (dir ? `${dir}/${entry.name}` : entry.name));
    }));
    const paths = listings.flat().slice(0, MAX_COMPOSE_FILES);
    const files = await Promise.all(paths.map(async (path) => ({
      path, content: (await githubService.getFileContent(workspaceId, owner, name, path, sha, COMPOSE_MAX_BYTES))?.content ?? null,
    })));
    const detected: CachedSandboxSize = { ...detectSandboxSize(files), sha, at: new Date().toISOString() };
    await mergeSandboxSize(repo.id, { detectedSandboxSize: detected });
    return detected;
  } catch (err) {
    console.warn(`[sandbox-size] detection failed for ${repo.name}:`, err);
    return cached;
  }
}

/** Merge inside Postgres so a detection cannot replace a concurrent choice. `sandboxSize: null` removes the setting. */
export async function mergeSandboxSize(
  id: string,
  patch: { sandboxSize?: SandboxSizeSetting | null; detectedSandboxSize?: CachedSandboxSize },
): Promise<void> {
  const value = JSON.stringify({
    ...(patch.detectedSandboxSize ? { detectedSandboxSize: patch.detectedSandboxSize } : {}),
    ...(patch.sandboxSize && patch.sandboxSize !== 'auto' ? { sandboxSize: patch.sandboxSize } : {}),
  });
  const clear = patch.sandboxSize === 'auto' || patch.sandboxSize === null;
  await getDbClient().update(repositories).set({
    settings: clear
      ? sql`(coalesce(${repositories.settings}, '{}'::jsonb) - 'sandboxSize') || ${value}::jsonb`
      : sql`coalesce(${repositories.settings}, '{}'::jsonb) || ${value}::jsonb`,
  }).where(eq(repositories.id, id));
}

export function sandboxSizeResponse(row: Pick<SizeRow, 'settings'>): RepositorySandboxSizeResponse {
  const setting = row.settings?.sandboxSize ?? 'auto';
  const detected = row.settings?.detectedSandboxSize ?? null;
  return { setting, detected, effective: resolveSandboxSize(setting, detected?.size) };
}

export function validateSandboxSizeChoice(value: unknown): SandboxSizeSetting {
  const choice = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  if (!choice || Object.keys(choice).some((key) => key !== 'sandboxSize')) throw new Error('Send only sandboxSize.');
  const size = choice.sandboxSize;
  if (size !== 'auto' && size !== 'standard' && size !== 'large') throw new Error('Sandbox size must be auto, standard, or large.');
  return size;
}

/** The size a new session box gets: the setting, else detection, else standard. Never throws. */
export async function sizeForSession(row: Pick<WorkbenchRow, 'repositoryId' | 'workspaceId'>): Promise<SandboxSize> {
  try {
    const repo = await getSizeRepository(row.repositoryId);
    if (!repo) return 'standard';
    const setting = repo.settings?.sandboxSize;
    if (setting === 'standard' || setting === 'large') return setting;
    const detected = await detectRepoSandboxSize(row.workspaceId, repo);
    return resolveSandboxSize(setting, detected?.size);
  } catch (err) {
    console.warn(`[sandbox-size] resolving the size for ${row.repositoryId} failed:`, err);
    return 'standard';
  }
}

/** A quota refusal of size, as opposed to a rate limit, which clears by waiting. */
export function isSizeRefusal(err: unknown): err is FleetThrottleError {
  return err instanceof FleetThrottleError && /MiB|milli-vCPU|vCPU|tenant_memory|tenant_vcpu/i.test(err.message);
}

export function sizeFallbackNote(err: Error): string {
  const limit = err.message.match(/exceeds the (\d+) MiB permitted/);
  const standard = SANDBOX_SIZES.standard.memMib;
  return limit
    ? `This repository asks for a large sandbox, but the fleet allows at most ${limit[1]} MiB; using 4 GB.`
    : `This repository asks for a large sandbox, but the fleet refused that size; using ${standard / 1024} GB.`;
}

/** Tell the person, in each open chat of the session. */
export async function noteSizeFallback(row: Pick<WorkbenchRow, 'id'>, text: string): Promise<void> {
  for (const chat of await listChats(row.id)) {
    if (chat.closedAt) continue;
    const stored = await appendEvents(chat.id, [{ turn: chat.turnCount, event: { type: 'system', subtype: 'sandbox_size_fallback', text } }]);
    emitWorkbenchEvents(chat.workspaceId, chat.id, stored);
  }
}
