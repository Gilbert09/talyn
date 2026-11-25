/**
 * Not exposed:
 * - Account wipe: irreversible. Workspace create/delete: manage workspace lifecycle in the app.
 * - MCP token mint/revoke, cloud credentials, Claude sign-in, GitHub connect/disconnect:
 *   secrets must not pass through a transcript.
 * - admin/*, debug/*, fleet/*: operator actions.
 * - teams/*, billing checkout/portal: account and payment actions belong in the app.
 * - Review-ranking telemetry and poll/view/focus hints: UI-only signals.
 * - Session terminal, port previews, checkpoint restore and instruction files: interactive
 *   or editor features. Local sessions are refused because their turns run in the desktop app.
 */
import type { AccountFeatureFlagKey } from '@talyn/shared';
import type { SessionMcpBinding } from '../../services/sessionMcpToken.js';
import { ACCOUNT } from './account.js';
import { BACKGROUND } from './background.js';
import { CODEREVIEW } from './codeReview.js';
import { IMAGES } from './images.js';
import { LOOPS } from './loops.js';
import { MCPSERVERS } from './mcpServers.js';
import { MEMORY } from './memory.js';
import { MERGEQUEUE } from './mergeQueue.js';
import { PULLREQUESTS } from './pullRequests.js';
import { QUESTIONS } from './questions.js';
import { REPOSITORIES } from './repositories.js';
import { SESSIONS } from './sessions.js';
import { SLACK } from './slack.js';
import { SPACES } from './spaces.js';
import { SKILLS } from './skills.js';
import { TASKS } from './tasks.js';
import { WORKFLOWS } from './workflows.js';
import { WORKSPACES } from './workspaces.js';

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Hints let clients identify reads and destructive actions. */
  annotations: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  /** Hide the tool when this account feature is off. Routes check access independently. */
  feature?: AccountFeatureFlagKey;
  /** Text, or MCP content for a result that is more than text (an image). */
  handler: (ownerId: string, args: Record<string, unknown>, ctx?: McpCallContext) => Promise<string | McpToolResult>;
}

export type McpToolContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

/** A tool result that the server sends unchanged. */
export interface McpToolResult {
  content: McpToolContent[];
}

/** Who is calling, beyond the owner. */
export interface McpCallContext {
  /** Set when the caller is a session sandbox's own token (`talyn_mcs_`). */
  session?: SessionMcpBinding;
}

export const TOOLS: McpToolDefinition[] = [
  ...WORKSPACES,
  ...REPOSITORIES,
  ...PULLREQUESTS,
  ...MERGEQUEUE,
  ...CODEREVIEW,
  ...TASKS,
  ...SESSIONS,
  ...BACKGROUND,
  ...IMAGES,
  ...QUESTIONS,
  ...SPACES,
  ...MEMORY,
  ...SKILLS,
  ...WORKFLOWS,
  ...LOOPS,
  ...SLACK,
  ...MCPSERVERS,
  ...ACCOUNT,
];
