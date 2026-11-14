import type { IntegrationKind, Workspace } from '@talyn/shared';
import { INTEGRATION_CATALOG, integrationOffered, integrationRulesOffered, isIntegrationKind, slackRulesOffered } from '@talyn/shared';
import { Redirect, Stack, useLocalSearchParams } from 'expo-router';
import { useState, type ReactNode } from 'react';
import { View } from 'react-native';

import { Segmented } from '../../src/components/UI';
import { LinearScreen } from '../../src/features/integrations/LinearScreen';
import { githubIssuesAvailable, ruleIntegration } from '../../src/features/integrations/model';
import { RulesScreen } from '../../src/features/integrations/RulesScreen';
import { IntegrationsScreen } from '../../src/features/integrations/IntegrationsScreen';
import { GitHubSettingsScreen } from '../../src/features/settings/GitHubSettingsScreen';
import { SlackScreen } from '../../src/features/slack/SlackScreen';
import { PrivateRoutesScreen } from '../../src/features/privateRoutes/PrivateRoutesScreen';
import { detailOptions, Loading, Page } from '../../src/features/more/Page';
import { useWorkspace } from '../../src/auth/AuthProvider';
import { useResource } from '../../src/workflow/hooks';
import { useFeatures } from '../../src/lib/features';
import { DetailRoute } from '../../src/navigation/DetailRoute';

type Section = 'rules' | 'connection';

/** GitHub Issues needs the GitHub connection; without it the card is hidden and the page goes back to the list. */
function GithubIssuesGate({ children }: { children: ReactNode }) {
  const workspaceId = useWorkspace().selected;
  const workspace = useResource<Workspace>('workspace', '', Boolean(workspaceId));
  if (workspace.data?.id !== workspaceId) return <Page><Loading /></Page>;
  if (!githubIssuesAvailable(Boolean(workspace.data.integrations?.github?.enabled))) return <Redirect href="/integrations" />;
  return <>{children}</>;
}

export default function Screen() {
  const { kind: rawKind } = useLocalSearchParams<{ kind: string }>();
  const features = useFeatures();
  const kind = typeof rawKind === 'string' && isIntegrationKind(rawKind) ? rawKind : null;
  if (!kind) return <Redirect href="/integrations" />;
  if (!features) return <Page><Loading /></Page>;
  if (!integrationOffered(features, kind)) return <Redirect href="/integrations" />;

  if (kind === 'github_issues') return <GithubIssuesGate><Detail kind={kind} features={features} /></GithubIssuesGate>;
  return <Detail kind={kind} features={features} />;
}

function Detail({ kind, features }: { kind: IntegrationKind; features: NonNullable<ReturnType<typeof useFeatures>> }) {
  const [chosen, setChosen] = useState<Section | null>(null);
  const rules = integrationRulesOffered(features, kind)
    || (kind === 'slack' && integrationOffered(features, kind) && slackRulesOffered(features));
  const connection = !INTEGRATION_CATALOG[kind].builtIn;
  const section = chosen && (chosen === 'rules' ? rules : connection) ? chosen : rules ? 'rules' : 'connection';
  return <DetailRoute list="/integrations">
    <Stack.Screen options={detailOptions(INTEGRATION_CATALOG[kind].name)} />
    <View style={{ flex: 1 }}>
      {rules && connection ? <View style={{ paddingHorizontal: 16, paddingTop: 12 }}><Segmented<Section> accessibilityLabel={`${INTEGRATION_CATALOG[kind].name} sections`} value={section}
        onChange={setChosen} options={[{ value: 'rules', label: 'Automations' }, { value: 'connection', label: 'Connection' }]} /></View> : null}
      {section === 'rules' ? <RulesScreen kind={kind === 'schedule' ? 'loop' : 'workflow'} integration={ruleIntegration(kind)} /> : null}
      {section === 'connection' && kind === 'linear' ? <LinearScreen /> : null}
      {section === 'connection' && kind === 'github' ? <GitHubSettingsScreen /> : null}
      {section === 'connection' && kind === 'slack' ? <SlackScreen /> : null}
      {section === 'connection' && kind === 'tailscale' ? <PrivateRoutesScreen /> : null}
      {section === 'connection' && (kind === 'posthog' || kind === 'trunk') ? <IntegrationsScreen kind={kind} /> : null}
      {section === 'connection' && kind === 'posthog_inbox' ? <IntegrationsScreen kind="posthog" /> : null}
    </View>
  </DetailRoute>;
}
