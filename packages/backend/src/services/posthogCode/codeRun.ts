import { and, eq, sql } from 'drizzle-orm';
import {
  isStoredPostHogCodeModelId,
  type PostHogCodeRuntimeAdapter,
} from '@talyn/shared';
import { getDbClient } from '../../db/client.js';
import {
  repositories as repositoriesTable,
  workspaces as workspacesTable,
} from '../../db/schema.js';
import { getPostHogCodeClient } from './credentials.js';
import { DEFAULT_POSTHOG_CODE_MODEL } from './client.js';

/**
 * Starting one PostHog Code run, for callers that are not a `tasks` row.
 *
 * The fall-back counterpart to `selfHosted/sandboxRun.ts`, and the two are
 * deliberately not the same shape, because the providers are not:
 *
 * - **No `targetRef`.** `createTask` accepts a repository and nothing else about
 *   which ref to read, so a run that must look at a pull request has to be told
 *   to check it out in its prompt. A caller that needs a specific ref must say
 *   so in words.
 * - **No turn, spend or time cap.** `CreateSandboxTaskInput` has all three and
 *   this API has none. `cancelRun` is the only bound, which means a caller that
 *   relies on a budget to keep a fan-out affordable cannot rely on it here. That
 *   asymmetry is why spilling work onto this provider should be bounded rather
 *   than unlimited: a capacity refusal absorbed by an uncapped run converts a
 *   queueing problem into a spending one.
 * - **One remote task per run, and no reuse.** Reuse exists on the task path
 *   because a `tasks` row is reused, and PostHog reads the task's current
 *   `description` when a run starts. A caller with no row to reuse wants a fresh
 *   remote task per unit of work, which also makes the vendor's own list
 *   readable.
 *
 * The model ladder mirrors the task path's, guards included: an explicitly
 * pinned model is only honoured when PostHog's runtime actually accepts it,
 * because the fleet's catalogue is wider than this one and a verbatim
 * cross-provider pin earns a 400 at dispatch.
 */

export interface CodeRunSpec {
  workspaceId: string;
  repositoryId: string;
  /** What the vendor's own task list will show. Keep it identifying. */
  title: string;
  /** The whole instruction. PostHog reads this as the remote task's description. */
  prompt: string;
  /** An explicit pin, dropped when this runtime does not accept it. */
  model?: string;
  /** Tried after the workspace setting, before the shipped default. */
  modelFallback?: string;
  runtimeAdapter?: PostHogCodeRuntimeAdapter;
}

export type CodeRunResult =
  | { ok: true; remoteTaskId: string; remoteRunId: string | null; model: string }
  | { ok: false; error: string };

const DEFAULT_RUNTIME_ADAPTER: PostHogCodeRuntimeAdapter = 'claude';

/**
 * Create a remote task and start a background run on it.
 *
 * Every refusal is a returned value rather than a throw, matching the fleet
 * seam, so a caller walking a provider chain reads one shape from both.
 */
export async function startCodeRun(spec: CodeRunSpec): Promise<CodeRunResult> {
  const client = await getPostHogCodeClient(spec.workspaceId);
  if (!client) {
    return {
      ok: false,
      error: 'PostHog Code is not connected for this workspace.',
    };
  }

  const repository = await resolveRepositorySlug(spec.repositoryId, spec.workspaceId);
  if (!repository) {
    return { ok: false, error: 'Could not resolve a GitHub owner/repo for this repository.' };
  }

  // The API requires a model on every cloud run, so resolve to a concrete one.
  // The pin is GUARDED: six of the fleet's models are ones this runtime does not
  // accept, and sending one verbatim turns a capacity fall-back into a failed
  // run. Dropping to the next rung is right rather than refusing — the user
  // asked for work to happen, and the model was the other provider's choice.
  const model =
    (isStoredPostHogCodeModelId(spec.model) ? spec.model : undefined) ||
    (await workspacePostHogCodeModel(spec.workspaceId)) ||
    (isStoredPostHogCodeModelId(spec.modelFallback) ? spec.modelFallback : undefined) ||
    DEFAULT_POSTHOG_CODE_MODEL;

  const runtimeAdapter = spec.runtimeAdapter ?? DEFAULT_RUNTIME_ADAPTER;

  try {
    const created = await client.createTask({
      title: spec.title,
      description: spec.prompt,
      repository,
    });
    const started = await client.startRun(created.id, { runtimeAdapter, model });
    return {
      ok: true,
      remoteTaskId: created.id,
      // `latest_run.id` rather than the returned task id: they are different
      // things, and the run id is what every later read needs.
      remoteRunId: started.latest_run?.id ?? null,
      model,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function resolveRepositorySlug(
  repositoryId: string,
  workspaceId: string,
): Promise<string | null> {
  const rows = await getDbClient()
    .select({ url: repositoriesTable.url, name: repositoriesTable.name })
    .from(repositoriesTable)
    .where(and(eq(repositoriesTable.id, repositoryId), eq(repositoriesTable.workspaceId, workspaceId)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return parseGitHubSlug(row.url) ?? sanitizeSlug(row.name);
}

function parseGitHubSlug(url: string): string | null {
  const match = url.match(/github\.com[/:]([\w.-]+)\/([\w.-]+)/);
  if (!match) return null;
  return `${match[1]}/${match[2].replace(/\.git$/, '')}`;
}

function sanitizeSlug(name: string): string | null {
  // Repository.name is conventionally "owner/repo" already.
  return /^[\w.-]+\/[\w.-]+$/.test(name) ? name : null;
}

/**
 * The workspace's Settings → PostHog Code model choice, or undefined when
 * unset/unknown. Extracted in SQL so the settings jsonb never ships.
 */
async function workspacePostHogCodeModel(workspaceId: string): Promise<string | undefined> {
  const [row] = await getDbClient()
    .select({ model: sql<string | null>`${workspacesTable.settings} ->> 'posthogCodeModel'` })
    .from(workspacesTable)
    .where(eq(workspacesTable.id, workspaceId))
    .limit(1);
  // The wider guard on purpose: a workspace may have pinned an Opus 4.x the
  // pickers no longer offer, and falling back to the default would quietly move
  // it to a dearer model.
  return isStoredPostHogCodeModelId(row?.model) ? row.model : undefined;
}
