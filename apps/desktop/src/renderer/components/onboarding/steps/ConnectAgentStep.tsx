import { useAgentConnections } from '../../../hooks/useAgentConnections';
import { ProviderConnectCards } from '../../panels/SettingsPanel';

/**
 * Onboarding step 2: connect the agent that will actually do the work.
 *
 * # Why this is a setup step now, when it deliberately was not
 *
 * The wizard used to leave the agent out on the argument that task buttons
 * render regardless and `ConnectAgentModal` prompts on the first dispatch. That
 * was right while the agent was metered API credits somebody else billed. It is
 * not right now: Talyn Fleet is the default compute, and it runs on the USER'S
 * OWN Claude or Codex subscription — so connecting it up front is what makes
 * the very first task run on their key rather than dead-end at a modal.
 *
 * Skippable, though, and that matters as much. The fleet card is drawn only
 * when the backend listed the fleet for this workspace, and hard-gating Next
 * would strand anyone it is switched off for on a step they cannot complete.
 * The modal stays as the fallback for anyone who skips.
 *
 * The cards are ordered by `CLOUD_PROVIDER_ORDER`, so the fleet is the first
 * thing on this screen. That IS the recommendation: it runs on the Claude or
 * Codex subscription the reader almost certainly already pays for, while
 * PostHog Code needs a PostHog account and bills metered credits on top.
 */
export function ConnectAgentStep() {
  // The cards read the store, and NOTHING fills it during onboarding:
  // `useSystemStatus` mounts in `MainLayout`, which renders only once the
  // wizard is done. So `cloudProviders` and `posthogStatus` were both null for
  // this step's whole life — read everywhere as "still loading, draw nothing" —
  // and the result was a screen inviting you to connect Claude or Codex to
  // Talyn Fleet with no fleet card on it, above a PostHog Code card that had
  // fallen back to its API-key form because `oauthAvailable` lives on the
  // status nobody had fetched.
  useAgentConnections();

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Talyn hands your PR work to a coding agent that runs on your own subscription — no
        second bill for tokens. Connect Claude or Codex to run on Talyn Fleet; one is enough,
        and you can add the other later in Settings.
      </p>
      <ProviderConnectCards />
    </div>
  );
}
