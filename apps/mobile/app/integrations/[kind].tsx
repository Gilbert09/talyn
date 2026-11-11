import { INTEGRATION_CATALOG, integrationOffered, integrationRulesOffered, isIntegrationKind, slackRulesOffered } from '@talyn/shared';
import { Redirect, Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';

import { Segmented } from '../../src/components/UI';
import { RulesScreen } from '../../src/features/integrations/RulesScreen';
import { IntegrationsScreen } from '../../src/features/integrations/IntegrationsScreen';
import { GitHubSettingsScreen } from '../../src/features/settings/GitHubSettingsScreen';
import { SlackScreen } from '../../src/features/slack/SlackScreen';
import { PrivateRoutesScreen } from '../../src/features/privateRoutes/PrivateRoutesScreen';
import { detailOptions, Loading, Page } from '../../src/features/more/Page';
import { useFeatures } from '../../src/lib/features';
import { DetailRoute } from '../../src/navigation/DetailRoute';

type Section = 'rules' | 'connection';

export default function Screen() {
  const { kind: rawKind } = useLocalSearchParams<{ kind: string }>();
  const features = useFeatures();
  const [chosen, setChosen] = useState<Section | null>(null);
  const kind = typeof rawKind === 'string' && isIntegrationKind(rawKind) ? rawKind : null;
  if (!kind) return <Redirect href="/integrations" />;
  if (!features) return <Page><Loading /></Page>;
  if (!integrationOffered(features, kind)) return <Redirect href="/integrations" />;

  const rules = integrationRulesOffered(features, kind)
    || (kind === 'slack' && integrationOffered(features, kind) && slackRulesOffered(features));
  const connection = !INTEGRATION_CATALOG[kind].builtIn;
  const section = chosen && (chosen === 'rules' ? rules : connection) ? chosen : rules ? 'rules' : 'connection';
  return <DetailRoute list="/integrations">
    <Stack.Screen options={detailOptions(INTEGRATION_CATALOG[kind].name)} />
    <View style={{ flex: 1 }}>
      {rules && connection ? <View style={{ paddingHorizontal: 16, paddingTop: 12 }}><Segmented<Section> accessibilityLabel={`${INTEGRATION_CATALOG[kind].name} sections`} value={section}
        onChange={setChosen} options={[{ value: 'rules', label: 'Automations' }, { value: 'connection', label: 'Connection' }]} /></View> : null}
      {section === 'rules' ? <RulesScreen kind={kind === 'schedule' ? 'loop' : 'workflow'} integration={kind === 'slack' ? 'slack' : 'github'} /> : null}
      {section === 'connection' && kind === 'github' ? <GitHubSettingsScreen /> : null}
      {section === 'connection' && kind === 'slack' ? <SlackScreen /> : null}
      {section === 'connection' && kind === 'tailscale' ? <PrivateRoutesScreen /> : null}
      {section === 'connection' && (kind === 'posthog' || kind === 'trunk') ? <IntegrationsScreen kind={kind} /> : null}
    </View>
  </DetailRoute>;
}
