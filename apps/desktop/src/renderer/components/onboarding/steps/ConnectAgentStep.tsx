import { useState, type ReactNode } from 'react';
import { ArrowLeft, Check, Laptop } from 'lucide-react';
import type { WorkbenchAgent, WorkbenchLocalReadiness } from '@talyn/shared';
import { POSTHOG_LOGO } from '../../../assets/providers/logos';
import { useAgentConnections } from '../../../hooks/useAgentConnections';
import { FleetAgentMark } from '../../../lib/providerMeta';
import { trackEvent } from '../../../lib/analytics';
import { cn } from '../../../lib/utils';
import { useWorkspaceStore } from '../../../stores/workspace';
import {
  cloudProviderOffered,
  FleetAgentRow,
  PostHogCodeCard,
} from '../../panels/SettingsPanel';
import { Card } from '../../ui/card';
import { usePostHogCodeOffered } from '../../widgets/PostHogCodeRetirement';
import { LocalAgentStatus } from './LocalAgentStatus';

type AgentChoice = 'claude' | 'codex' | 'posthog' | 'local';

/** Where the first session runs: a connected subscription on the fleet, or the CLI on this computer. */
export type AgentMode = 'cloud' | 'local';

const LOCAL_AGENT_NAMES: Record<WorkbenchAgent, string> = { claude: 'Claude Code', codex: 'Codex' };

interface ConnectAgentStepProps {
  /** The `onboardingLocalAgent` flag: offer the agent CLI on this computer. */
  localOffered?: boolean;
  mode?: AgentMode;
  onModeChange?: (mode: AgentMode) => void;
  /** The installed CLI a local session will use. Null when none is usable. */
  localAgent?: WorkbenchAgent | null;
  /** Why no local agent is usable, once this computer was checked. */
  localReason?: string;
  onLocalReadiness?: (local: WorkbenchLocalReadiness) => void;
}

