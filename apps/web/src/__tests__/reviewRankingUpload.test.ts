import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ReviewRankingUploader } from '@talyn/client';

describe('ranking uploads', () => {
  beforeEach(() => localStorage.clear());
  const event = (id = 'id') => ({ id, event: 'pr_review_queue_snapshot', properties: { workspace_id: 'ws' } });

  it('retains the same event ID through a network failure and reload', async () => {
    const send = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ accepted: 1 });
    const first = new ReviewRankingUploader('ws', localStorage, send);
    first.append(event());
    await first.flush();
    const second = new ReviewRankingUploader('ws', localStorage, send);
    await second.flush();
    expect(send.mock.calls[0][0].events[0].id).toBe(send.mock.calls[1][0].events[0].id);
    await second.flush();
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('clears pending data on opt-out and sends that preference only once', async () => {
    const send = vi.fn().mockResolvedValue({ accepted: 0 });
    const uploader = new ReviewRankingUploader('ws', localStorage, send);
    uploader.append(event());
    uploader.setEnabled(false);
    uploader.append(event('ignored'));
    await uploader.flush();
    await uploader.flush();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ enabled: false, events: [] });
    expect(localStorage.getItem('talyn-ranking-upload-v1:ws')).toBeNull();
  });

  it.each([400, 403, 413])('drops a permanently rejected batch with a loss count: %s', async (status) => {
    const send = vi.fn().mockRejectedValueOnce({ status }).mockResolvedValue({ accepted: 1 });
    const uploader = new ReviewRankingUploader('ws', localStorage, send);
    uploader.append(event());
    await uploader.flush();
    uploader.append(event('next'));
    await uploader.flush();
    expect(send.mock.calls[1][0].events[0].properties.upload_dropped_events).toBe(1);
  });

  it('bounds an offline queue and reports losses', async () => {
    const send = vi.fn().mockResolvedValue({ accepted: 20 });
    const uploader = new ReviewRankingUploader('ws', localStorage, send);
    for (let i = 0; i < 205; i++) uploader.append(event(String(i)));
    await uploader.flush();
    expect(send.mock.calls[0][0].events).toHaveLength(20);
    expect(send.mock.calls[0][0].events[0].properties.upload_dropped_events).toBe(5);
  });
});
