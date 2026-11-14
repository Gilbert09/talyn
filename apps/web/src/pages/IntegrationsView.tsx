import { Suspense, useEffect, useState } from 'react';
import { ArrowLeft, Check } from 'lucide-react';
import {
  INTEGRATION_CATALOG,
  integrationOffered,
  integrationsOffered,
  type IntegrationKind,
} from '@talyn/shared';
import { useWorkspaceStore } from '../stores/workspace';
import { useNavigationStore } from '../stores/navigation';
import { api } from '../lib/api';
import { lazyWithReload } from '../lib/lazyWithReload';
import { automationsShown, useAutomationFocus } from '../lib/automationFocus';
import { INTEGRATION_LOGOS } from '../assets/integrations/IntegrationLogos';
import { PageHeader } from '../components/ui/page-header';
import { Tabs, TabsList, TabsTrigger } from '../components/ui/tabs';
import { Badge } from '../components/ui/badge';
import { Card } from '../components/ui/card';
import { ScrollArea } from '../components/ui/scroll-area';
import { GithubConnectionCard, PostHogCodeCard } from '../components/panels/SettingsPanel';
import { SlackSettings } from '../components/panels/SlackSettings';
import { LinearSettings } from '../components/panels/LinearSettings';
import { TrunkSettingsCard } from '../components/panels/TrunkSettingsCard';
import { PrivateRoutesSettings } from '../components/settings/sections/PrivateRoutesSettings';
import {
  PostHogInboxConnectionNote,
  PostHogInboxConnectionSection,
} from '../components/panels/workflows/posthogInboxFields';

const WorkflowsPanel = lazyWithReload(() =>
  import('../components/panels/workflows/WorkflowsPanel').then((m) => ({ default: m.WorkflowsPanel }))
);
const LoopsPanel = lazyWithReload(() => import('../components/panels/loops/LoopsPanel').then((m) => ({ default: m.LoopsPanel })));

type ConnectionState = 'connected' | 'not_connected' | 'built_in' | 'unknown';

/** What each card says about its integration. Best effort: a failed read is `unknown`, never "not connected". */
function useConnectionStates(): Record<IntegrationKind, ConnectionState> {
  const features = useWorkspaceStore((s) => s.features);
  const workspaceId = useWorkspaceStore((s) => s.currentWorkspaceId);
  const githubStatus = useWorkspaceStore((s) => s.githubStatus);
  const cloudProviders = useWorkspaceStore((s) => s.cloudProviders);
  const [slack, setSlack] = useState<ConnectionState>('unknown');
  const [trunk, setTrunk] = useState<ConnectionState>('unknown');
  const [tailscale, setTailscale] = useState<ConnectionState>('unknown');
  const [linear, setLinear] = useState<ConnectionState>('unknown');

  useEffect(() => {
    let cancelled = false;
    const set = (fn: (s: ConnectionState) => void, s: ConnectionState) => {
      if (!cancelled) fn(s);
    };
    if (integrationOffered(features, 'slack')) {
      api.slack
        .getStatus()
        .then((st) => set(setSlack, st.installations.length > 0 ? 'connected' : 'not_connected'))
        .catch(() => set(setSlack, 'unknown'));
    }
    if (workspaceId && integrationOffered(features, 'trunk')) {
      api.trunk
        .getStatus(workspaceId)
        .then((st) => set(setTrunk, st.connected ? 'connected' : 'not_connected'))
        .catch(() => set(setTrunk, 'unknown'));
    }
    if (workspaceId && integrationOffered(features, 'linear')) {
      api.linear
        .getStatus(workspaceId)
        .then((st) => set(setLinear, st.connections.length > 0 ? 'connected' : 'not_connected'))
        .catch(() => set(setLinear, 'unknown'));
    }
    if (workspaceId && integrationOffered(features, 'tailscale')) {
      api.workspaces.privateConnector
        .get(workspaceId)
        .then((c) => set(setTailscale, c.status === 'connected' ? 'connected' : 'not_connected'))
        .catch(() => set(setTailscale, 'unknown'));
    }
    return () => {
      cancelled = true;
    };
  }, [features, workspaceId]);

  const posthogProvider = cloudProviders?.find((p) => p.type === 'posthog_code');
  const posthog: ConnectionState = posthogProvider ? (posthogProvider.connected ? 'connected' : 'not_connected') : 'unknown';
  const github: ConnectionState = githubStatus ? (githubStatus.connected ? 'connected' : 'not_connected') : 'unknown';
  return {
    github,
    // It uses the GitHub connection.
    github_issues: github,
    linear,
    slack,
    webhook: 'built_in',
    schedule: 'built_in',
    tailscale,
    posthog,
    // It uses the PostHog connection of the PostHog Code page.
    posthog_inbox: posthog,
    trunk,
  };
}

