import { eq } from 'drizzle-orm';
import { getDbClient } from '../db/client.js';
import { users as usersTable, workspaces as workspacesTable } from '../db/schema.js';

/**
 * Who may use Workflows — user-defined PR automation.
 *
 * The same shape as `cloudProviders/fleetAccess.ts`, and for the same reasons.
 * Read that file's header for the full argument; the short version:
 *
 * # Fail closed, and not in the UI
 *
 * `WORKFLOWS_ALLOWED_EMAILS` unset means NOBODY, not everybody. Getting that
 * backwards would hand every workspace a feature that comments on, labels and
 * merges other people's pull requests — the blast radius here is larger than
 * the fleet's, because a workflow acts without anyone watching.
 *
 * And the gate is enforced where the work happens: at the routes, at
 * evaluation, and again on the task-dispatching actions. Hiding the nav item
 * from one client is not a gate; it is a decoration that the CLI, the MCP
 * server and plain `curl` all walk straight past. That is the billing
 * `clientGate` bug this codebase has already paid for once.
 *
 * # Two vars, not one
 *
 * `WORKFLOWS_ENABLED` turns the subsystem on for the BACKEND (whether the
 * engine is wired into the webhook worker at all); the allow-list decides which
 * workspaces it answers for. Turning the first on must not simultaneously turn
 * the feature on for everybody, which is exactly the split `FLEET_ENABLED` /
 * `FLEET_ALLOWED_EMAILS` makes.
 */

/** Parsed once per process. The env is not going to change under us. */
let cachedRaw: string | undefined;
let cachedSet: Set<string> | null = null;

function allowedEmails(): Set<string> {
  const raw = process.env.WORKFLOWS_ALLOWED_EMAILS ?? '';
  if (cachedSet && cachedRaw === raw) return cachedSet;
  cachedRaw = raw;
  cachedSet = new Set(
    raw
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean)
  );
  return cachedSet;
}

/** Exposed for tests, which need to change the env between cases. */
export function resetWorkflowsAccessCache(): void {
  cachedSet = null;
  cachedRaw = undefined;
}

/**
 * Whether the engine is wired in at all. Separate from the allow-list so a
 * deployment can carry the code without running it.
 */
export function workflowsSubsystemEnabled(): boolean {
  return process.env.WORKFLOWS_ENABLED === 'true';
}

/** True when this email may use workflows. Case-insensitive. */
export function isWorkflowsAllowedEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return allowedEmails().has(email.trim().toLowerCase());
}

/** Whether anyone at all is allowed — used only to explain a refusal. */
export function workflowsAllowlistIsEmpty(): boolean {
  return allowedEmails().size === 0;
}

/**
 * How many accounts are allow-listed. For the boot log — a COUNT and never the
 * addresses, because boot logs are shipped to a log service and an allow-list is
 * a list of real people's email addresses.
 */
export function workflowsAllowlistSize(): number {
  return allowedEmails().size;
}

/**
 * True when the workspace's owner may use workflows.
 *
 * Keyed on the OWNER rather than on whoever triggered the evaluation. A
 * workflow run has no user attached by construction — it is a webhook
 * delivery — and a gate that silently passes when it cannot identify a caller
 * is not a gate. The owner is the one identity every run provably has.
 */
export async function workspaceMayUseWorkflows(workspaceId: string): Promise<boolean> {
  if (!workflowsSubsystemEnabled()) return false;
  if (workflowsAllowlistIsEmpty()) return false; // fail closed, cheaply
  const rows = await getDbClient()
    .select({ email: usersTable.email })
    .from(workspacesTable)
    .innerJoin(usersTable, eq(usersTable.id, workspacesTable.ownerId))
    .where(eq(workspacesTable.id, workspaceId))
    .limit(1);
  return isWorkflowsAllowedEmail(rows[0]?.email);
}

/**
 * The message a refusal carries. Says which of the three reasons it is, because
 * reading a deployment that forgot its config as "working as intended" is an
 * hour of someone's evening.
 */
export function workflowsRefusalReason(): string {
  if (!workflowsSubsystemEnabled()) {
    return 'workflows are not enabled on this deployment (WORKFLOWS_ENABLED is not "true")';
  }
  return workflowsAllowlistIsEmpty()
    ? 'workflows have no allowlist configured (WORKFLOWS_ALLOWED_EMAILS is empty), so they are available to nobody'
    : 'this workspace is not on the workflows allowlist';
}
