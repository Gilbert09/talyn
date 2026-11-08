import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { admin, api, configureApiClient, workbenches } from '../src/index';
import { response } from './helpers';

const fetchMock = vi.fn<typeof fetch>();
beforeEach(() => {
  fetchMock.mockReset();
  configureApiClient({
    baseUrl: 'https://example.test',
    clientVersion: 'web/test',
    getAccessToken: async () => 'token',
    recoverSession: async () => false,
    runtime: { fetch: fetchMock },
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

it('keeps Blob uploads and imports on the existing API object', async () => {
  fetchMock.mockResolvedValue(response());
  const blob = new Blob(['image'], { type: 'image/png' });
  await api.workbenches.uploadAttachment('session/id', blob, 'my image.png');
  expect(fetchMock).toHaveBeenLastCalledWith(
    'https://example.test/api/v1/workbenches/session%2Fid/attachments',
    {
      method: 'POST',
      body: blob,
      headers: {
        'Content-Type': 'image/png',
        'X-Attachment-Name': 'my%20image.png',
        Authorization: 'Bearer token',
        'X-Talyn-Client-Version': 'web/test',
      },
    }
  );
  const bytes = new Uint8Array([1, 2, 3]);
  await workbenches.import('session', bytes);
  const [, init] = fetchMock.mock.calls.at(-1)!;
  expect(init?.headers).toMatchObject({ 'Content-Type': 'application/octet-stream' });
  expect(new Uint8Array(await (init?.body as Blob).arrayBuffer())).toEqual(bytes);
  expect(api.workbenches).toBe(workbenches);
});

it('keeps attachment Blob downloads on the browser entry', async () => {
  const blob = new Blob(['image']);
  fetchMock.mockResolvedValue({ ok: true, status: 200, blob: async () => blob } as Response);
  await expect(workbenches.attachmentBlob('session', 'path/to/file')).resolves.toBe(blob);
  expect(fetchMock.mock.calls[0][0]).toBe(
    'https://example.test/api/v1/workbenches/session/attachments/raw?path=path%2Fto%2Ffile'
  );
});

it('keeps admin streaming, cursor encoding, and reader cleanup on the browser entry', async () => {
  const frame = { terminal: true, cursor: 3, events: [] };
  const read = vi
    .fn()
    .mockResolvedValueOnce({
      done: false,
      value: new TextEncoder().encode(`data: ${JSON.stringify(frame)}\n\n`),
    });
  const cancel = vi.fn(async () => {});
  fetchMock.mockResolvedValue({
    status: 200,
    ok: true,
    body: { getReader: () => ({ read, cancel }) },
  } as unknown as Response);
  const onFrame = vi.fn();
  const signal = new AbortController().signal;
  await admin.fleet.followRun('host/name', 'run/id', { after: 2, signal, onFrame });
  expect(fetchMock).toHaveBeenCalledWith(
    'https://example.test/api/v1/admin/fleet/hosts/host%2Fname/runs/run%2Fid/stream?after=2',
    {
      method: 'GET',
      headers: {
        Authorization: 'Bearer token',
        'X-Talyn-Client-Version': 'web/test',
        Accept: 'text/event-stream',
      },
      signal,
    }
  );
  expect(onFrame).toHaveBeenCalledWith(frame);
  expect(read).toHaveBeenCalledOnce();
  expect(cancel).toHaveBeenCalledOnce();
  expect(api.admin).toBe(admin);
});
