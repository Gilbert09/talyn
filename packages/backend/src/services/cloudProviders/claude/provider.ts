import { readCloudTaskMeta, type Environment, type Task } from '@fastowl/shared';
import { ClaudeManagedAgentsClient } from '../../claudeCode/client.js';
import {
  getClaudeCodeCredentials,
  getClaudeCodeClient,
  storeClaudeCodeCredentials,
  removeClaudeCodeCredentials,
} from '../../claudeCode/credentials.js';
import { dispatchTaskToClaudeCode } from '../../claudeCode/executor.js';
import { claudeCodePoller } from '../../claudeCode/poller.js';
import type { CloudTaskProvider, CloudTaskRow, DispatchResult } from '../types.js';

interface ClaudeCredInput {
  anthropicApiKey?: string;
  githubToken?: string;
}

/**
 * Claude Code provider — delegates to Anthropic's Managed Agents API (the
 * hosted "Claude Code on the web" surface). The agent runs in Anthropic's
 * sandbox and opens a PR via the GitHub MCP; the claudeCode/* modules do the
 * dispatch, polling, and transcript ingestion behind this CloudTaskProvider seam.
 */
export const claudeCodeProvider: CloudTaskProvider = {
  type: 'claude_routine',
  displayName: 'Claude Code',
  capabilities: { model: true },

  async validateCredentials(workspaceId, input) {
    const { anthropicApiKey, githubToken } = (input ?? {}) as ClaudeCredInput;
    if (!anthropicApiKey || !githubToken) {
      return { ok: false, error: 'anthropicApiKey and githubToken are required' };
    }
    try {
      await new ClaudeManagedAgentsClient(anthropicApiKey).ping();
    } catch (err) {
      return {
        ok: false,
        error: `Could not authenticate with Anthropic: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }
    await storeClaudeCodeCredentials(workspaceId, { anthropicApiKey, githubToken });
    return { ok: true };
  },

  async hasCredentials(workspaceId) {
    return Boolean(await getClaudeCodeCredentials(workspaceId));
  },

  async testConnection(workspaceId) {
    const client = await getClaudeCodeClient(workspaceId);
    if (!client) return { connected: false, error: 'Not configured' };
    try {
      await client.ping();
      return { connected: true };
    } catch (err) {
      return { connected: false, error: err instanceof Error ? err.message : String(err) };
    }
  },

  async removeCredentials(workspaceId) {
    await removeClaudeCodeCredentials(workspaceId);
  },

  dispatch(task: Task, env: Environment): Promise<DispatchResult> {
    return dispatchTaskToClaudeCode(task, env);
  },

  reconcile(taskRow: CloudTaskRow): Promise<void> {
    return claudeCodePoller.reconcileTask(taskRow);
  },

  stopStreaming(taskId: string): void {
    claudeCodePoller.stopStreaming(taskId);
  },

  async cancel(task: Task): Promise<void> {
    const cloud = readCloudTaskMeta(task);
    if (!cloud?.remoteTaskId) return; // no session started — nothing to cancel.
    const client = await getClaudeCodeClient(task.workspaceId);
    if (!client) throw new Error('Claude Code is not configured for this workspace.');
    // Interrupt the in-flight turn, then delete the session to stop the runtime
    // meter. Best-effort: a session that already finished just 404s.
    try {
      await client.interruptSession(cloud.remoteTaskId);
    } catch {
      /* may already be idle */
    }
    await client.deleteSession(cloud.remoteTaskId);
  },
};