function StateBadge({ state }: { state: ConnectionState }) {
  if (state === 'connected') {
    return (
      <Badge variant="default" className="bg-green-600">
        <Check className="mr-1 h-3 w-3" />
        Connected
      </Badge>
    );
  }
  if (state === 'built_in') return <Badge variant="secondary">Built in</Badge>;
  if (state === 'not_connected') return <Badge variant="outline">Not connected</Badge>;
  return null;
}

/** Whether the current workspace has GitHub connected. GitHub Issues needs it. */
function useGithubConnected(): boolean {
  const githubStatus = useWorkspaceStore((s) => s.githubStatus);
  const workspace = useWorkspaceStore((s) => s.workspaces.find((w) => w.id === s.currentWorkspaceId));
  return githubStatus?.connected ?? Boolean(workspace?.integrations?.github);
}

function IntegrationsCatalog() {
  const features = useWorkspaceStore((s) => s.features);
  const navigate = useNavigationStore((s) => s.navigate);
  const states = useConnectionStates();
  const githubConnected = useGithubConnected();
  const kinds = integrationsOffered(features).filter((kind) => kind !== 'github_issues' || githubConnected);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader title="Integrations" />
      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto max-w-4xl p-6">
          <p className="mb-4 text-sm text-muted-foreground">
            Connect the places work comes from. Each integration holds its connection and the automations that start work.
          </p>
          <div className="grid gap-3 sm:grid-cols-2" data-attr="integrations-catalog">
            {kinds.map((kind) => {
              const info = INTEGRATION_CATALOG[kind];
              const Logo = INTEGRATION_LOGOS[info.icon];
              const state = states[kind];
              return (
                <button
                  key={kind}
                  type="button"
                  data-attr={`integration-card-${kind}`}
                  onClick={() => navigate({ view: 'integrations', kind })}
                  className="text-left"
                >
                  <Card className="h-full p-4 transition-colors hover:bg-accent/40">
                    <div className="flex items-start gap-3">
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-secondary">
                        <Logo className="h-6 w-6" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <h2 className="font-medium">{info.name}</h2>
                          <StateBadge state={state} />
                        </div>
                        <p className="mt-1 text-sm text-muted-foreground">{info.description}</p>
                      </div>
                    </div>
                  </Card>
                </button>
              );
            })}
          </div>
        </div>
      </ScrollArea>
    </div>
  );
}

function ConnectionSection({ kind }: { kind: IntegrationKind }) {
  return (
    <ScrollArea className="h-full">
      <div className="max-w-2xl p-6">
        {kind === 'github' && <GithubConnectionCard />}
        {kind === 'slack' && <SlackSettings />}
        {kind === 'linear' && <LinearSettings />}
        {kind === 'tailscale' && <PrivateRoutesSettings />}
        {kind === 'posthog' && <PostHogCodeCard />}
        {kind === 'posthog_inbox' && <PostHogInboxConnectionSection />}
        {kind === 'trunk' && <TrunkSettingsCard />}
      </div>
    </ScrollArea>
  );
}

type Section = 'connection' | 'rules';

