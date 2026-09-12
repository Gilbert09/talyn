import { describe, it, expect } from 'vitest';
import {
  cloudAgentChoices,
  cronForPreset,
  DEFAULT_LOOP_SCHEDULE_FIELDS,
  emptyLoopInput,
  loopInputProblem,
  loopsOffered,
  loopToInput,
  presetForCron,
} from '@talyn/shared';
import type { LoopWithStats, WorkspaceSettings } from '@talyn/shared';

/**
 * The client-side halves of Loops: what the app may DRAW, and the two shared
 * derivations both editors run.
 *
 * None of this is authorisation — every loop route and the scheduler gate
 * independently, because a hidden nav item is a decoration the CLI walks
 * straight past. What is pinned here is that the two forks cannot disagree
 * about what they show.
 */

describe('loopsOffered', () => {
  it('draws only on an explicit true', () => {
    expect(loopsOffered({ loops: true })).toBe(true);
  });

  it.each([
    ['still loading', null],
    ['no answer yet', undefined],
    ['switched off', { loops: false }],
    ['no such key', {}],
    ['not a boolean', { loops: 'yes' as unknown as boolean }],
  ])('draws nothing when %s', (_label, features) => {
    // `null` means the capability answer has not arrived. Treating it as "off"
    // and then flipping would flash the nav item in on every launch; treating
    // it as "on" would draw a page whose every request 403s.
    expect(loopsOffered(features as Parameters<typeof loopsOffered>[0])).toBe(false);
  });
});

describe('the editor’s schedule round-trip', () => {
  it('re-opens a saved loop on the preset that produced it', () => {
    // Without this, every saved loop drops into the raw cron box and editing
    // one field means rewriting an expression by hand.
    for (const [kind, fields] of [
      ['hourly', { minute: 15 }],
      ['daily', { minute: 30, hour: 9 }],
      ['weekdays', { minute: 0, hour: 17 }],
      ['weekly', { minute: 45, hour: 8, weekday: 3 }],
    ] as const) {
      const cron = cronForPreset(kind, { ...DEFAULT_LOOP_SCHEDULE_FIELDS, ...fields });
      const match = presetForCron(cron);
      expect(match.kind).toBe(kind);
      expect(cronForPreset(match.kind, match.fields)).toBe(cron);
    }
  });

  it('falls back to the custom box for an expression no preset makes', () => {
    expect(presetForCron('0 */4 * * *').kind).toBe('cron');
  });
});

describe('the editor’s Save button', () => {
  it('refuses a blank form, and says which field', () => {
    expect(loopInputProblem(emptyLoopInput('UTC'))).toMatch(/name/);
  });

  it('accepts a complete one', () => {
    expect(
      loopInputProblem({
        ...emptyLoopInput('UTC'),
        name: 'Nightly',
        prompt: 'Do the thing.',
        repositoryId: 'repo-1',
        repoFullName: 'acme/widget',
      })
    ).toBeNull();
  });

  it('round-trips a saved loop back into an editable input', () => {
    const loop = {
      id: 'loop-1',
      workspaceId: 'ws-1',
      name: 'Nightly',
      enabled: true,
      prompt: 'Do the thing.',
      cron: '0 2 * * *',
      timezone: 'Europe/London',
      provider: 'selfhosted',
      model: 'gpt-5.6-terra',
      concurrency: 'allow',
      repositoryId: 'repo-1',
      repoFullName: 'acme/widget',
      nextRunAt: null,
      disabledReason: null,
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
      stats: { runsTotal: 0, runs7d: 0, failures7d: 0, lastRunAt: null, lastStatus: null },
    } as LoopWithStats;
    // The enable toggle sends the whole definition, so anything this drops is
    // a field the toggle would silently reset.
    expect(loopInputProblem(loopToInput(loop))).toBeNull();
    expect(loopToInput(loop).concurrency).toBe('allow');
    expect(loopToInput(loop).model).toBe('gpt-5.6-terra');
  });
});

describe('the agent menu', () => {
  const fleet = {
    type: 'selfhosted',
    displayName: 'Talyn Fleet',
    connected: true,
    connectedAgents: ['claude', 'codex'],
  };
  const posthog = { type: 'posthog_code', displayName: 'PostHog Code', connected: true };

  it('lists one entry per connected fleet agent', () => {
    // "Talyn Fleet" alone cannot say which subscription runs the work, so a
    // fleet with both connected contributes two entries.
    const choices = cloudAgentChoices([fleet, posthog], null);
    expect(choices.map((c) => c.displayName)).toEqual([
      'Talyn Fleet · Claude',
      'Talyn Fleet · Codex',
      'PostHog Code',
    ]);
  });

  it('gives each fleet entry a model from its own vendor', () => {
    // The model carries the vendor: the fleet builds the microVM's egress
    // route table from it, so a Codex entry carrying a Claude model is a run
    // with no route to its own API.
    const choices = cloudAgentChoices([fleet], null);
    expect(choices[0].model).toMatch(/^claude-/);
    expect(choices[1].model).toMatch(/^gpt-/);
    expect(choices[0].models.every((m) => m.id.startsWith('claude-'))).toBe(true);
    expect(choices[1].models.every((m) => m.id.startsWith('gpt-'))).toBe(true);
  });

  it('prefers the workspace’s stored model over the shipped default', () => {
    const settings = { fleetModels: { claude: 'claude-opus-5' } } as WorkspaceSettings;
    const choices = cloudAgentChoices([fleet], settings);
    expect(choices[0].model).toBe('claude-opus-5');
  });

  it('offers no fleet entries when the fleet is absent or has no agents', () => {
    // `GET /cloud-providers` already drops the fleet for a workspace outside
    // the fleet flag's audience, so the Loop editor sits behind that gate for
    // free. An agent that is not connected is never offered: picking it would
    // produce a task the backend refuses at dispatch.
    expect(cloudAgentChoices([posthog], null).map((c) => c.type)).toEqual(['posthog_code']);
    expect(
      cloudAgentChoices([{ ...fleet, connectedAgents: [] }, posthog], null).map((c) => c.type)
    ).toEqual(['posthog_code']);
  });

  it('drops a provider that is not connected', () => {
    expect(cloudAgentChoices([{ ...posthog, connected: false }], null)).toEqual([]);
  });
});
