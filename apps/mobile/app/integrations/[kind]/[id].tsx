import { integrationOffered, integrationRulesOffered, slackRulesOffered } from '@talyn/shared';
import { Redirect, Stack, useLocalSearchParams } from 'expo-router';

import { RuleDetailScreen } from '../../../src/features/integrations/RuleDetailScreen';
import { ruleIntegration } from '../../../src/features/integrations/model';
import { detailOptions, Loading, Page } from '../../../src/features/more/Page';
import { useFeatures } from '../../../src/lib/features';
import { DetailRoute } from '../../../src/navigation/DetailRoute';

export default function Screen() {
  const { kind, id } = useLocalSearchParams<{ kind: string; id: string }>();
  const features = useFeatures();
  if (kind !== 'github' && kind !== 'schedule' && kind !== 'slack' && kind !== 'webhook' && kind !== 'linear' && kind !== 'github_issues') return <Redirect href="/integrations" />;
  if (!features) return <Page><Loading /></Page>;
  if (!integrationRulesOffered(features, kind)
    && !(kind === 'slack' && integrationOffered(features, kind) && slackRulesOffered(features))) return <Redirect href="/integrations" />;
  if (typeof id !== 'string' || !id) return <Redirect href={{ pathname: '/integrations/[kind]', params: { kind } }} />;
  return <DetailRoute list={{ pathname: '/integrations/[kind]', params: { kind } }}>
    <Stack.Screen options={detailOptions('Automation')} />
    <RuleDetailScreen kind={kind === 'schedule' ? 'loop' : 'workflow'} integration={ruleIntegration(kind)} id={id} />
  </DetailRoute>;
}