function GithubIssuesConnectionNote() {
  const navigate = useNavigationStore((s) => s.navigate);
  const connected = useGithubConnected();
  return (
    <p className="border-b px-6 py-2 text-xs text-muted-foreground" data-attr="github-issues-connection">
      Uses your GitHub connection.{' '}
      {!connected && (
        <button
          type="button"
          className="underline hover:text-foreground"
          onClick={() => navigate({ view: 'integrations', kind: 'github' })}
        >
          Connect GitHub
        </button>
      )}
    </p>
  );
}

function IntegrationPage({ kind }: { kind: IntegrationKind }) {
  const features = useWorkspaceStore((s) => s.features);
  const navigate = useNavigationStore((s) => s.navigate);
  const info = INTEGRATION_CATALOG[kind];
  const offered = integrationOffered(features, kind);
  const hasRules = automationsShown(features, kind);
  const hasConnection = !info.builtIn;
  // Back from the Linear sign-in: open the tab that shows the result.
  const [chosen, setChosen] = useState<Section | null>(() =>
    kind === 'linear' && new URLSearchParams(window.location.search).has('linear') ? 'connection' : null
  );
  // The palette opened one of this page's automations: show the Automations tab.
  const focusKind = useAutomationFocus((s) => s.target?.kind);
  useEffect(() => {
    if (focusKind === kind) setChosen('rules');
  }, [focusKind, kind]);
  const section: Section = chosen && (chosen === 'rules' ? hasRules : hasConnection) ? chosen : hasRules ? 'rules' : 'connection';

  useEffect(() => {
    if (features !== null && !offered) navigate({ view: 'integrations' }, { replace: true });
  }, [features, offered, navigate]);

  if (!offered) return null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        title={info.name}
        icon={
          <button
            type="button"
            aria-label="Back to Integrations"
            data-attr="integrations-back"
            className="rounded p-1 text-muted-foreground hover:text-foreground"
            onClick={() => navigate({ view: 'integrations' })}
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
        }
        className="gap-4"
      >
        {hasRules && hasConnection && (
          <Tabs value={section} onValueChange={(next) => setChosen(next as Section)}>
            <TabsList aria-label={`${info.name} sections`}>
              <TabsTrigger value="rules" data-attr={`integration-tab-rules-${kind}`}>
                Automations
              </TabsTrigger>
              <TabsTrigger value="connection" data-attr={`integration-tab-connection-${kind}`}>
                Connection
              </TabsTrigger>
            </TabsList>
          </Tabs>
        )}
      </PageHeader>
      <div className="min-h-0 flex-1 overflow-hidden">
        <Suspense fallback={null}>
          {section === 'connection' && hasConnection && <ConnectionSection kind={kind} />}
          {section === 'rules' && kind === 'github' && <WorkflowsPanel integration="github" />}
          {section === 'rules' && kind === 'slack' && hasRules && <WorkflowsPanel integration="slack" />}
          {section === 'rules' && kind === 'webhook' && hasRules && <WorkflowsPanel integration="webhook" />}
          {section === 'rules' && kind === 'linear' && hasRules && <WorkflowsPanel integration="linear" />}
          {section === 'rules' && kind === 'github_issues' && hasRules && (
            <div className="flex h-full flex-col">
              <GithubIssuesConnectionNote />
              <div className="min-h-0 flex-1">
                <WorkflowsPanel integration="github_issues" />
              </div>
            </div>
          )}
          {section === 'rules' && kind === 'posthog_inbox' && hasRules && (
            <div className="flex h-full flex-col">
              <PostHogInboxConnectionNote />
              <div className="min-h-0 flex-1">
                <WorkflowsPanel integration="posthog_inbox" />
              </div>
            </div>
          )}
          {section === 'rules' && kind === 'schedule' && <LoopsPanel />}
        </Suspense>
      </div>
    </div>
  );
}

export function IntegrationsView({ kind }: { kind: IntegrationKind | null }) {
  return kind ? <IntegrationPage kind={kind} /> : <IntegrationsCatalog />;
}
