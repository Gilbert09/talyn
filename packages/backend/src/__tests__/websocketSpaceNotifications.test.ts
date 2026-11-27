import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emitAutoKeepNeedsHuman, emitMergeQueueBlocked, emitMergeQueueReviewWait } from '../services/websocket.js';
import { pullRequestNotificationsMuted } from '../services/teams/notifications.js';
import { publishToWorkspace } from '../services/wsBus.js';
import { sendWebhookSignal } from '../services/apiWebhooks/signals.js';

vi.mock('../services/teams/notifications.js', () => ({ pullRequestNotificationsMuted: vi.fn() }));
vi.mock('../services/wsBus.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/wsBus.js')>()),
  publishToWorkspace: vi.fn(),
}));
vi.mock('../services/apiWebhooks/signals.js', () => ({ sendWebhookSignal: vi.fn() }));

const common = { pullRequestId: 'pr-1', owner: 'acme', repo: 'app', number: 7,
  title: 'Fix the app', url: 'https://github.com/acme/app/pull/7' };
const blocked = { ...common, reason: 'Merge conflict', attempts: 2 };
const needsHuman = { ...common, reason: 'A decision is needed', taskId: 'task-1' };
const reviewWait = { ...common, waitingSince: '2026-11-27T00:00:00.000Z', message: 'A review is needed' };
const events = [
  { type: 'merge_queue:blocked', payload: blocked, emit: () => emitMergeQueueBlocked('ws-1', blocked) },
  { type: 'auto_keep:needs_human', payload: needsHuman, emit: () => emitAutoKeepNeedsHuman('ws-1', needsHuman) },
  { type: 'merge_queue:review_wait', payload: reviewWait, emit: () => emitMergeQueueReviewWait('ws-1', reviewWait) },
];

describe('personal space preferences for PR alerts', () => {
  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it.each(events)('suppresses $type when the recipient muted the space', async ({ emit }) => {
    vi.mocked(pullRequestNotificationsMuted).mockResolvedValue(true);
    emit();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(pullRequestNotificationsMuted).toHaveBeenCalledWith('ws-1', common.pullRequestId);
    expect(publishToWorkspace).not.toHaveBeenCalled();
  });

  it.each(events)('delivers $type when the space is not muted', async ({ emit, type, payload }) => {
    vi.mocked(pullRequestNotificationsMuted).mockResolvedValue(false);
    emit();
    await vi.waitFor(() => expect(publishToWorkspace).toHaveBeenCalledTimes(1));
    expect(publishToWorkspace).toHaveBeenCalledWith('ws-1', { type, payload, timestamp: expect.any(String) });
  });

  it.each(events)('delivers $type if the preference lookup fails', async ({ emit, type, payload }) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(pullRequestNotificationsMuted).mockRejectedValue(new Error('Database unavailable'));
    emit();
    await vi.waitFor(() => expect(publishToWorkspace).toHaveBeenCalledTimes(1));
    expect(publishToWorkspace).toHaveBeenCalledWith('ws-1', { type, payload, timestamp: expect.any(String) });
  });

  it('keeps webhook delivery when the person muted local alerts', async () => {
    vi.mocked(pullRequestNotificationsMuted).mockResolvedValue(true);
    emitMergeQueueBlocked('ws-1', blocked);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(sendWebhookSignal).toHaveBeenCalledWith({ kind: 'merge_queue_blocked', workspaceId: 'ws-1',
      pullRequestId: common.pullRequestId, reason: blocked.reason, attempts: blocked.attempts });
    expect(publishToWorkspace).not.toHaveBeenCalled();
  });
});
