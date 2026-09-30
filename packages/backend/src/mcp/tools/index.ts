/**
 * Not exposed:
 * - Account wipe: irreversible. Workspace create/delete: manage workspace lifecycle in the app.
 * - MCP token mint/revoke, cloud credentials, Claude sign-in, GitHub connect/disconnect:
 *   secrets must not pass through a transcript.
 * - admin/*, debug/*, fleet/*: operator actions.
 * - teams/*, billing checkout/portal: account and payment actions belong in the app.
 * - Review-ranking telemetry and poll/view/focus hints: UI-only signals.
 */
import type { AccountFeatureFlagKey } from '@talyn/shared';
import { ACCOUNT } from './account.js';
import { CODEREVIEW } from './codeReview.js';
import { LOOPS } from './loops.js';
import { MCPSERVERS } from './mcpServers.js';
import { MERGEQUEUE } from './mergeQueue.js';
import { PULLREQUESTS } from './pullRequests.js';
import { REPOSITORIES } from './repositories.js';
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
  handler: (ownerId: string, args: Record<string, unknown>) => Promise<string>;
}

export const TOOLS: McpToolDefinition[] = [
  ...WORKSPACES,
  ...REPOSITORIES,
  ...PULLREQUESTS,
  ...MERGEQUEUE,
  ...CODEREVIEW,
  ...TASKS,
  ...SKILLS,
  ...WORKFLOWS,
  ...LOOPS,
  ...MCPSERVERS,
  ...ACCOUNT,
];
