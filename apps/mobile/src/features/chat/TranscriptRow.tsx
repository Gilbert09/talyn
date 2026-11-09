import type { Workbench } from '@talyn/shared';
import { memo } from 'react';

import type { TranscriptRow as Row } from './transcript';
import { ToolGroupRow, ToolRow } from './ToolRow';
import { AgentText, EventLine, FailedLine, PermissionRow, PlanCard, QueuedBubble, SystemRow, ThinkingRow, UserBubble } from './TranscriptParts';

export interface PlanControls { busy: boolean; disabled: boolean; approve(): void; keepPlanning(): void }

/** One conversation row. No author badges and no full timestamps: the shape says who wrote it. */
export const TranscriptRow = memo(function TranscriptRow({ row, now, workbench, plan }: { row: Row; now: number; workbench: Workbench; plan: PlanControls }) {
  switch (row.kind) {
    case 'user': return <UserBubble text={row.text} timestamp={row.timestamp} attachments={row.attachments} files={row.files} workbenchId={workbench.id} now={now} />;
    case 'text': return <AgentText text={row.text} streaming={row.streaming} />;
    case 'thinking': return <ThinkingRow text={row.text} />;
    case 'tool': return <ToolRow tool={row.tool} />;
    case 'tool_group': return <ToolGroupRow group={row.group} />;
    case 'permission': return <PermissionRow row={row} />;
    case 'system': return <SystemRow row={row} workbench={workbench} />;
    case 'failed': return <FailedLine text={row.text} />;
    case 'stopped': return <EventLine icon={{ ios: 'stop.circle', android: 'stop_circle' }} text="Stopped" />;
    case 'queued': return <QueuedBubble text={row.text} fromTalyn={row.fromTalyn} />;
    case 'plan': return <PlanCard plan={row.plan} state={row.state} busy={plan.busy} disabled={plan.disabled}
      onApprove={plan.approve} onKeepPlanning={plan.keepPlanning} />;
  }
});
