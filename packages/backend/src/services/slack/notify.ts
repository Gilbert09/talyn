import type { SlackNoticeEvent } from '@talyn/shared';
import { debugBus } from '../debugBus.js';
import { broadcastToUser } from '../websocket.js';

/**
 * Tell a linked Talyn user about a Slack request that needs them: the
 * `slack:notice` WebSocket event, to their own connections only (a Slack
 * request belongs to one person, not to everyone watching the workspace).
 * Fired once; a client that was offline finds a pending request through
 * `GET /slack/pending`.
 */
export function notifySlackUser(userId: string, notice: SlackNoticeEvent): void {
  try {
    broadcastToUser(userId, { type: 'slack:notice', payload: notice, timestamp: new Date().toISOString() });
    debugBus.recordEvent({
      service: 'slack_events',
      action: `notice:${notice.kind}`,
      summary: notice.message.slice(0, 200),
      workspaceId: notice.workspaceId ?? undefined,
    });
  } catch (err) {
    console.warn('[slack] could not send a notice:', err);
  }
}
