/**
 * The one switch that can stop Workflows.
 *
 * Workflows — user-defined PR automation — is a released feature available to
 * every workspace. This used to be an allow-list keyed on the workspace owner's
 * email (the `fleetAccess.ts` shape); that gate is gone.
 *
 * # Absent means ON, and that is the opposite of how it started
 *
 * While the feature was gated, `WORKFLOWS_ENABLED` unset meant "off for
 * everybody" — fail closed, because an unconfigured deployment must not hand out
 * a feature nobody decided to give it. Released, that reading is wrong in both
 * directions: every new deployment would ship with the feature dark, and every
 * developer's local backend would hide a page that exists, until somebody
 * remembered a line of env.
 *
 * So the polarity is inverted. This is now a KILL SWITCH: set
 * `WORKFLOWS_ENABLED=false` to stop the engine and hide the page, and leave it
 * unset the rest of the time. It exists because workflows comment on, label and
 * merge other people's pull requests, and a feature with that blast radius
 * should have one env var that stops it without a code change.
 *
 * # It is still enforced where the work happens
 *
 * At the routes, in the engine before any action runs, and on the
 * task-dispatching actions. Hiding the nav item from one client was never a
 * gate — the CLI, the MCP server and plain `curl` all walk straight past one.
 */

/**
 * Whether Workflows is available.
 *
 * Anything other than an explicit `false`/`0` is on, so a typo turns the feature
 * ON rather than silently off — the safer failure for a kill switch, because
 * "it stopped working and nobody knows why" is harder to notice than the thing
 * you were trying to stop.
 */
export function workflowsEnabled(): boolean {
  const raw = (process.env.WORKFLOWS_ENABLED ?? '').trim().toLowerCase();
  return raw !== 'false' && raw !== '0';
}

/**
 * Kept under its old name so the engine and the actions read the same way they
 * did when this was per-workspace. There is nothing workspace-specific left to
 * decide — every workspace gets the same answer — but the call sites are the
 * places the gate must be enforced, and renaming them would only obscure that.
 */
export function workspaceMayUseWorkflows(): boolean {
  return workflowsEnabled();
}

/** The message a refusal carries. One reason left: somebody pulled the switch. */
export function workflowsRefusalReason(): string {
  return 'workflows are switched off on this deployment (WORKFLOWS_ENABLED=false)';
}
