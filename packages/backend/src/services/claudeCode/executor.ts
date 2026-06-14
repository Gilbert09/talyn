import { eq } from 'drizzle-orm';
import {
  readCloudTaskMeta,
  type CloudTaskMetadata,
  type Environment,
  type Task,
} from '@fastowl/shared';
import { getDbClient } from '../../db/client.js';
import {
  tasks as tasksTable,
  repositories as repositoriesTable,
} from '../../db/schema.js';
import { patchTaskMetadata } from '../taskMetadataMutex.js';
import { emitTaskStatus } from '../websocket.js';
import { DEFAULT_CLAUDE_MODEL, ClaudeManagedAgentsClient } from './client.js';
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
        'Claude Code is not configured for this workspace — add an Anthropic API key and a GitHub token in workspace settings.',
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

  const model =
    (typeof (task.metadata as Record<string, unknown>)?.model === 'string' &&
      (task.metadata as Record<string, unknown>).model) ||
    modelFromEnv(env) ||
    DEFAULT_CLAUDE_MODEL;
  const prompt = task.prompt?.trim() || task.description?.trim() || task.title;

  try {
    const client = new ClaudeManagedAgentsClient(creds.anthropicApiKey);
    const { agentId, environmentId, vaultId } = await ensureResources(
      task.workspaceId,
      creds,
      client,
      String(model),
    );

    const session = await client.createSession({
      agentId,
      environmentId,
      vaultId,
      repoUrl: `https://github.com/${slug}`,
      githubToken: creds.githubToken,
    });

    // Posting the first user message starts the run.
    await client.postUserMessage(session.id, prompt);

    const cloudTask: CloudTaskMetadata = {
      provider: 'claude_routine',
      remoteTaskId: session.id,
      remoteRunId: session.id,
      status: session.status ?? 'running',
      extra: { agentId, environmentId, vaultId, repo: slug, model: String(model) },
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
 * Ensure the workspace's reusable Managed Agents resources exist, creating +
 * caching any that are missing. A new vault also gets the GitHub credential
 * bound to the MCP URL. Rotating credentials clears the cache (see
 * storeClaudeCodeCredentials), so this re-creates them against the new token.
 */
async function ensureResources(
  workspaceId: string,
  creds: ClaudeCodeCredentials,
  client: ClaudeManagedAgentsClient,
  model: string,
): Promise<{ agentId: string; environmentId: string; vaultId: string }> {
  let { agentId, environmentId, vaultId } = creds;
  const fresh: { agentId?: string; environmentId?: string; vaultId?: string } = {};

  if (!agentId) {
    const agent = await client.createAgent({
      name: 'FastOwl',
      model,
      system: AGENT_SYSTEM_PROMPT,
    });
    agentId = agent.id;
    fresh.agentId = agentId;
  }
  if (!environmentId) {
    const environment = await client.createEnvironment('fastowl');
    environmentId = environment.id;
    fresh.environmentId = environmentId;
  }
  if (!vaultId) {
    const vault = await client.createVault('FastOwl GitHub');
    vaultId = vault.id;
    await client.addVaultGitHubCredential(vaultId, creds.githubToken);
    fresh.vaultId = vaultId;
  }

  if (fresh.agentId || fresh.environmentId || fresh.vaultId) {
    await cacheClaudeResourceIds(workspaceId, fresh);
  }
  return { agentId, environmentId, vaultId };
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
