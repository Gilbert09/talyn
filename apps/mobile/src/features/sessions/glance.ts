import { sessionGlanceFacts, type Workbench } from '@talyn/shared';

import { workbenchState } from '../../lib/status';
import { relativeTimeLabel } from '../../lib/time';
import { workbenchKind } from '../../workflow/model';

/**
 * The session at a glance, for the header of the long-press sheet: the web
 * and desktop hover card in plain lines. The state, where the work is, the
 * shared session facts and the times.
 */
export function sessionGlanceText(item: Workbench, now = Date.now()): string {
  const lines = [workbenchState(item).label];
  if (workbenchKind(item) !== 'thread' && item.repoFullName) {
    const where = [item.repoFullName, item.branch].filter(Boolean).join(' · ');
    lines.push(item.branch && item.baseBranch ? `${where} → ${item.baseBranch}` : where);
  }
  const chats = item.chats ?? [];
  for (const fact of sessionGlanceFacts({ workbench: item, chats, hasPullRequest: !!item.pr })) lines.push(`${fact.label}: ${fact.value}`);
  const lastActivity = chats.reduce((latest, chat) => (chat.updatedAt > latest ? chat.updatedAt : latest), item.updatedAt);
  const active = relativeTimeLabel(lastActivity, now);
  const started = relativeTimeLabel(item.createdAt, now);
  const times = [active && `active ${active}`, started && `started ${started}`].filter(Boolean).join(' · ');
  if (times) lines.push(times.charAt(0).toUpperCase() + times.slice(1));
  return lines.join('\n');
}
