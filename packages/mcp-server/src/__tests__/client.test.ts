import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { request, assertTokenSafeBase } from '../client.js';

describe('mcp client token transport safety', () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch');
  const savedToken = process.env.TALYN_AUTH_TOKEN;

  beforeEach(() => {
    fetchSpy.mockReset();
  });

  afterEach(() => {
    fetchSpy.mockReset();
    if (savedToken === undefined) delete process.env.TALYN_AUTH_TOKEN;
    else process.env.TALYN_AUTH_TOKEN = savedToken;
  });

  it('assertTokenSafeBase accepts https anywhere and http on loopback only', () => {
    expect(() => assertTokenSafeBase('https://api.talyn.dev')).not.toThrow();
    expect(() => assertTokenSafeBase('http://localhost:4747')).not.toThrow();
    expect(() => assertTokenSafeBase('http://127.0.0.1:4747')).not.toThrow();
    expect(() => assertTokenSafeBase('http://evil.example.com')).toThrow(/Refusing to send/);
    expect(() => assertTokenSafeBase('not a url')).toThrow(/Invalid TALYN_API_URL/);
  });

  it('refuses to send TALYN_AUTH_TOKEN over http to a non-local host', async () => {
    process.env.TALYN_AUTH_TOKEN = 'secret-token';
    await expect(
      request('GET', '/tasks', undefined, 'http://evil.example.com')
    ).rejects.toThrow(/Refusing to send/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('sends the token to an https base normally', async () => {
    process.env.TALYN_AUTH_TOKEN = 'secret-token';
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true, data: { ok: true } }), { status: 200 })
    );
    await expect(
      request('GET', '/tasks', undefined, 'https://api.talyn.dev')
    ).resolves.toEqual({ ok: true });
    const [, init] = fetchSpy.mock.calls[0];
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer secret-token');
  });
});
