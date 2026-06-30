import { eq } from 'drizzle-orm';
import {
  readCloudTaskMeta,
  isClaudeModelId,
  DEFAULT_CLAUDE_MODEL_ID,
  type CloudTaskMetadata,
  type ClaudeModelId,
  type Environment,
  type Task,
} from '@talyn/shared';
import { getDbClient } from '../../db/client.js';
import {
  tasks as tasksTable,
  repositories as repositoriesTable,
  workspaces as workspacesTable,
} from '../../db/schema.js';
import { patchTaskMetadata } from '../taskMetadataMutex.js';
import { emitTaskStatus } from '../websocket.js';
import { githubService } from '../github.js';
import { ClaudeManagedAgentsClient } from './client.js';
import {
  getClaudeCodeCredentials,
  cacheClaudeResourceIds,
  type ClaudeCodeCredentials,
} from './credentials.js';

export type DispatchResult = { ok: true } | { ok: false; error: string };

const AGENT_SYSTEM_PROMPT =
  'You are a coding agent operating on a GitHub repository mounted in your sandbox. ' +
  'Make the requested change, then open a GitHub pull request using your GitHub tools ' +
  '(the connected `github` MCP server). Local `git push` and the `gh` CLI are not available — ' +
  'use the GitHub MCP tools to create the branch, write files, and open the PR. ' +
  // Keep runs efficient: this is a metered cloud run, so stay focused and don't idle.
  'Keep the change minimal and focused on what was asked — do not refactor or touch unrelated ' +
  'code, and do not sit waiting on long-running CI. Once the PR is open, state its URL and stop. ' +
  'When done, state the URL of the pull request you opened.';

/**
 * Hand a task off to Claude Managed Agents: ensure the workspace's reusable
 * agent / environment / vault exist, create a session with the repo mounted,
 * and post the task prompt (which starts the run). The cloud owns the agent
 * loop from here — the poller drives the FastOwl task to completed / failed.
 *
 * Idempotent: a task that already carries a `cloudTask.remoteTaskId` (the
 * session id) has been dispatched; do nothing.
 */
