import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import type { Workspace } from '@talyn/shared';
import { api } from '../renderer/lib/api';
import { useWorkspaceStore } from '../renderer/stores/workspace';
import { CloudProviderDefaultSelector } from '../renderer/components/panels/SettingsPanel';

let update: jest.Mock;

beforeEach(() => {
  update = jest.fn().mockResolvedValue({} as Workspace);
  jest.spyOn(api.workspaces, 'update').mockImplementation(update as never);
});

afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
});

/**
 * "Default for new tasks" lists AGENTS, not providers.
 *
 * "Talyn Fleet" does not say enough: the fleet runs on the workspace's own
 * Claude subscription or its own Codex subscription, and which one is decided
 * by the MODEL. A provider-only list left the consequential half of the choice
 * on a different card entirely.
 *
 * Duplicated in apps/web on purpose: the renderer is a deliberate fork.
 */

function workspace(settings: Record<string, unknown> = {}): Workspace {
  return {
    id: 'ws1',
    name: 'ws',
    repos: [],
    integrations: {},
    settings: settings as Workspace['settings'],
    createdAt: '',
    updatedAt: '',
  };
}

function seed(settings: Record<string, unknown> = {}, agents: string[] = ['claude', 'codex']) {
  useWorkspaceStore.setState({
    workspaces: [workspace(settings)],
    currentWorkspaceId: 'ws1',
    cloudProviders: [
      { type: 'selfhosted', displayName: 'Talyn Fleet', connected: true, connectedAgents: agents },
      { type: 'posthog_code', displayName: 'PostHog Code', connected: true },
    ] as never,
  });
}

/** The `settings` patch sent on the Nth update call. */
function sentSettings(call: number): Record<string, unknown> {
  const args = update.mock.calls[call] as unknown[];
  return (args[1] as { settings: Record<string, unknown> }).settings;
}

const select = () => screen.getByRole('combobox') as HTMLSelectElement;
const labels = () => [...select().options].map((o) => o.textContent);

describe('CloudProviderDefaultSelector', () => {
  it('lists one option per CONNECTED fleet agent', () => {
    seed();
    render(<CloudProviderDefaultSelector />);
    expect(labels()).toEqual([
      'Auto',
      'Talyn Fleet · Claude',
      'Talyn Fleet · Codex',
      'PostHog Code',
      'Ask every time',
    ]);
  });

  // Offering an agent the workspace has not connected produces a default whose
  // every task is refused at dispatch.
  it('does not offer an agent that is not connected', () => {
    seed({}, ['claude']);
    render(<CloudProviderDefaultSelector />);
    expect(labels()).not.toContain('Talyn Fleet · Codex');
    expect(labels()).toContain('Talyn Fleet · Claude');
  });

  it('reads the current agent back off the model', () => {
    seed({ defaultCloudProvider: 'selfhosted', fleetModel: 'gpt-5.1-codex' });
    render(<CloudProviderDefaultSelector />);
    expect(select().value).toBe('selfhosted:codex');
  });

  it('sets both halves when the choice crosses vendors', async () => {
    seed({ defaultCloudProvider: 'selfhosted', fleetModel: 'claude-sonnet-5' });
    render(<CloudProviderDefaultSelector />);
    fireEvent.change(select(), { target: { value: 'selfhosted:codex' } });

    await waitFor(() => expect(update).toHaveBeenCalled());
    expect(sentSettings(0)).toEqual({
      defaultCloudProvider: 'selfhosted',
      fleetModel: 'gpt-5.1-codex',
    });
  });

  /**
   * The one that would cost real money. A workspace that deliberately pinned
   * Opus 5 must not be moved to the Claude DEFAULT (Sonnet 5) just for
   * re-picking "Claude" here.
   */
  it('leaves a pinned model alone when the vendor does not change', async () => {
    seed({ defaultCloudProvider: 'posthog_code', fleetModel: 'claude-opus-5' });
    render(<CloudProviderDefaultSelector />);
    fireEvent.change(select(), { target: { value: 'selfhosted:claude' } });

    await waitFor(() => expect(update).toHaveBeenCalled());
    expect(sentSettings(0)).toEqual({ defaultCloudProvider: 'selfhosted' });
  });

  it('clears the setting for Auto, and stores ask as-is', async () => {
    seed({ defaultCloudProvider: 'selfhosted' });
    render(<CloudProviderDefaultSelector />);

    fireEvent.change(select(), { target: { value: '' } });
    await waitFor(() => expect(update).toHaveBeenCalled());
    expect(sentSettings(0)).toEqual({ defaultCloudProvider: undefined });

    fireEvent.change(select(), { target: { value: 'ask' } });
    await waitFor(() => expect(update).toHaveBeenCalledTimes(2));
    expect(sentSettings(1)).toEqual({ defaultCloudProvider: 'ask' });
  });
});
