import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  BUNDLED_FLEET_MODELS,
  DEFAULT_FLEET_CODEX_MODEL_ID,
  DEFAULT_FLEET_MODEL_ID,
  FLEET_MODELS,
  RETIRED_FLEET_MODELS,
  bundledFleetModelCatalog,
  cloudModelLabel,
  defaultFleetModelForAgent,
  fleetAgentForModel,
  fleetModelForAgentSwitch,
  fleetProviderForModel,
  getFleetModelCatalog,
  isStoredFleetModelId,
  modelsForLoopProvider,
  parseFleetModelCatalog,
  resolveFleetModel,
  setFleetModelCatalog,
  subscribeFleetModelCatalog,
  topFleetModelForModel,
  type FleetModel,
  type FleetModelCatalog,
} from '@talyn/shared';

const model = (over: Partial<FleetModel> & { id: string }): FleetModel => ({
  label: over.id,
  provider: 'anthropic',
  tier: 'fast',
  blurb: '',
  ...over,
});

/** A backend catalogue with one model this build has never seen per vendor. */
const served = (): FleetModelCatalog => ({
  models: [
    model({ id: 'claude-next-6', label: 'Next 6', tier: 'flagship', blurb: 'Newest.' }),
    model({ id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', tier: 'fast' }),
    model({ id: 'gpt-7-nova', label: 'GPT-7 Nova', provider: 'openai', tier: 'flagship' }),
    model({ id: 'gpt-6.1-terra', label: 'GPT-6.1 Terra', provider: 'openai', tier: 'fast' }),
  ],
  defaults: { claude: 'claude-sonnet-5-5', codex: 'gpt-6.1-terra' },
  retired: { 'gpt-6-astra': 'gpt-7-nova' },
});

afterEach(() => {
  setFleetModelCatalog(bundledFleetModelCatalog());
});

describe('parseFleetModelCatalog', () => {
  it.each([
    ['null', null],
    ['a string', 'models'],
    ['no models', { defaults: {} }],
    ['models not an array', { models: {} }],
    ['an empty list', { models: [] }],
    ['only bad entries', { models: [{ id: 'x' }, null, 3, { id: 'y', label: 'Y', provider: 'google', tier: 'fast' }] }],
  ])('refuses %s', (_name, value) => {
    expect(parseFleetModelCatalog(value)).toBeNull();
  });

  it('accepts the bundled catalogue unchanged', () => {
    expect(parseFleetModelCatalog(bundledFleetModelCatalog())).toEqual(bundledFleetModelCatalog());
  });

  it.each([
    ['an unknown provider', { id: 'gemini-9', label: 'Gemini', provider: 'google', tier: 'fast' }],
    ['no id', { label: 'No id', provider: 'anthropic', tier: 'fast' }],
    ['an empty id', { id: '  ', label: 'Blank', provider: 'anthropic', tier: 'fast' }],
    ['no label', { id: 'claude-x', provider: 'anthropic', tier: 'fast' }],
    ['no tier', { id: 'claude-x', label: 'X', provider: 'anthropic' }],
    ['a duplicate id', { id: 'claude-sonnet-5-5', label: 'Again', provider: 'anthropic', tier: 'fast' }],
  ])('drops an entry with %s and keeps the rest', (_name, bad) => {
    const parsed = parseFleetModelCatalog({ ...served(), models: [...served().models, bad] });
    expect(parsed?.models).toEqual(served().models);
  });

  it('keeps an unknown tier and fills a missing blurb', () => {
    const parsed = parseFleetModelCatalog({
      ...served(),
      models: [...served().models, { id: 'claude-ultra', label: 'Ultra', provider: 'anthropic', tier: 'ultra' }],
    });
    expect(parsed?.models.at(-1)).toEqual(model({ id: 'claude-ultra', label: 'Ultra', tier: 'ultra' }));
  });

  it.each<[string, Record<string, unknown> | undefined, Record<'claude' | 'codex', string>]>([
    ['sent defaults', { claude: 'claude-next-6', codex: 'gpt-7-nova' }, { claude: 'claude-next-6', codex: 'gpt-7-nova' }],
    ['no defaults', undefined, { claude: 'claude-sonnet-5-5', codex: 'gpt-6.1-terra' }],
    ['a default of the wrong vendor', { claude: 'gpt-7-nova', codex: 'claude-next-6' }, { claude: 'claude-sonnet-5-5', codex: 'gpt-6.1-terra' }],
    ['a default that is not listed', { claude: 'claude-gone', codex: 42 }, { claude: 'claude-sonnet-5-5', codex: 'gpt-6.1-terra' }],
  ])('picks each agent default from %s', (_name, defaults, expected) => {
    expect(parseFleetModelCatalog({ ...served(), defaults })?.defaults).toEqual(expected);
  });

  it("falls back to the vendor's first model when the bundled default is not listed", () => {
    const parsed = parseFleetModelCatalog({
      models: [model({ id: 'claude-next-6' }), model({ id: 'gpt-7-nova', provider: 'openai' })],
    });
    expect(parsed?.defaults).toEqual({ claude: 'claude-next-6', codex: 'gpt-7-nova' });
  });

  it('keeps the bundled default for a vendor with no model at all', () => {
    const parsed = parseFleetModelCatalog({ models: [model({ id: 'claude-next-6' })] });
    expect(parsed?.defaults.codex).toBe(DEFAULT_FLEET_CODEX_MODEL_ID);
  });

  it.each([
    ['a target that is not listed', { 'gpt-old': 'gpt-gone' }],
    ['a target that is not a string', { 'gpt-old': 7 }],
    ['an id that is still listed', { 'claude-next-6': 'claude-sonnet-5-5' }],
    ['an empty id', { '': 'gpt-6.1-terra' }],
  ])('drops a retired entry with %s', (_name, retired) => {
    expect(parseFleetModelCatalog({ ...served(), retired })?.retired).toEqual({});
  });
});

describe('setFleetModelCatalog', () => {
  it('starts from the bundled catalogue', () => {
    expect(getFleetModelCatalog()).toEqual(bundledFleetModelCatalog());
    expect(FLEET_MODELS.map((m) => m.id)).toEqual(BUNDLED_FLEET_MODELS.map((m) => m.id));
  });

  it('makes a model this build has never seen work in every helper', () => {
    expect(setFleetModelCatalog(served())).toBe(true);

    expect(FLEET_MODELS.map((m) => m.id)).toEqual(served().models.map((m) => m.id));
    expect(modelsForLoopProvider('selfhosted').map((m) => m.id)).toContain('gpt-7-nova');
    expect(fleetProviderForModel('gpt-7-nova')).toBe('openai');
    expect(fleetAgentForModel('gpt-7-nova')).toBe('codex');
    expect(cloudModelLabel('gpt-7-nova')).toBe('GPT-7 Nova');
    expect(isStoredFleetModelId('gpt-7-nova')).toBe(true);
    expect(topFleetModelForModel('gpt-6.1-terra')).toBe('gpt-7-nova');
    expect(topFleetModelForModel('claude-sonnet-5-5')).toBe('claude-next-6');
    expect(fleetModelForAgentSwitch('claude-next-6', 'codex')).toBe('gpt-7-nova');
    expect(fleetModelForAgentSwitch('gpt-7-nova', 'claude')).toBe('claude-next-6');
  });

  it('applies the served defaults', () => {
    setFleetModelCatalog({ ...served(), defaults: { claude: 'claude-next-6', codex: 'gpt-7-nova' } });
    expect(defaultFleetModelForAgent('claude')).toBe('claude-next-6');
    expect(defaultFleetModelForAgent('codex')).toBe('gpt-7-nova');
    // The bundled constants do not move.
    expect(DEFAULT_FLEET_MODEL_ID).toBe('claude-sonnet-5-5');
  });

  it('replaces the retired map, and a retired id keeps its replacement vendor', () => {
    setFleetModelCatalog(served());
    expect(RETIRED_FLEET_MODELS).toEqual({ 'gpt-6-astra': 'gpt-7-nova' });
    expect(resolveFleetModel('gpt-6-astra')).toBe('gpt-7-nova');
    expect(fleetProviderForModel('gpt-6-astra')).toBe('openai');
    expect(isStoredFleetModelId('gpt-6-astra')).toBe(true);
    // Retired in the bundled map only, so no longer moved.
    expect(resolveFleetModel('gpt-5.1-codex')).toBe('gpt-5.1-codex');
  });

  it('forgets a model the backend stopped serving', () => {
    setFleetModelCatalog(served());
    expect(isStoredFleetModelId('gpt-6-luna')).toBe(false);
    expect(cloudModelLabel('gpt-6-luna')).toBe('gpt-6-luna');
  });

  it('keeps the same exported objects', () => {
    const models = FLEET_MODELS;
    const retired = RETIRED_FLEET_MODELS;
    setFleetModelCatalog(served());
    expect(FLEET_MODELS).toBe(models);
    expect(RETIRED_FLEET_MODELS).toBe(retired);
  });

  it.each([
    ['garbage', 'not a catalogue'],
    ['an empty list', { models: [] }],
  ])('keeps the current catalogue when given %s', (_name, value) => {
    setFleetModelCatalog(served());
    const before = getFleetModelCatalog();
    expect(setFleetModelCatalog(value)).toBe(false);
    expect(getFleetModelCatalog()).toBe(before);
    expect(FLEET_MODELS.map((m) => m.id)).toEqual(served().models.map((m) => m.id));
  });

  it('notifies each subscriber once per change, and not for an equal catalogue', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeFleetModelCatalog(listener);

    setFleetModelCatalog(served());
    const snapshot = getFleetModelCatalog();
    setFleetModelCatalog(served());
    expect(listener).toHaveBeenCalledTimes(1);
    expect(getFleetModelCatalog()).toBe(snapshot);

    unsubscribe();
    setFleetModelCatalog(bundledFleetModelCatalog());
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