export async function dispatchTaskToClaudeCode(
  task: Task,
  env: Environment,
): Promise<DispatchResult> {
  if (readCloudTaskMeta(task)?.remoteTaskId) return { ok: true };

  const creds = await getClaudeCodeCredentials(task.workspaceId);
  if (!creds) {
    return {
      ok: false,
      error:
        'Claude Code is not configured for this workspace — add an Anthropic API key in workspace settings.',
    };
  }

  // GitHub access reuses the workspace's existing connection (no separate PAT).
  // Fetched fresh each dispatch so a re-connected/rotated token is always current.
  const githubToken = githubService.getAccessToken(task.workspaceId);
  if (!githubToken) {
    return {
      ok: false,
      error: 'Connect GitHub for this workspace — Claude Code uses it to read the repo and open the PR.',
    };
  }

  if (!task.repositoryId) {
    return { ok: false, error: 'Claude Code tasks require a repository.' };
  }
  const slug = await resolveRepositorySlug(task.repositoryId);
  if (!slug) {
    return {
      ok: false,
      error: 'Could not resolve a GitHub owner/repo for this task’s repository.',
    };
  }

  const model = await resolveClaudeModel(task, env);
  const prompt = task.prompt?.trim() || task.description?.trim() || task.title;

  try {
    const client = new ClaudeManagedAgentsClient(creds.anthropicApiKey);
    const { agentId, environmentId } = await ensureResources(
      task.workspaceId,
      creds,
      client,
      model,
    );

    // Mint a fresh vault per dispatch with the current GitHub token. Caching it
    // would go stale when the workspace token is revoked + re-connected (see the
    // token-revocation saga in SESSIONS.md), breaking the PR step silently.
    const vault = await client.createVault('FastOwl GitHub');
    await client.addVaultGitHubCredential(vault.id, githubToken);

    const session = await client.createSession({
      agentId,
      environmentId,
      vaultId: vault.id,
      repoUrl: `https://github.com/${slug}`,
      githubToken,
    });

    // Posting the first user message starts the run.
    await client.postUserMessage(session.id, prompt);

    const cloudTask: CloudTaskMetadata = {
      provider: 'claude_code',
      remoteTaskId: session.id,
      remoteRunId: session.id,
      status: session.status ?? 'running',
      // vaultId is per-dispatch — tracked so finalize/cancel can delete it.
      extra: { agentId, environmentId, vaultId: vault.id, repo: slug, model },
    };
    await patchTaskMetadata(task.id, (existing) => ({ ...existing, cloudTask }));

    await getDbClient()
      .update(tasksTable)
      .set({ status: 'in_progress', assignedEnvironmentId: env.id, updatedAt: new Date() })
      .where(eq(tasksTable.id, task.id));
    emitTaskStatus(task.workspaceId, task.id, 'in_progress');

    console.log(
      `[claudeCode] task ${task.id.slice(0, 8)} → session ${session.id} (${slug}, ${model})`,
    );
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Ensure the workspace's reusable agent + environment exist, creating +
 * caching any that are missing. Rotating the Anthropic key clears the cache
 * (see storeClaudeCodeCredentials), so this re-creates them against the new key.
 * (The vault is minted per dispatch, not here — it carries the rotating GitHub
 * token and must always be fresh.)
 */
async function ensureResources(
  workspaceId: string,
  creds: ClaudeCodeCredentials,
  client: ClaudeManagedAgentsClient,
  model: ClaudeModelId,
): Promise<{ agentId: string; environmentId: string }> {
  // A Managed Agent has a fixed model, so reuse the agent cached for THIS model
  // (creating one the first time the workspace runs on it); the environment is
  // model-independent.
  let agentId = creds.agentIdsByModel?.[model];
  let environmentId = creds.environmentId;

  if (!agentId) {
    const agent = await client.createAgent({
      name: `Talyn (${model})`,
      model,
      system: AGENT_SYSTEM_PROMPT,
    });
    agentId = agent.id;
    await cacheClaudeResourceIds(workspaceId, { model, agentId });
  }
  if (!environmentId) {
    const environment = await client.createEnvironment('talyn');
    environmentId = environment.id;
    await cacheClaudeResourceIds(workspaceId, { environmentId });
  }
  return { agentId, environmentId };
}

/**
 * Pick the Claude model for a run: a per-task override wins, then the
 * workspace's chosen model (Settings → Claude Code), then any env-config model,
 * then the default (Sonnet). Anything that isn't a known model id is ignored.
 */
async function resolveClaudeModel(task: Task, env: Environment): Promise<ClaudeModelId> {
  const fromTask = (task.metadata as Record<string, unknown> | null)?.model;
  if (isClaudeModelId(fromTask)) return fromTask;
  const fromWorkspace = await readWorkspaceClaudeModel(task.workspaceId);
  if (fromWorkspace) return fromWorkspace;
  const fromEnv = modelFromEnv(env);
  if (isClaudeModelId(fromEnv)) return fromEnv;
  return DEFAULT_CLAUDE_MODEL_ID;
}

/** The workspace's chosen Claude model, or null if unset / not a known id. */
async function readWorkspaceClaudeModel(workspaceId: string): Promise<ClaudeModelId | null> {
  const rows = await getDbClient()
    .select({ settings: workspacesTable.settings })
    .from(workspacesTable)
    .where(eq(workspacesTable.id, workspaceId))
    .limit(1);
  const m = (rows[0]?.settings as { claudeModel?: unknown } | null)?.claudeModel;
  return isClaudeModelId(m) ? m : null;
}

async function resolveRepositorySlug(repositoryId: string): Promise<string | null> {
  const rows = await getDbClient()
    .select({ url: repositoriesTable.url, name: repositoriesTable.name })
    .from(repositoriesTable)
    .where(eq(repositoriesTable.id, repositoryId))
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
  return /^[\w.-]+\/[\w.-]+$/.test(name) ? name : null;
}

function modelFromEnv(env: Environment): string | undefined {
  const config = env.config as { model?: string };
  return config?.model;
}
