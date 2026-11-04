import { Fragment, useState, type ReactNode } from 'react';
import { ArrowLeft, Check } from 'lucide-react';
import { POSTHOG_LOGO } from '../../../assets/providers/logos';
import { useAgentConnections } from '../../../hooks/useAgentConnections';
import { FleetAgentMark } from '../../../lib/providerMeta';
import { cn } from '../../../lib/utils';
import { useWorkspaceStore } from '../../../stores/workspace';
import {
  cloudProviderOffered,
  FleetAgentRow,
  PostHogCodeCard,
} from '../../panels/SettingsPanel';
import { Card } from '../../ui/card';

type AgentChoice = 'claude' | 'codex' | 'posthog';

/** Connect a subscription or PostHog Code before starting a session. */
export function ConnectAgentStep() {
  // The cards read the store, and nothing else fills it during onboarding:
  // `useSystemStatus` mounts in `MainLayout`, which renders only once the
  // wizard is done.
  useAgentConnections();

  const cloudProviders = useWorkspaceStore((s) => s.cloudProviders);
  const posthogConnected = useWorkspaceStore((s) => s.posthogStatus?.connected === true);
  const [choice, setChoice] = useState<AgentChoice | null>(null);

  const fleet = (cloudProviders ?? []).find((p) => p.type === 'selfhosted');
  const fleetOffered = cloudProviderOffered(cloudProviders, 'selfhosted');
  const connectedAgents = fleet?.connectedAgents ?? [];
  const reauthAgents = fleet?.reauthAgents ?? [];

  if (choice === 'claude' || choice === 'codex') {
    return (
      <ChosenAgent onBack={() => setChoice(null)}>
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
      <ChosenAgent onBack={() => setChoice(null)}>
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
            detail: 'Use your Claude Pro or Max subscription.',
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
    {
      id: 'posthog',
      name: 'PostHog Code',
      detail: 'Use your PostHog account.',
      connected: posthogConnected,
      icon: <img src={POSTHOG_LOGO} alt="" className="w-5 h-5 object-contain" />,
    },
  ];

  return (
    <div className="space-y-4">
      <p className="text-[13px] text-muted-foreground">
        Use your Claude or ChatGPT subscription
      </p>
      <div className="space-y-2">
        {options.map((option) => (
          <Fragment key={option.id}>
            {option.id === 'posthog' && (
              <h3 className="pt-2 text-xs font-medium text-muted-foreground">Other options</h3>
            )}
            <button
              type="button"
              onClick={() => setChoice(option.id)}
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
          </Fragment>
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
