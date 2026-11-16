import { fleetReconnectMessage } from '@talyn/shared';
import { useEffect, useRef } from 'react';
import { Bot } from 'lucide-react';
import { Button } from '../ui/button';
import { useWorkspaceStore } from '../../stores/workspace';
import { trackEvent } from '../../lib/analytics';
import { sessionAgentConnected } from '../../lib/agentConnection';
import { usePostHogCodeOffered } from '../widgets/PostHogCodeRetirement';

/**
 * Tells a workspace with no session agent that it cannot start sessions yet.
 * Not dismissible: it goes away when an agent connects.
 */
export function ConnectAgentBanner() {
  // Primitive selectors only: zustand v5 loops on a selector that returns a new object.
  const providersLoaded = useWorkspaceStore((s) => s.cloudProviders !== null);
  const fleetOffered = useWorkspaceStore((s) =>
    Boolean(s.cloudProviders?.some((provider) => provider.type === 'selfhosted'))
  );
  const posthogLoaded = useWorkspaceStore((s) => s.posthogStatus !== null);
  const canStartSessions = useWorkspaceStore((s) =>
    sessionAgentConnected(s.cloudProviders, s.posthogStatus?.connected === true)
  );
  const reconnect = useWorkspaceStore((s) => fleetReconnectMessage(s.cloudProviders?.find((p) => p.type === 'selfhosted')));
  const openSettings = useWorkspaceStore((s) => s.openSettings);
  const openConnectAgent = useWorkspaceStore((s) => s.openConnectAgent);
  const posthogOffered = usePostHogCodeOffered();
  const viewed = useRef(false);

  // Without the fleet the answer depends on PostHog Code, so wait for its status too.
  const show = providersLoaded && (fleetOffered || posthogLoaded) && !canStartSessions;

  useEffect(() => {
    if (!show || viewed.current) return;
    viewed.current = true;
    trackEvent('connect_agent_banner_viewed', { fleet_offered: fleetOffered });
  }, [show, fleetOffered]);

  if (reconnect) return (
    <div role="region" aria-label="Reconnect needed" className="flex shrink-0 items-center gap-3 border-b border-border bg-muted px-4 py-2 text-sm">
      <span className="min-w-0 flex-1">{reconnect} Reconnect in Settings → Talyn Fleet.</span>
      <Button size="sm" onClick={() => openSettings('integrations')}>Reconnect</Button>
    </div>
  );
  if (!show) return null;

  // With PostHog Code retired, the copy names only Claude or Codex.
  const body = fleetOffered || !posthogOffered
    ? 'Talyn shows your pull requests now. To start a session, fix a pull request or review code, connect your Claude or ChatGPT subscription.'
    : 'Talyn shows your pull requests now. To start a session, fix a pull request or review code, connect PostHog Code.';

  return (
    <div
      className="flex shrink-0 items-center gap-3 border-b border-border bg-muted px-4 py-1.5 text-xs text-muted-foreground"
      role="region"
      aria-label="Connect an agent"
    >
      <Bot className="h-3.5 w-3.5 shrink-0 text-foreground" />
      <span className="min-w-0 flex-1">
        <span className="font-medium text-foreground">Connect an agent to start sessions.</span>{' '}
        {body}
      </span>
      <Button
        size="sm"
        className="shrink-0"
        onClick={() => {
          trackEvent('connect_agent_banner_clicked', { fleet_offered: fleetOffered });
          openConnectAgent(null, 'banner');
        }}
      >
        Connect an agent
      </Button>
    </div>
  );
}
