import { loopsOffered, workflowsOffered, type BillingStatus, type Features } from '@talyn/shared';
import type { Href } from 'expo-router';

import type { Symbol } from '../../components/UI';
import { usageViewOf } from '../usage/model';

export type NavKey = 'spaces' | 'automations' | 'usage' | 'agents' | 'insights';
export type AutomationTab = 'workflows' | 'loops';

/** The feature answer (null while it loads) and the billing status (null or undefined while it loads). */
export type NavFeatures = Partial<Features> | null | undefined;
export type NavBilling = BillingStatus | null | undefined;

export interface NavItem {
  key: NavKey;
  label: string;
  route: Href;
  icon: Symbol;
  /** Whether web would draw this entry for the account. Nothing gated shows while its answer loads. */
  visible(features: NavFeatures, billing: NavBilling): boolean;
}

/** The automation segments web offers, in its order. Mirrors web `offeredAutomationTabs`. */
export function automationTabs(features: NavFeatures): AutomationTab[] {
  return [
    ...(workflowsOffered(features) ? ['workflows' as const] : []),
    ...(loopsOffered(features) ? ['loops' as const] : []),
  ];
}

export const NAV_ITEMS: readonly NavItem[] = [
  {
    key: 'spaces', label: 'Spaces', route: '/spaces',
    icon: { ios: 'square.grid.2x2', android: 'workspaces' },
    visible: (features) => features?.spaces === true,
  },
  {
    key: 'automations', label: 'Automations', route: '/automations',
    icon: { ios: 'arrow.triangle.2.circlepath', android: 'autorenew' },
    visible: (features) => automationTabs(features).length > 0,
  },
  {
    key: 'insights', label: 'Insights', route: '/insights',
    icon: { ios: 'chart.bar', android: 'bar_chart' },
    visible: () => true,
  },
  {
    key: 'usage', label: 'Usage', route: '/usage',
    icon: { ios: 'gauge.with.dots.needle.33percent', android: 'speed' },
    // Web draws its usage gauge only with usage billing on, so a free deployment shows nothing.
    visible: (_features, billing) => usageViewOf(billing) !== null,
  },
  {
    key: 'agents', label: 'Agents', route: '/agents',
    icon: { ios: 'cpu', android: 'memory' },
    visible: () => true,
  },
];

export function visibleNavItems(features: NavFeatures, billing: NavBilling): NavItem[] {
  return NAV_ITEMS.filter((item) => item.visible(features, billing));
}
