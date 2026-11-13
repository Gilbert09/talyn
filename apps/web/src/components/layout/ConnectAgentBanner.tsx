import { useEffect, useRef } from 'react';
import { Bot } from 'lucide-react';
import { Button } from '../ui/button';
import { useWorkspaceStore } from '../../stores/workspace';
import { trackEvent } from '../../lib/analytics';
import { sessionAgentConnected } from '../../lib/agentConnection';

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
  const openConnectAgent = useWorkspaceStore((s) => s.openConnectAgent);
  const viewed = useRef(false);

  // Without the fleet the answer depends on PostHog Code, so wait for its status too.
  const show = providersLoaded && (fleetOffered || posthogLoaded) && !canStartSessions;

  useEffect(() => {
    if (!show || viewed.current) return;
    viewed.current = true;
    trackEvent('connect_agent_banner_viewed', { fleet_offered: fleetOffered });
  }, [show, fleetOffered]);

  if (!show) return null;

  const body = fleetOffered
    ? 'Talyn shows your pull requests now. To start a session, fix a pull request or review code, connect your Claude or ChatGPT subscription.'
    : 'Talyn shows your pull requests now. To start a session, fix a pull request or review code, connect PostHog Code.';

  return (
    <div
      className="flex shrink-0 items-center gap-3 border-b border-border bg-muted px-4 py-2 text-sm text-muted-foreground"
      role="region"
      aria-label="Connect an agent"
    >
      <Bot className="h-4 w-4 shrink-0 text-foreground" />
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
