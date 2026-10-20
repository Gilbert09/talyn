import { loopsOffered, workflowsOffered, type Features } from '@talyn/shared';
import type { AutomationTab, PrTab } from '../stores/navigation';

export const PR_TAB_LABEL: Record<PrTab, string> = {
  my_prs: 'My PRs',
  // "Review requests", not "Reviews": PRs waiting on YOU, as against Talyn's own code review.
  reviews: 'Review requests',
  code_reviews: 'Code review',
  merge_queue: 'Merge queue',
  queue: 'Tasks',
};

export const AUTOMATION_TAB_LABEL: Record<AutomationTab, string> = {
  workflows: 'Workflows',
  loops: 'Loops',
};

/**
 * The automation tabs this account is offered, each through its own flag.
 * `features === null` is STILL LOADING and offers nothing, the same rule the
 * old nav used, so an item never flashes in and out on launch.
 */
export function offeredAutomationTabs(features: Features | null): AutomationTab[] {
  return [
    ...(workflowsOffered(features) ? (['workflows'] as const) : []),
    ...(loopsOffered(features) ? (['loops'] as const) : []),
  ];
}
