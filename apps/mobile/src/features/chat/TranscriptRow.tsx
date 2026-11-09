import type { Workbench } from '@talyn/shared';
import { memo } from 'react';

import { RowBoundary } from './RowBoundary';
import type { TranscriptRow as Row } from './transcript';
import { ToolGroupRow, ToolRow } from './ToolRow';
import { AgentText, EventLine, FailedLine, PermissionRow, PlanCard, QueuedBubble, SystemRow, ThinkingRow, UserBubble } from './TranscriptParts';

export interface PlanControls { busy: boolean; disabled: boolean; approve(): void; keepPlanning(): void }
interface Props { row: Row; now: number; workbench: Workbench; plan: PlanControls }

function RowView({ row, now, workbench, plan }: Props) {
  switch (row.kind) {
    case 'user': return <UserBubble text={row.text} timestamp={row.timestamp} attachments={row.attachments} files={row.files} workbenchId={workbench.id} now={now} />;
    case 'text': return <AgentText text={row.text} streaming={row.streaming} />;
    case 'thinking': return <ThinkingRow text={row.text} />;
    case 'tool': return <ToolRow tool={row.tool} partial={row.partial} />;
    case 'tool_group': return <ToolGroupRow group={row.group} partial={row.partial} />;
    case 'permission': return <PermissionRow row={row} />;
    case 'system': return <SystemRow row={row} workbench={workbench} />;
    case 'failed': return <FailedLine text={row.text} />;
    case 'stopped': return <EventLine icon={{ ios: 'stop.circle', android: 'stop_circle' }} text="Stopped" />;
    case 'queued': return <QueuedBubble text={row.text} fromTalyn={row.fromTalyn} />;
    case 'plan': return <PlanCard plan={row.plan} state={row.state} busy={plan.busy} disabled={plan.disabled}
      onApprove={plan.approve} onKeepPlanning={plan.keepPlanning} />;
    case 'broken': return <EventLine icon={{ ios: 'exclamationmark.triangle', android: 'warning' }} tone="warning" text="Part of this conversation could not be shown." />;
  }
}

/**
 * True when a row would draw the same. Only the props a row kind reads count, so the 30 second
 * clock and each workbench or chat update do not draw every row again.
 */
export function sameRowProps(prev: Props, next: Props): boolean {
  if (prev.row !== next.row) return false;
  const row = next.row;
  if (row.kind === 'user') return prev.now === next.now && prev.workbench.id === next.workbench.id;
  if (row.kind === 'system') return prev.workbench.id === next.workbench.id && prev.workbench.pullRequestId === next.workbench.pullRequestId &&
    prev.workbench.pr?.number === next.workbench.pr?.number;
  if (row.kind === 'plan') return prev.plan === next.plan;
  return true;
}

/** One conversation row. No author badges and no full timestamps: the shape says who wrote it. A row that fails to draw shows a notice. */
export const TranscriptRow = memo(function TranscriptRow(props: Props) {
  return <RowBoundary label="This message" resetKey={props.row}><RowView {...props} /></RowBoundary>;
}, sameRowProps);
