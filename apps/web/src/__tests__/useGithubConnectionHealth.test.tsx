import { describe, it, expect, afterEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { ApiError, ApiNetworkError } from '@talyn/client';
import { useGithubConnection } from '../hooks/useGithubConnection';
import { api } from '../lib/api';

/**
 * Only the backend ANSWERING `configured: false` may say GitHub is
 * unconfigured. When production's database pool wedged (2026-09-30), every
 * request 500'd and the app told users to set GITHUB_CLIENT_ID.
 *
 * Duplicated in apps/desktop on purpose: the renderer is a deliberate fork.
 */
describe('useGithubConnection — backend health', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    ['a dropped connection', new ApiNetworkError('GET', '/github/status', new TypeError('Failed to fetch')), 'offline'],
    ['a 500', new ApiError('Internal error', 500), 'degraded'],
    ['a 503 while draining', new ApiError('Service unavailable', 503), 'degraded'],
    ['a timeout', new ApiError('Request timeout', 408), 'degraded'],
  ])('reports %s as %s, and never as an unconfigured GitHub', async (_l, err, health) => {
    vi.spyOn(api.github, 'getStatus').mockRejectedValue(err);
    const { result } = renderHook(() => useGithubConnection('ws1'));
    await waitFor(() => expect(result.current.health).toBe(health));
    expect(result.current.status).toBeNull();
  });

  it('leaves health unknown for an error that says nothing about the backend', async () => {
    vi.spyOn(api.github, 'getStatus').mockRejectedValue(new ApiError('Not found', 404));
    const { result } = renderHook(() => useGithubConnection('ws1'));
    await new Promise((r) => setTimeout(r, 20));
    expect(result.current.health).toBeNull();
    expect(result.current.status).toBeNull();
  });

  it('reports ok, and passes through a genuine unconfigured answer', async () => {
    vi.spyOn(api.github, 'getStatus').mockResolvedValue({ configured: false, connected: false });
    const { result } = renderHook(() => useGithubConnection('ws1'));
    await waitFor(() => expect(result.current.health).toBe('ok'));
    expect(result.current.status).toEqual({ configured: false, connected: false });
  });
});
