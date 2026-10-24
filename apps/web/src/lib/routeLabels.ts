import { loopsOffered, workflowsOffered, type Features } from '@talyn/shared';
import type { AutomationTab, PrTab } from '../stores/navigation';

export const PR_TAB_LABEL: Record<PrTab, string> = {
  my_prs: 'PRs',
  reviews: 'Review requests',
  code_reviews: 'Code review',
  merge_queue: 'Merge queue',
  queue: 'Tasks',
};

export const PR_PAGE_TABS: readonly PrTab[] = ['my_prs', 'code_reviews', 'queue'];

export const AUTOMATION_TAB_LABEL: Record<AutomationTab, string> = {
  workflows: 'Workflows',
  loops: 'Loops',
};

export function offeredAutomationTabs(features: Features | null): AutomationTab[] {
  return [
    ...(workflowsOffered(features) ? (['workflows'] as const) : []),
    ...(loopsOffered(features) ? (['loops'] as const) : []),
  ];
}
