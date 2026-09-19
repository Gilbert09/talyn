import { describe, it, expect } from 'vitest';
import { cloudModelLabel, readDispatchedModel } from '@talyn/shared';

const fleetRun = {
  provider: 'selfhosted',
  remoteTaskId: 'sbx_1',
  extra: { model: 'claude-sonnet-5' },
};

describe('readDispatchedModel', () => {
  it.each([
    {
      name: 'a fleet run reads the model its dispatch recorded',
      metadata: { cloudTask: fleetRun },
      provider: 'selfhosted',
      expected: 'claude-sonnet-5',
    },
    {
      name: 'a PostHog Code run reads posthogModel',
      metadata: { posthogTaskId: 't1', posthogModel: 'claude-opus-5' },
      provider: 'posthog_code',
      expected: 'claude-opus-5',
    },
    {
      name: 'a PostHog Code run ignores a stale fleet cloudTask',
      metadata: { cloudTask: fleetRun, posthogModel: 'claude-opus-5' },
      provider: 'posthog_code',
      expected: 'claude-opus-5',
    },
    {
      name: 'a PostHog Code run with no recorded model ignores the fleet one',
      metadata: { cloudTask: fleetRun },
      provider: 'posthog_code',
      expected: null,
    },
    {
      name: 'a fleet run ignores a stale posthogModel',
      metadata: { posthogModel: 'claude-opus-5' },
      provider: 'selfhosted',
      expected: null,
    },
    {
      name: 'the creation pin is not what ran',
      metadata: { model: 'claude-fable-5-1', posthogTaskId: 't1' },
      provider: 'posthog_code',
      expected: null,
    },
    {
      name: 'a cleared posthogModel reads as none',
      metadata: { posthogModel: null },
      provider: 'posthog_code',
      expected: null,
    },
    {
      name: 'a blank model reads as none',
      metadata: { cloudTask: { ...fleetRun, extra: { model: ' ' } } },
      provider: 'selfhosted',
      expected: null,
    },
    {
      name: 'a task with no provider has no model',
      metadata: { cloudTask: fleetRun },
      provider: null,
      expected: null,
    },
    {
      name: 'a task with no metadata has no model',
      metadata: null,
      provider: 'selfhosted',
      expected: null,
    },
  ])('$name', ({ metadata, provider, expected }) => {
    expect(readDispatchedModel({ metadata }, provider)).toBe(expected);
  });
});

describe('cloudModelLabel', () => {
  it.each([
    { id: 'claude-sonnet-5', label: 'Sonnet 5' },
    { id: 'claude-fable-5-1', label: 'Fable 5.1' },
    { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra' },
    { id: 'claude-opus-4-5', label: 'claude-opus-4-5' },
    { id: 'some-future-model', label: 'some-future-model' },
  ])('$id reads as $label', ({ id, label }) => {
    expect(cloudModelLabel(id)).toBe(label);
  });
});
