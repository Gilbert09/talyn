import {
  bundledFleetModelCatalog,
  getFleetModelCatalog,
  setFleetModelCatalog,
  type FleetModelCatalog,
} from '@talyn/shared';

import { modelsFor } from '../features/create/model';
import { refreshFleetModelCatalog } from '../lib/fleetModelCatalog';
import { modelLabel } from '../lib/models';

/** The bundled catalogue plus one Codex model this build has never seen, as the Codex default. */
function served(): FleetModelCatalog {
  const catalog = bundledFleetModelCatalog();
  return {
    ...catalog,
    models: [...catalog.models, { id: 'gpt-7-nova', label: 'GPT-7 Nova', provider: 'openai', tier: 'flagship', blurb: '' }],
    defaults: { ...catalog.defaults, codex: 'gpt-7-nova' },
  };
}

afterEach(() => {
  setFleetModelCatalog(bundledFleetModelCatalog());
});

describe('fleet model catalogue on mobile', () => {
  it('applies the backend catalogue to labels, defaults and pickers', async () => {
    await refreshFleetModelCatalog(() => Promise.resolve(served()));
    expect(getFleetModelCatalog()).toEqual(served());
    expect(modelLabel('gpt-7-nova')).toBe('GPT-7 Nova');
    expect(modelLabel(null, 'codex')).toBe('GPT-7 Nova');
    expect(modelsFor('codex').map((model) => model.id)).toContain('gpt-7-nova');
    expect(modelsFor('claude').map((model) => model.id)).not.toContain('gpt-7-nova');
  });

  it.each([
    ['a network error', () => Promise.reject(new Error('offline'))],
    ['an empty catalogue', () => Promise.resolve({ models: [] })],
  ])('keeps the bundled catalogue after %s', async (_name, answer) => {
    await refreshFleetModelCatalog(answer);
    expect(getFleetModelCatalog()).toEqual(bundledFleetModelCatalog());
  });

  it('labels a model that the backend dropped from its id', async () => {
    await refreshFleetModelCatalog(() => Promise.resolve({ ...served(), models: served().models.filter((m) => m.id !== 'gpt-6-luna') }));
    expect(modelLabel('gpt-6-luna')).toBe('GPT-6 Luna');
  });
});
