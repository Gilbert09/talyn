import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { FleetAccountsList, codexConfig } from '../components/settings/FleetAccountsList';

const { saveConfig, onChanged } = vi.hoisted(() => ({ saveConfig: vi.fn(), onChanged: vi.fn() }));
vi.mock('../lib/api', () => ({
  ApiError: class extends Error {},
  api: { cloudProviders: { saveConfig } },
}));
vi.mock('../lib/openExternal', () => ({ openExternal: vi.fn() }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('FleetAccountsList on web', () => {
  it.each(['invalid', 'null', '{}'])('rejects bad auth JSON: %s', (value) => {
    expect(() => codexConfig(value)).toThrow();
  });

  it('uses the token pair from auth.json', async () => {
    saveConfig.mockResolvedValue({});
    onChanged.mockResolvedValue(undefined);
    render(<FleetAccountsList agent="codex" workspaceId="ws1" accounts={[]} activeId={null} switchAtPercent={95} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole('button', { name: 'Connect Codex' }));
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    fireEvent.change(await screen.findByLabelText('Codex auth JSON'), { target: { value: JSON.stringify({
      tokens: { access_token: 'access', refresh_token: 'refresh', account_id: 'account' },
    }) } });
    fireEvent.click(screen.getByRole('button', { name: 'Save sign-in' }));
    await waitFor(() => expect(saveConfig).toHaveBeenCalledWith('selfhosted', 'ws1', {
      codexAccessToken: 'access', codexRefreshToken: 'refresh', codexAccountId: 'account',
    }, { codexLabel: 'Codex 1' }));
  });
});
