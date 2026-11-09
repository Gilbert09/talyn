import '@testing-library/jest-dom';
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { McpToken } from '@talyn/shared';
import type { LocalAgentKitStatus } from '../main/localAgentKit';
import { LocalAgentsCard } from '../renderer/components/settings/sections/LocalAgentsCard';

const mockCreate = jest.fn();
const mockRevoke = jest.fn();
const mockToast = { success: jest.fn(), error: jest.fn() };
jest.mock('../renderer/lib/api', () => ({
  api: {
    mcpTokens: {
      create: (...a: unknown[]) => mockCreate(...a),
      revoke: (...a: unknown[]) => mockRevoke(...a),
    },
  },
}));
jest.mock('../renderer/stores/toast', () => ({
  toast: {
    success: (...a: unknown[]) => mockToast.success(...a),
    error: (...a: unknown[]) => mockToast.error(...a),
  },
}));

const ENDPOINT = 'https://prod.talyn.dev/api/v1/mcp';
const NEW_TOKEN = 'talyn_mcp_new111aaaaaaaaaaaaaaaaaaaa';

const status = (prefix: string | null, errors: string[] = []): LocalAgentKitStatus => ({
  hostname: 'laptop.local',
  pack: ['talyn-remote-session', 'talyn-pull-requests'],
  errors,
  agents: (['claude', 'codex'] as const).map((agent) => ({
    agent,
    detected: true,
    mcpUrl: prefix ? ENDPOINT : null,
    tokenPrefix: prefix,
    skills: prefix ? ['talyn-remote-session', 'talyn-pull-requests'] : [],
    blockedSkills: [],
  })),
});

const token = (id: string, tokenPrefix: string): McpToken => ({
  id,
  name: 'Claude Code and Codex on laptop',
  tokenPrefix,
  createdAt: '2026-11-01T00:00:00Z',
  lastUsedAt: null,
  expiresAt: '2099-01-01T00:00:00Z',
});

const bridge = { status: jest.fn(), install: jest.fn(), remove: jest.fn() };

beforeEach(() => {
  jest.clearAllMocks();
  (window as unknown as { electron: unknown }).electron = { localAgents: bridge };
  mockRevoke.mockResolvedValue(undefined);
});

afterEach(cleanup);

it('connects both agents in one click with a fresh token', async () => {
  bridge.status.mockResolvedValue(status(null));
  bridge.install.mockResolvedValue(status('talyn_mcp_new111'));
  mockCreate.mockResolvedValue({ token: NEW_TOKEN, token_meta: token('new', 'talyn_mcp_new111') });
  const reload = jest.fn().mockResolvedValue(undefined);
  render(<LocalAgentsCard endpoint={ENDPOINT} tokens={[]} reloadTokens={reload} />);

  fireEvent.click(await screen.findByRole('button', { name: 'Connect Claude Code and Codex' }));

  await waitFor(() => expect(mockToast.success).toHaveBeenCalled());
  expect(mockCreate).toHaveBeenCalledWith({ name: 'Claude Code and Codex on laptop' });
  expect(bridge.install).toHaveBeenCalledWith({ endpoint: ENDPOINT, token: NEW_TOKEN, agents: ['claude', 'codex'] });
  expect(mockRevoke).not.toHaveBeenCalled();
  expect(reload).toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Reconnect' })).toBeInTheDocument();
});

it('revokes the replaced token on reconnect', async () => {
  bridge.status.mockResolvedValue(status('talyn_mcp_old111'));
  bridge.install.mockResolvedValue(status('talyn_mcp_new111'));
  mockCreate.mockResolvedValue({ token: NEW_TOKEN, token_meta: token('new', 'talyn_mcp_new111') });
  render(
    <LocalAgentsCard
      endpoint={ENDPOINT}
      tokens={[token('old', 'talyn_mcp_old111')]}
      reloadTokens={jest.fn().mockResolvedValue(undefined)}
    />
  );

  fireEvent.click(await screen.findByRole('button', { name: 'Reconnect' }));

  await waitFor(() => expect(mockRevoke).toHaveBeenCalledWith('old'));
  expect(mockRevoke).toHaveBeenCalledTimes(1);
});

it('revokes the new token and shows the error when the install fails', async () => {
  bridge.status.mockResolvedValue(status(null));
  bridge.install.mockRejectedValue(new Error('disk full'));
  mockCreate.mockResolvedValue({ token: NEW_TOKEN, token_meta: token('new', 'talyn_mcp_new111') });
  render(<LocalAgentsCard endpoint={ENDPOINT} tokens={[]} reloadTokens={jest.fn()} />);

  fireEvent.click(await screen.findByRole('button', { name: 'Connect Claude Code and Codex' }));

  expect(await screen.findByText('disk full')).toBeInTheDocument();
  expect(mockRevoke).toHaveBeenCalledWith('new');
  expect(mockToast.success).not.toHaveBeenCalled();
});

it('shows a partial failure and keeps the token the other agent uses', async () => {
  bridge.status.mockResolvedValue(status(null));
  const partial = status(null, ['Claude Code: ~/.claude.json is not valid JSON, so Talyn did not change it.']);
  partial.agents[1] = { ...partial.agents[1], mcpUrl: ENDPOINT, tokenPrefix: 'talyn_mcp_new111' };
  bridge.install.mockResolvedValue(partial);
  mockCreate.mockResolvedValue({ token: NEW_TOKEN, token_meta: token('new', 'talyn_mcp_new111') });
  render(<LocalAgentsCard endpoint={ENDPOINT} tokens={[]} reloadTokens={jest.fn().mockResolvedValue(undefined)} />);

  fireEvent.click(await screen.findByRole('button', { name: 'Connect Claude Code and Codex' }));

  expect(await screen.findByText(/not valid JSON/)).toBeInTheDocument();
  expect(mockRevoke).not.toHaveBeenCalled();
});

it('disconnects and revokes the token it installed', async () => {
  bridge.status.mockResolvedValue(status('talyn_mcp_old111'));
  bridge.remove.mockResolvedValue(status(null));
  render(
    <LocalAgentsCard
      endpoint={ENDPOINT}
      tokens={[token('old', 'talyn_mcp_old111')]}
      reloadTokens={jest.fn().mockResolvedValue(undefined)}
    />
  );

  fireEvent.click(await screen.findByRole('button', { name: 'Disconnect' }));

  await waitFor(() => expect(mockRevoke).toHaveBeenCalledWith('old'));
  expect(bridge.remove).toHaveBeenCalledWith(['claude', 'codex']);
  expect(await screen.findByRole('button', { name: 'Connect Claude Code and Codex' })).toBeInTheDocument();
});
