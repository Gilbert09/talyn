import type { CodeReviewPublic } from '@talyn/shared';
import { timeAgo } from '../../workbench/new/RecentWorkbenches';

/** Where the report-back sent the review's findings, in words. */
export function sessionReportText(
  report: NonNullable<CodeReviewPublic['sessionReport']>,
  workbenchId: string,
  now: number = Date.now(),
): string {
  const findings = `${report.findingCount} ${report.findingCount === 1 ? 'finding' : 'findings'}`;
  if (report.workbenchId !== workbenchId) return `Talyn sent ${findings} to another session.`;
  const ago = timeAgo(report.sentAt, now);
  return `Talyn sent ${findings} to this session${ago === 'now' ? ' just now' : ` ${ago} ago`}.`;
}
