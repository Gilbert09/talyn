import type { Href } from 'expo-router';

import type { AutomationKind } from '../automations/model';

export const spaceRoute = (id: string) => ({
  pathname: '/spaces/[id]', params: { id },
}) satisfies Href;

export const integrationRuleRoute = (kind: AutomationKind, id: string) => ({
  pathname: '/integrations/[kind]/[id]', params: { id, kind: kind === 'loop' ? 'schedule' : 'github' },
}) satisfies Href;
