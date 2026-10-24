import {
  detectPreview, parsePreviewConfig, PREVIEW_DETECT_PATHS, resolveWorkbenchConfig,
  type EffectivePreview, type RepositoryPreviewChoice, type RepositoryPreviewResponse, type RepositorySettings,
} from '@talyn/shared';
import { eq, sql } from 'drizzle-orm';
import { getDbClient } from '../../db/client.js';
import { repositories } from '../../db/schema.js';
import { githubService } from '../github.js';

type PreviewRow = Pick<typeof repositories.$inferSelect, 'id' | 'workspaceId' | 'name' | 'defaultBranch' | 'settings'>;
type CachedPreview = NonNullable<RepositorySettings['preview']>['detected'];

export async function getPreviewRepository(id: string): Promise<PreviewRow | null> {
  const [row] = await getDbClient().select({
    id: repositories.id, workspaceId: repositories.workspaceId, name: repositories.name,
    defaultBranch: repositories.defaultBranch, settings: repositories.settings,
  }).from(repositories).where(eq(repositories.id, id)).limit(1);
  return row ?? null;
}

export async function detectRepoPreview(workspaceId: string, repo: PreviewRow, options: { force?: boolean } = {}): Promise<CachedPreview | null> {
  const cached = repo.settings?.preview?.detected ?? null;
  try {
    const [owner, name] = repo.name.split('/');
    const sha = await githubService.getRefSha(workspaceId, owner, name, repo.defaultBranch);
    if (!options.force && cached?.sha === sha) return cached;
    const results = await Promise.allSettled([
      ...PREVIEW_DETECT_PATHS.map(async (path) => ({
        path, content: (await githubService.getFileContent(workspaceId, owner, name, path, sha, 64 * 1024))?.content ?? null,
      })),
      ...['', 'docs', 'docs/internal'].map(async (path) => ({
        paths: (await githubService.getDirectoryListing(workspaceId, owner, name, path, sha) ?? [])
          .map((entry) => path ? `${path}/${entry.name}` : entry.name),
      })),
    ]);
    const files: Record<string, string | null> = {};
    const paths: string[] = [];
    for (const result of results) {
      if (result.status === 'rejected') throw result.reason;
      if ('paths' in result.value) paths.push(...result.value.paths);
      else files[result.value.path] = result.value.content;
    }
    const file = resolveWorkbenchConfig({ talynToml: files['.talyn/settings.toml'] }).preview;
    const detected = { ...detectPreview({ files, paths }), sha, at: new Date().toISOString(), ...(file ? { file } : {}) };
    await mergePreview(repo.id, { detected });
    return detected;
  } catch (err) {
    console.warn(`[preview] detection failed for ${repo.name}:`, err);
    return cached;
  }
}

export async function mergePreview(id: string, patch: NonNullable<RepositorySettings['preview']>): Promise<void> {
  const value = JSON.stringify(patch);
  // Merge inside Postgres so detection cannot replace a concurrent user choice.
  await getDbClient().update(repositories).set({
    settings: sql`coalesce(${repositories.settings}, '{}'::jsonb) || jsonb_build_object('preview',
      coalesce(${repositories.settings}->'preview', '{}'::jsonb) || ${value}::jsonb ||
      CASE WHEN ${value}::jsonb ? 'coder' THEN jsonb_build_object('coder',
        coalesce(${repositories.settings}->'preview'->'coder', '{}'::jsonb) || (${value}::jsonb->'coder'))
      ELSE '{}'::jsonb END)`,
  }).where(eq(repositories.id, id));
}

export function effectivePreview(row: { settings: RepositorySettings | null }): EffectivePreview {
  const { detected, ...user } = row.settings?.preview ?? {};
  const file = detected?.file;
  const userTarget = user.target && user.target !== 'auto' ? user.target : undefined;
  const hasUser = userTarget !== undefined || user.ports !== undefined || user.coder !== undefined;
  const hasFile = file && Object.keys(file).length > 0;
  const coder = { ...detected?.coder, ...file?.coder, ...user.coder };
  return {
    target: userTarget ?? file?.target ?? detected?.target ?? null,
    ports: user.ports ?? file?.ports ?? detected?.ports ?? [],
    ...(Object.keys(coder).length ? { coder } : {}),
    reasons: detected?.reasons ?? [],
    source: hasUser ? 'user' : hasFile ? 'file' : detected ? 'detected' : 'none',
  };
}

export function previewResponse(row: { settings: RepositorySettings | null }): RepositoryPreviewResponse {
  const { detected, ...user } = row.settings?.preview ?? {};
  return { ...effectivePreview(row), user, detected: detected ?? null };
}

export function validatePreviewChoice(value: unknown): RepositoryPreviewChoice {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Preview settings must be an object.');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !['target', 'ports', 'coder'].includes(key))) throw new Error('Unknown preview setting.');
  if (input.target !== undefined && !['auto', 'sandbox', 'coder', 'off'].includes(input.target as string)) {
    throw new Error('Preview target must be auto, sandbox, coder, or off.');
  }
  if (input.ports !== undefined) {
    if (!Array.isArray(input.ports) || input.ports.length > 16) throw new Error('Use at most 16 preview ports.');
    for (const port of input.ports) {
      if (port && typeof port === 'object') {
        if (port.label !== undefined && (typeof port.label !== 'string' || port.label.length > 500)) throw new Error('Port labels must have at most 500 characters.');
        if (port.primary !== undefined && typeof port.primary !== 'boolean') throw new Error('Port primary must be a boolean.');
      }
    }
  }
  let coder: RepositoryPreviewChoice['coder'];
  if (input.coder !== undefined) {
    if (!input.coder || typeof input.coder !== 'object' || Array.isArray(input.coder)) throw new Error('Coder settings must be an object.');
    coder = {};
    for (const [key, val] of Object.entries(input.coder)) {
      if (!['url', 'workspace', 'checkout', 'run'].includes(key)) throw new Error('Unknown Coder setting.');
      if (typeof val !== 'string' || val.length > 500) throw new Error('Coder settings must be strings with at most 500 characters.');
      if (key === 'url') {
        let url: URL;
        try { url = new URL(val); } catch { throw new Error('Coder URL must be an HTTP or HTTPS URL.'); }
        if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Coder URL must be an HTTP or HTTPS URL.');
      }
      coder[key as keyof typeof coder] = val;
    }
  }
  const errors: string[] = [];
  const parsed = parsePreviewConfig({ ports: input.ports }, (message) => errors.push(message));
  if (errors.length) throw new Error(errors.join(' '));
  return {
    ...(input.target !== undefined ? { target: input.target as RepositoryPreviewChoice['target'] } : {}),
    ...(parsed?.ports !== undefined ? { ports: parsed.ports } : {}),
    ...(coder !== undefined ? { coder } : {}),
  };
}
