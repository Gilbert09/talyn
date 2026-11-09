import type { Workbench, WorkbenchReadiness } from '@talyn/shared';

import { groupByRepository } from '../../workflow/model';

export type ListItem = { type: 'section'; key: string; repo: string } | { type: 'row'; key: string; item: Workbench; last: boolean };

/** Rows grouped by repository with a section label per repository. Rows without one are not labelled. */
export function listItems(items: Workbench[]): ListItem[] {
  const groups = groupByRepository(items);
  return groups.flatMap((group) => [
    ...(group.repo ? [{ type: 'section' as const, key: `section:${group.repo}`, repo: group.repo }] : []),
    ...group.items.map((item, index) => ({ type: 'row' as const, key: item.id, item, last: index === group.items.length - 1 })),
  ]);
}

/** Only a real problem: the sandbox or this agent reports it cannot run. Null otherwise. */
export function readinessProblem(readiness: WorkbenchReadiness | undefined, agent: string): string | null {
  if (!readiness) return null;
  const agentReadiness = readiness.sandbox.agents[agent as keyof WorkbenchReadiness['sandbox']['agents']];
  if (agentReadiness && !agentReadiness.ok) return agentReadiness.reason?.message ?? 'This agent cannot run right now.';
  if (!readiness.sandbox.ok) return readiness.sandbox.reasons[0]?.message ?? 'Sessions cannot run right now.';
  return null;
}
