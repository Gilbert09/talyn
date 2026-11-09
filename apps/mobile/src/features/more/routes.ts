import type { Href } from 'expo-router';

import type { AutomationKind } from '../automations/model';

export const spaceRoute = (id: string) => ({
  pathname: '/spaces/[id]', params: { id },
}) satisfies Href;

export const automationRoute = (kind: AutomationKind, id: string) => ({
  pathname: '/automations/[id]', params: { id, kind },
}) satisfies Href;
