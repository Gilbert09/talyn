import type { Href } from 'expo-router';
import type { WorkflowIntegration } from '@talyn/shared';

import type { AutomationKind } from '../automations/model';

export const spaceRoute = (id: string) => ({
  pathname: '/spaces/[id]', params: { id },
}) satisfies Href;

export const integrationRuleRoute = (kind: AutomationKind, id: string, integration: WorkflowIntegration = 'github') => ({
  pathname: '/integrations/[kind]/[id]', params: { id, kind: kind === 'loop' ? 'schedule' : integration },
}) satisfies Href;
