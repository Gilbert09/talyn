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
    expect(send).toHaveBeenCalledTimes(10);
  });

  it('preserves whole snapshot groups and loss counters across reloads', async () => {
    const send = vi.fn().mockResolvedValue({ accepted: 20 });
    const uploader = new ReviewRankingUploader('ws', localStorage, send);
    for (let i = 0; i < 202; i++) uploader.append({ ...event(String(i)), properties: {
      workspace_id: 'ws', snapshot_id: i < 4 ? 'old' : 'keep',
    } });
    uploader.append({ ...event('late-chunk'), properties: { workspace_id: 'ws', snapshot_id: 'old' } });
    const reloaded = new ReviewRankingUploader('ws', localStorage, send);
    await reloaded.flush();
    const sent = send.mock.calls.flatMap(([batch]) => batch.events);
    expect(sent).toHaveLength(198);
    expect(sent.every((e) => e.properties.snapshot_id === 'keep')).toBe(true);
    expect(sent[0].properties.upload_dropped_events).toBe(5);
  });

  it.each([400, 413])('isolates a rejected record instead of discarding good records: %s', async (status) => {
    const sent: string[] = [];
    const send = vi.fn(async (batch) => {
      if (batch.events.some((e: { id: string }) => e.id === 'bad')) throw { status };
      sent.push(...batch.events.map((e: { id: string }) => e.id));
    });
    const uploader = new ReviewRankingUploader('ws', localStorage, send);
    ['one', 'bad', 'two'].forEach((id) => uploader.append(event(id)));
    await uploader.flush();
    expect(sent).toEqual(['one', 'two']);
    expect(send.mock.calls.at(-1)![0].events[0].properties.upload_dropped_events).toBe(1);
  });

  it('splits an oversized request without dropping any records', async () => {
    const sent: string[] = [];
    const send = vi.fn(async (batch) => {
      if (batch.events.length > 2) throw { status: 413 };
      sent.push(...batch.events.map((e: { id: string }) => e.id));
    });
    const uploader = new ReviewRankingUploader('ws', localStorage, send);
    for (let i = 0; i < 6; i++) uploader.append(event(String(i)));
    await uploader.flush();
    expect(sent).toEqual(['0', '1', '2', '3', '4', '5']);
    expect(send.mock.calls.at(-1)![0].events[0].properties.upload_dropped_events).toBe(0);
  });

  it('stops draining on a transient failure and retries the same IDs', async () => {
    const send = vi.fn().mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('offline')).mockResolvedValue({});
    const uploader = new ReviewRankingUploader('ws', localStorage, send);
    for (let i = 0; i < 45; i++) uploader.append(event(String(i)));
    await uploader.flush();
    expect(send).toHaveBeenCalledTimes(2);
    await uploader.flush();
    expect(send.mock.calls[2][0].events.map((e: { id: string }) => e.id))
      .toEqual(send.mock.calls[1][0].events.map((e: { id: string }) => e.id));
    expect(send).toHaveBeenCalledTimes(4);
  });

  it('does not send more records or restore storage after an in-flight opt-out', async () => {
    let finish!: () => void;
    const send = vi.fn().mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; })).mockResolvedValue({});
    const uploader = new ReviewRankingUploader('ws', localStorage, send);
    for (let i = 0; i < 25; i++) uploader.append(event(String(i)));
    const pending = uploader.flush();
    uploader.setEnabled(false);
    finish();
    await pending;
    expect(send).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem('talyn-ranking-upload-v1:ws')).toBeNull();
    await uploader.flush();
    expect(send).toHaveBeenLastCalledWith({ enabled: false, events: [] });
  });
});
