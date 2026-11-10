import '@testing-library/jest-dom';
import { act, cleanup, render, screen } from '@testing-library/react';
import {
  bundledFleetModelCatalog,
  defaultFleetModelForAgent,
  getFleetModelCatalog,
  setFleetModelCatalog,
  type FleetModelCatalog,
} from '@talyn/shared';

const mockGet = jest.fn();
jest.mock('../renderer/lib/api', () => ({ api: { models: { get: (...args: unknown[]) => mockGet(...args) } } }));

import { hydrateFleetModelCatalog, refreshFleetModelCatalog } from '../renderer/lib/fleetModelCatalog';
import { ModelPicker } from '../renderer/components/workbench/ComposerControls';

const STORAGE_KEY = 'talyn.fleetModelCatalog';

/** The bundled catalogue plus one Claude model this build has never seen. */
function served(): FleetModelCatalog {
  const catalog = bundledFleetModelCatalog();
  return {
    ...catalog,
    models: [
      { id: 'claude-next-6', label: 'Next 6', provider: 'anthropic', tier: 'flagship', blurb: 'Newest.' },
      ...catalog.models,
    ],
    defaults: { ...catalog.defaults, claude: 'claude-next-6' },
  };
}

beforeEach(() => {
  mockGet.mockReset();
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  act(() => {
    setFleetModelCatalog(bundledFleetModelCatalog());
  });
});

describe('refreshFleetModelCatalog', () => {
  it('applies and stores the backend catalogue', async () => {
    mockGet.mockResolvedValue(served());
    await refreshFleetModelCatalog();
    expect(getFleetModelCatalog()).toEqual(served());
    expect(defaultFleetModelForAgent('claude')).toBe('claude-next-6');
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? 'null')).toEqual(served());
  });

  it.each([
    ['a network error', () => Promise.reject(new Error('offline'))],
    ['an older backend with no route', () => Promise.reject(Object.assign(new Error('Not found'), { status: 404 }))],
    ['an empty catalogue', () => Promise.resolve({ models: [] })],
    ['garbage', () => Promise.resolve('nope')],
  ])('keeps the current catalogue after %s', async (_name, answer) => {
    mockGet.mockImplementation(answer);
    await refreshFleetModelCatalog();
    expect(getFleetModelCatalog()).toEqual(bundledFleetModelCatalog());
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });
});

describe('hydrateFleetModelCatalog', () => {
  it('applies the stored catalogue', () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(served()));
    hydrateFleetModelCatalog();
    expect(getFleetModelCatalog()).toEqual(served());
  });

  it.each([
    ['nothing stored', null],
    ['corrupt JSON', '{not json'],
    ['a catalogue with no models', JSON.stringify({ models: [] })],
  ])('keeps the bundled catalogue with %s', (_name, stored) => {
    if (stored !== null) window.localStorage.setItem(STORAGE_KEY, stored);
    hydrateFleetModelCatalog();
    expect(getFleetModelCatalog()).toEqual(bundledFleetModelCatalog());
  });
});

describe('ModelPicker', () => {
  it('shows a model from the backend once the catalogue arrives', async () => {
    render(<ModelPicker agent="claude" value="claude-sonnet-5-5" onChange={() => {}} />);
    expect(screen.queryByRole('option', { name: 'Next 6' })).not.toBeInTheDocument();

    mockGet.mockResolvedValue(served());
    await act(async () => {
      await refreshFleetModelCatalog();
    });

    expect(screen.getByRole('option', { name: 'Next 6' })).toBeInTheDocument();
  });

  it.each([
    ['gpt-5.6-sol', 'GPT-6.1 Sol'],
    ['gpt-5.6-terra', 'GPT-6.1 Terra'],
    ['gpt-5.5', 'GPT-6.1 Sol'],
  ])('shows the retired %s as %s, with no extra option', (retired, label) => {
    render(<ModelPicker agent="codex" value={retired} onChange={() => {}} />);
    expect(screen.getByRole('option', { name: label, selected: true })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: retired })).not.toBeInTheDocument();
  });

  it('keeps an unknown model as its own option', () => {
    render(<ModelPicker agent="codex" value="gpt-custom" onChange={() => {}} />);
    expect(screen.getByRole('option', { name: 'gpt-custom', selected: true })).toBeInTheDocument();
  });
});
