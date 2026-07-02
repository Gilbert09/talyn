import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { request, ApiError, assertTokenSafeBase } from '../client.js';

// Controllable stand-in for the on-disk/env token so tests can flip between
// authenticated and anonymous requests.
const mocks = vi.hoisted(() => ({ token: null as string | null }));
vi.mock('../config.js', () => ({ getAuthToken: () => mocks.token }));

describe('cli client', () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch');

  beforeEach(() => {
    fetchSpy.mockReset();
  });

  afterEach(() => {
    fetchSpy.mockReset();
    mocks.token = null;
  });

  it('unwraps ApiResponse.data on success', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true, data: { id: 't1' } }), {
        status: 200,
      })
    );
    const data = await request<{ id: string }>('GET', '/tasks/t1', undefined, 'http://localhost:4747');
    expect(data).toEqual({ id: 't1' });
    expect(fetchSpy).toHaveBeenCalledWith(
      'http://localhost:4747/api/v1/tasks/t1',
      expect.objectContaining({ method: 'GET' })
    );
  });

  it('throws ApiError when success=false', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ success: false, error: 'nope' }), { status: 400 })
    );
    await expect(
      request('POST', '/tasks', { x: 1 }, 'http://localhost:4747')
    ).rejects.toBeInstanceOf(ApiError);
  });

  it('sends JSON body on POST', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true, data: {} }), { status: 200 })
    );
    await request('POST', '/tasks', { title: 'hi' }, 'http://localhost:4747');
    expect(fetchSpy).toHaveBeenCalledWith(
      'http://localhost:4747/api/v1/tasks',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ title: 'hi' }),
      })
    );
  });

  describe('token transport safety', () => {
    it('assertTokenSafeBase accepts https anywhere and http on loopback only', () => {
      expect(() => assertTokenSafeBase('https://api.talyn.dev')).not.toThrow();
      expect(() => assertTokenSafeBase('http://localhost:4747')).not.toThrow();
      expect(() => assertTokenSafeBase('http://127.0.0.1:4747')).not.toThrow();
      expect(() => assertTokenSafeBase('http://evil.example.com')).toThrow(/Refusing to send/);
      expect(() => assertTokenSafeBase('not a url')).toThrow(/Invalid TALYN_API_URL/);
    });

    it('refuses to send the bearer token over http to a non-local host', async () => {
      mocks.token = 'secret-token';
      await expect(
        request('GET', '/tasks', undefined, 'http://evil.example.com')
      ).rejects.toThrow(/Refusing to send/);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('still allows unauthenticated requests to any base (no token to leak)', async () => {
      mocks.token = null;
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ success: true, data: {} }), { status: 200 })
      );
      await expect(
        request('GET', '/health-ish', undefined, 'http://evil.example.com')
      ).resolves.toEqual({});
    });
  });
});
