import { describe, it, expect } from 'vitest';
import { cloudProviderStatus } from '@talyn/shared';

describe('cloudProviderStatus', () => {
  it.each([
    [
      'a provider with no credentials',
      { connected: false },
      { tone: 'disconnected', agents: [], detail: 'Not connected' },
    ],
    [
      'a single-agent provider',
      { connected: true },
      { tone: 'connected', agents: [], detail: 'Connected' },
    ],
    [
      'the fleet with one agent',
      { connected: true, connectedAgents: ['claude'] },
      { tone: 'connected', agents: ['claude'], detail: 'Claude connected' },
    ],
    [
      'the fleet with both agents',
      { connected: true, connectedAgents: ['claude', 'codex'] },
      { tone: 'connected', agents: ['claude', 'codex'], detail: 'Claude and Codex connected' },
    ],
    [
      'a rejected sign-in on one agent',
      { connected: true, connectedAgents: ['claude', 'codex'], reauthAgents: ['codex'] },
      { tone: 'reauth', agents: ['claude', 'codex'], detail: 'Reconnect Codex' },
    ],
    [
      'an agent this build has never heard of',
      { connected: true, connectedAgents: ['gemini'] },
      { tone: 'connected', agents: ['gemini'], detail: 'gemini connected' },
    ],
    [
      'a stale agent list on a disconnected provider',
      { connected: false, connectedAgents: ['claude'] },
      { tone: 'disconnected', agents: [], detail: 'Not connected' },
    ],
  ])('describes %s', (_name, provider, expected) => {
    expect(cloudProviderStatus(provider)).toEqual(expected);
  });
});