/** Connect a subscription (or PostHog Code, where it is still offered) before starting a session. */
export function ConnectAgentStep({
  localOffered = false,
  mode = 'cloud',
  onModeChange,
  localAgent = null,
  localReason,
  onLocalReadiness,
}: ConnectAgentStepProps = {}) {
  // The cards read the store, and nothing else fills it during onboarding:
  // `useSystemStatus` mounts in `MainLayout`, which renders only once the
  // wizard is done.
  useAgentConnections();

  const cloudProviders = useWorkspaceStore((s) => s.cloudProviders);
  const posthogConnected = useWorkspaceStore((s) => s.posthogStatus?.connected === true);
  const [choice, setChoice] = useState<AgentChoice | null>(localOffered && mode === 'local' ? 'local' : null);
  const posthogOffered = usePostHogCodeOffered();

  // Until the provider list arrives the fleet is unknown, so draw nothing
  // rather than flash PostHog Code at a workspace that turns out to have the fleet.
  if (cloudProviders === null) {
    return <p className="text-[13px] text-muted-foreground">Checking your agents...</p>;
  }

  const fleet = (cloudProviders ?? []).find((p) => p.type === 'selfhosted');
  const fleetOffered = cloudProviderOffered(cloudProviders, 'selfhosted');
  const connectedAgents = fleet?.connectedAgents ?? [];
  const reauthAgents = fleet?.reauthAgents ?? [];

  const chooseAgain = () => {
    setChoice(null);
    onModeChange?.('cloud');
  };

  if (choice === 'local') {
    return (
      <ChosenAgent onBack={chooseAgain}>
        <LocalAgentStatus recheck onReadiness={onLocalReadiness} />
        <p className="text-[13px] text-muted-foreground" role="status">
          {localAgent
            ? `Your sessions will use ${LOCAL_AGENT_NAMES[localAgent]} on this computer.`
            : localReason
              ? `${localReason}. Install Claude Code or Codex, then press Re-check.`
              : 'Checking this computer…'}
        </p>
      </ChosenAgent>
    );
  }
  if (choice === 'claude' || choice === 'codex') {
    return (
      <ChosenAgent onBack={chooseAgain}>
        <Card className="p-4">
          <FleetAgentRow
            agent={choice}
            connected={connectedAgents.includes(choice)}
            needsReauth={reauthAgents.includes(choice)}
          />
        </Card>
      </ChosenAgent>
    );
  }
  if (choice === 'posthog') {
    return (
      <ChosenAgent onBack={chooseAgain}>
        <PostHogCodeCard />
      </ChosenAgent>
    );
  }

  const options: Array<{
    id: AgentChoice;
    name: string;
    detail: string;
    connected: boolean;
    icon: ReactNode;
  }> = [
    ...(fleetOffered
      ? [
          {
            id: 'claude' as const,
            name: 'Claude',
            detail: 'Use your Claude Pro or Max subscription, or an Anthropic API key.',
            connected: connectedAgents.includes('claude'),
            icon: <FleetAgentMark agent="claude" className="w-5 h-5" />,
          },
          {
            id: 'codex' as const,
            name: 'Codex',
            detail: 'Use your ChatGPT subscription.',
            connected: connectedAgents.includes('codex'),
            icon: <FleetAgentMark agent="codex" className="w-5 h-5" />,
          },
        ]
      : []),
    // PostHog Code is offered here only when the fleet is not. A session runs on
    // the fleet, so a fleet workspace that picked PostHog Code here could never
    // continue. It stays in Settings for everyone.
    ...(fleetOffered || !posthogOffered
      ? []
      : [
          {
            id: 'posthog' as const,
            name: 'PostHog Code',
            detail: 'Use your PostHog account.',
            connected: posthogConnected,
            icon: <img src={POSTHOG_LOGO} alt="" className="w-5 h-5 object-contain" />,
          },
        ]),
    ...(localOffered
      ? [
          {
            id: 'local' as const,
            name: 'Claude Code or Codex on this computer',
            detail: 'Run sessions in a git worktree on this computer with the CLI you already use. No sign-in, no box-hours.',
            connected: false,
            icon: <Laptop className="w-5 h-5 text-muted-foreground" />,
          },
        ]
      : []),
  ];

  return (
    <div className="space-y-4">
      <p className="text-[13px] text-muted-foreground">
        {fleetOffered
          ? 'Use your Claude or ChatGPT subscription'
          : posthogOffered
            ? 'Connect PostHog Code to run your sessions.'
            : localOffered
              ? 'Run sessions with the Claude Code or Codex CLI on this computer.'
              : 'Sessions run on Claude or Codex. Neither is available for this workspace yet, so skip this step for now.'}
      </p>
      <div className="space-y-2">
        {options.map((option) => (
          <button
              key={option.id}
              type="button"
              onClick={() => {
                trackEvent('onboarding_agent_option_selected', { agent: option.id });
                setChoice(option.id);
                onModeChange?.(option.id === 'local' ? 'local' : 'cloud');
              }}
              className={cn(
                'w-full flex items-center gap-3 rounded-lg border p-4 text-left transition-colors',
                'hover:border-primary/60 hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
              )}
            >
              <div className="w-10 h-10 rounded-lg bg-secondary flex items-center justify-center shrink-0">
                {option.icon}
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-medium">{option.name}</p>
                <p className="text-[13px] text-muted-foreground">{option.detail}</p>
              </div>
              {option.connected && (
                <span className="flex items-center gap-1 text-[13px] text-green-600">
                  <Check className="w-4 h-4" />
                  Connected
                </span>
              )}
            </button>
        ))}
      </div>
    </div>
  );
}

function ChosenAgent({ onBack, children }: { onBack: () => void; children: ReactNode }) {
  return (
    <div className="space-y-4">
      <button
        type="button"
        onClick={onBack}
        className="flex items-center gap-1 text-[13px] text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="w-4 h-4" />
        Choose a different agent
      </button>
      {children}
    </div>
  );
}
