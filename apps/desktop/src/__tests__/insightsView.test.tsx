/**
 * @jest-environment jsdom
 */
import '@testing-library/jest-dom';
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type {
  Features,
  InsightsAgentsResponse,
  InsightsComputeResponse,
  InsightsOutputResponse,
  InsightsResponseBySection,
  InsightsSection,
  InsightsSpeedResponse,
  InsightsTopResponse,
  Workspace,
} from '@talyn/shared';
import { InsightsView } from '../renderer/pages/InsightsView';
import { DayBars } from '../renderer/components/insights/InsightsCharts';
import { AppSidebar } from '../renderer/components/layout/AppSidebar';
import {
  groupFixRuns,
  insightsRangeQuery,
  modelLabel,
  validateCustomRange,
} from '../renderer/lib/insights';
import { useWorkspaceStore } from '../renderer/stores/workspace';
import { useNavigationStore } from '../renderer/stores/navigation';

const mockGet = jest.fn();
const mockTrack = jest.fn();

jest.mock('../renderer/lib/supabase', () => ({ isSupabaseConfigured: () => false, supabase: null }));
jest.mock('../renderer/components/auth/AuthProvider', () => ({ useAuth: () => ({ user: null }) }));
jest.mock('../renderer/lib/api', () => ({
  ...jest.requireActual('../renderer/lib/api'),
  insights: { get: (...args: unknown[]) => mockGet(...args) },
}));
jest.mock('../renderer/lib/analytics', () => ({
  ...jest.requireActual('../renderer/lib/analytics'),
  trackEvent: (...args: unknown[]) => mockTrack(...args),
}));

const RANGE = { from: '2026-10-05T00:00:00.000Z', to: '2026-11-04T00:00:00.000Z', preset: '30d' as const };
const P = (count: number, p50Ms: number | null = null, p90Ms: number | null = null) => ({ count, p50Ms, p90Ms });
const ZERO_TOKENS = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

const COMPUTE: InsightsComputeResponse = {
  range: RANGE,
  totalWsec: 9000,
  boxes: 4,
  days: [
    { date: '2026-11-02', wsec: 3600 },
    { date: '2026-11-03', wsec: 5400 },
  ],
  bySize: [{ size: 'standard', wsec: 9000, boxes: 4 }],
  byKind: [
    { kind: 'workbench', wsec: 7200, boxes: 3 },
    { kind: 'review_unit', wsec: 1800, boxes: 1 },
  ],
  period: {
    tier: 'pro',
    periodStart: '2026-11-01T00:00:00.000Z',
    periodEnd: '2026-12-01T00:00:00.000Z',
    includedWsec: 720_000,
    usedWsec: 36_000,
    creditMicrosUsed: 2_500_000,
  },
};

const AGENTS: InsightsAgentsResponse = {
  range: RANGE,
  totals: {
    inputTokens: 1000,
    outputTokens: 2000,
    cacheReadTokens: 1_200_000,
    cacheWriteTokens: 0,
    turns: 5,
    failedTurns: 1,
    agentSteps: 40,
    costMicros: 3_450_000,
    turnsWithCost: 3,
  },
  byAgent: [
    { agent: 'claude', inputTokens: 1000, outputTokens: 2000, cacheReadTokens: 1_200_000, cacheWriteTokens: 0, turns: 3, costMicros: 3_450_000 },
    { agent: 'codex', ...ZERO_TOKENS, turns: 2, costMicros: null },
  ],
  byModel: [
    { agent: 'claude', model: 'claude-opus-5-5', inputTokens: 1000, outputTokens: 2000, cacheReadTokens: 1_200_000, cacheWriteTokens: 0, turns: 3, costMicros: 3_450_000 },
    { agent: 'codex', model: 'unknown', ...ZERO_TOKENS, turns: 2, costMicros: null },
  ],
  days: [{ date: '2026-11-03', inputTokens: 1000, outputTokens: 2000, cacheReadTokens: 1_200_000, cacheWriteTokens: 0, turns: 5 }],
  turnDuration: P(5, 42_000, 120_000),
};

const OUTPUT: InsightsOutputResponse = {
  range: RANGE,
  sessions: { created: 7, withPullRequest: 3, pullRequestsMerged: 2 },
  tasks: { created: 4, completed: 3, failed: 1, withPullRequest: 2 },
  fixRuns: [
    { source: 'merge_queue', count: 2 },
    { source: 'auto_keep', count: 1 },
    { source: 'code_review', count: 1 },
    { source: 'something_new', count: 5 },
  ],
  mergeQueue: { landed: 6 },
  codeReview: { reviews: 2, findings: [{ severity: 'blocker', count: 1 }, { severity: 'nit', count: 4 }] },
};

const SPEED: InsightsSpeedResponse = {
  range: RANGE,
  boxStart: { ...P(3, 850, 12_400), byCause: [{ cause: 'new', ...P(2, 900, 1000) }] },
  wake: { ...P(2, 1500, 2000), bySource: [{ source: 'storage', ...P(2, 1500, 2000) }] },
  firstReply: P(9, 3000, 9000),
  firstReplyNewSession: P(1, 30_000, 30_000),
  turnStart: P(0),
};

const TOP: InsightsTopResponse = {
  range: RANGE,
  repositoriesByHours: [{ repository: 'acme/api', wsec: 7200, tokens: 10 }],
  repositoriesByTokens: [{ repository: 'acme/web', wsec: 0, tokens: 5_600_000 }],
  sessionsByHours: [
    { workbenchId: 'wb-live', title: 'Fix the login', repository: 'acme/api', archived: false, wsec: 3600, tokens: 0 },
    { workbenchId: 'wb-old', title: 'Old work', repository: 'acme/api', archived: true, wsec: 1800, tokens: 0 },
  ],
  sessionsByTokens: [{ workbenchId: 'wb-gone', title: null, repository: null, archived: false, wsec: 0, tokens: 2000 }],
};

const FULL: InsightsResponseBySection = { compute: COMPUTE, agents: AGENTS, output: OUTPUT, speed: SPEED, top: TOP };

const EMPTY: InsightsResponseBySection = {
  compute: { range: RANGE, totalWsec: 0, boxes: 0, days: [], bySize: [], byKind: [], period: null },
  agents: {
    range: RANGE,
    totals: { ...ZERO_TOKENS, turns: 0, failedTurns: 0, agentSteps: 0, costMicros: null, turnsWithCost: 0 },
    byAgent: [],
    byModel: [],
    days: [],
    turnDuration: P(0),
  },
  output: {
    range: RANGE,
    sessions: { created: 0, withPullRequest: 0, pullRequestsMerged: 0 },
    tasks: { created: 0, completed: 0, failed: 0, withPullRequest: 0 },
    fixRuns: [],
    mergeQueue: { landed: 0 },
    codeReview: { reviews: 0, findings: [] },
  },
  speed: {
    range: RANGE,
    boxStart: { ...P(0), byCause: [] },
    wake: { ...P(0), bySource: [] },
    firstReply: P(0),
    firstReplyNewSession: P(0),
    turnStart: P(0),
  },
  top: { range: RANGE, repositoriesByHours: [], repositoriesByTokens: [], sessionsByHours: [], sessionsByTokens: [] },
};

const SECTIONS: InsightsSection[] = ['compute', 'agents', 'output', 'speed', 'top'];

function setFeatures(features: Partial<Features> | null, workspaceId = 'ws1') {
  useWorkspaceStore.setState({
    features: features as Features | null,
    currentWorkspaceId: workspaceId,
    workspaces: [
      { id: 'ws1', name: 'Acme', repos: [] },
      { id: 'ws2', name: 'Other', repos: [] },
    ] as unknown as Workspace[],
    sidebarCollapsed: false,
    cloudProviders: [],
  });
}

function respondWith(responses: InsightsResponseBySection) {
  mockGet.mockImplementation((section: InsightsSection) => Promise.resolve(responses[section]));
}

function sectionEl(section: InsightsSection) {
  return screen.getByTestId(`insights-${section}`);
}

async function renderPage() {
  const utils = render(<InsightsView />);
  await waitFor(() => expect(screen.queryAllByRole('status')).toHaveLength(0));
  return utils;
}

function rangeSelect(container: HTMLElement) {
  return container.querySelector('[data-attr="insights-range"]') as HTMLSelectElement;
}

beforeAll(() => {
  (global as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

beforeEach(() => {
  mockGet.mockReset();
  mockTrack.mockReset();
  setFeatures({ workbenches: true });
  useNavigationStore.setState({ route: { view: 'insights' }, backStack: [], forwardStack: [] });
  respondWith(FULL);
});

afterEach(cleanup);

describe('nav entry', () => {
  it.each<[string, Partial<Features> | null]>([
    ['features loaded', {}],
    ['features still loading', null],
  ])('shows Insights with %s', (_name, features) => {
    setFeatures(features);
    const { container } = render(<AppSidebar />);
    const item = container.querySelector('[data-attr="nav-insights"]');
    expect(item).toBeInTheDocument();
  });

  it('opens the Insights route', () => {
    useNavigationStore.setState({ route: { view: 'home' } });
    const { container } = render(<AppSidebar />);
    fireEvent.click(container.querySelector('[data-attr="nav-insights"]') as HTMLElement);
    expect(useNavigationStore.getState().route).toEqual({ view: 'insights' });
  });

  it('loads Insights while features are still loading', async () => {
    setFeatures(null);
    await renderPage();
    expect(mockGet).toHaveBeenCalledTimes(5);
  });
});

describe('sections', () => {
  it('fetches every section for the active workspace with the default range', async () => {
    await renderPage();
    expect(mockGet).toHaveBeenCalledTimes(5);
    for (const section of SECTIONS) {
      expect(mockGet).toHaveBeenCalledWith(section, { workspaceId: 'ws1', range: '30d' });
    }
    expect(screen.getByText('Acme')).toBeInTheDocument();
  });

  it.each<[InsightsSection, string[]]>([
    ['compute', ['Box-hours', '2.5', 'Standard · 4 GB', 'Sessions', 'Code review', 'Pro plan, this billing period', '10 of 200 box-hours used', 'Credits spent this period: $2.50']],
    ['agents', ['1.2M', 'Input (not from cache)', 'Cache read', 'Claude', 'claude-opus-5-5', 'Default model', '1 failed', '40']],
    ['output', ['Merge queue', 'Keep green', 'Code review fixes', 'Other', 'Pull requests landed', 'Blocker findings', 'Nit findings']],
    ['speed', ['Box start', '850 ms', '12.4 s', 'New box', 'From storage', 'First reply in a new session', '30 s']],
    ['top', ['acme/api', 'acme/web', '5.6M tokens', 'Fix the login', 'Deleted session', 'Archived']],
  ])('%s renders its data', async (section, texts) => {
    await renderPage();
    const el = within(sectionEl(section));
    for (const text of texts) expect(el.getAllByText(text, { exact: false }).length).toBeGreaterThan(0);
  });

  it('says the plan card is account-wide', async () => {
    await renderPage();
    expect(within(screen.getByTestId('compute-period')).getByText(/every workspace you own/)).toBeInTheDocument();
  });

  it('draws one labelled bar per day', async () => {
    await renderPage();
    const bars = within(screen.getByTestId('compute-days')).getAllByRole('listitem');
    expect(bars).toHaveLength(2);
    expect(bars[1]).toHaveAttribute('aria-label', expect.stringContaining('1.5 box-hours'));
    expect(bars[1]).toHaveAttribute('tabindex', '0');
    fireEvent.mouseEnter(bars[1]);
    expect(within(screen.getByTestId('compute-days')).getByRole('tooltip')).toHaveTextContent('Tue 3 Nov');
    expect(within(screen.getByTestId('compute-days')).getByRole('tooltip')).toHaveTextContent('1.5 box-hours');
  });

  it('shows the sample count for speed', async () => {
    await renderPage();
    const row = within(screen.getByTestId('speed-table')).getByText('First reply').closest('tr') as HTMLElement;
    expect(within(row).getByText('9')).toBeInTheDocument();
  });

  it.each<[InsightsSection, string]>([
    ['compute', 'No box time in this range.'],
    ['agents', 'No agent turns in this range.'],
    ['output', 'No sessions, tasks or reviews in this range.'],
    ['speed', 'No timings in this range.'],
    ['top', 'Nothing to rank in this range.'],
  ])('%s shows its empty state', async (section, text) => {
    respondWith(EMPTY);
    await renderPage();
    expect(within(sectionEl(section)).getByText(text)).toBeInTheDocument();
  });

  it('keeps the plan card when the workspace has no box time', async () => {
    respondWith({ ...EMPTY, compute: { ...EMPTY.compute, period: COMPUTE.period } });
    await renderPage();
    expect(screen.getByText('No box time in this range.')).toBeInTheDocument();
    expect(screen.getByTestId('compute-period')).toBeInTheDocument();
  });

  it.each(SECTIONS)('%s shows an error and retries', async (section) => {
    let failed = false;
    mockGet.mockImplementation((s: InsightsSection) => {
      if (s === section && !failed) {
        failed = true;
        return Promise.reject(new Error('Server exploded'));
      }
      return Promise.resolve(FULL[s]);
    });
    await renderPage();
    const el = within(sectionEl(section));
    expect(el.getByRole('alert')).toHaveTextContent('Server exploded');
    fireEvent.click(el.getByRole('button', { name: /Retry/ }));
    await waitFor(() => expect(el.queryByRole('alert')).toBeNull());
    expect(mockGet.mock.calls.filter(([s]) => s === section)).toHaveLength(2);
  });

});

describe('day chart', () => {
  it('shows round value ticks, four date labels, and no bar for a zero day', () => {
    const points = [0, 0.001, 0.5, 1, 1.5, 0].map((value, index) => ({
      date: `2026-11-0${index + 1}`,
      value,
      valueText: `${value} box-hours`,
    }));
    render(<DayBars label="Box-hours per day" points={points} />);
    expect(screen.getByLabelText('Value axis').querySelector('div')?.textContent).toBe('0.00.51.01.5');
    expect(screen.getAllByTestId('day-bar')).toHaveLength(4);
    expect(screen.getAllByTestId('day-bar')[0]).toHaveStyle({ height: '2px' });
    expect(screen.getByLabelText('Date axis').textContent).toMatch(/Nov 1|1 Nov/);
    expect(screen.getByLabelText('Date axis').textContent).toMatch(/Nov 6|6 Nov/);
    expect(screen.getByLabelText('Date axis').children).toHaveLength(4);
    const zeroDay = screen.getAllByRole('listitem')[0];
    fireEvent.mouseEnter(zeroDay);
    expect(screen.getByRole('tooltip')).toHaveTextContent('Sun 1 Nov');
    expect(screen.getByRole('tooltip')).toHaveTextContent('0 box-hours');
    expect(within(zeroDay).queryByTestId('day-bar')).toBeNull();
  });
});

describe('agent cost copy', () => {
  it.each<[string, Partial<InsightsAgentsResponse['totals']>, string, RegExp]>([
    ['partial', {}, '$3.45', /Cost estimate covers 3 of 5 turns/],
    ['complete', { turnsWithCost: 5 }, '$3.45', /estimate at API prices/],
    ['none reported', { costMicros: null, turnsWithCost: 0 }, 'Not reported', /reported no cost/],
  ])('%s', async (_name, totals, value, detail) => {
    respondWith({ ...FULL, agents: { ...AGENTS, totals: { ...AGENTS.totals, ...totals } } });
    await renderPage();
    const tile = within(screen.getByTestId('agents-cost'));
    expect(tile.getByText('Estimated cost at API prices')).toBeInTheDocument();
    expect(tile.getByText(value)).toBeInTheDocument();
    expect(tile.getByText(detail)).toBeInTheDocument();
    expect(within(sectionEl('agents')).getByText(/subscription pays for these tokens, not Talyn/)).toBeInTheDocument();
  });

  it('marks a model with no cost as not reported', async () => {
    await renderPage();
    const row = within(screen.getByTestId('agents-models')).getByText('Default model').closest('tr') as HTMLElement;
    expect(within(row).getByText('Not reported')).toBeInTheDocument();
  });

  it.each<[string, number, boolean]>([
    ['a model with no turns of its own', 0, true],
    ['a model with turns', 4, false],
  ])('subagent note: %s', async (_name, turns, shown) => {
    const subagent = { inputTokens: 5, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, agent: 'claude', model: 'claude-fable-5-1', turns, costMicros: 72_140_000 };
    respondWith({ ...FULL, agents: { ...AGENTS, byModel: [...AGENTS.byModel, subagent] } });
    await renderPage();
    const table = within(screen.getByTestId('agents-models'));
    const row = table.getByText('claude-fable-5-1').closest('tr') as HTMLElement;
    expect(within(row).queryByText('Subagents only') !== null).toBe(shown);
    expect(within(sectionEl('agents')).queryByText(/the model ran inside the turns of other models/) !== null).toBe(shown);
  });
});

describe('range picker', () => {
  it.each<['today' | 'yesterday' | '7d' | 'period']>([['today'], ['yesterday'], ['7d'], ['period']])('refetches every section for %s', async (preset) => {
    const { container } = await renderPage();
    mockGet.mockClear();
    fireEvent.change(rangeSelect(container), { target: { value: preset } });
    await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(5));
    for (const section of SECTIONS) {
      expect(mockGet).toHaveBeenCalledWith(section, { workspaceId: 'ws1', range: preset });
    }
  });

  it.each<[string, string, string, string | null]>([
    ['start after end', '2026-11-03', '2026-11-01', 'The start date must be on or before the end date.'],
    ['same day (one full day)', '2026-11-03', '2026-11-03', null],
    ['too long', '2025-01-01', '2026-11-01', 'Pick a range of 366 days or less.'],
    ['missing date', '', '2026-11-01', 'Pick a start date and an end date.'],
    ['valid', '2026-10-01', '2026-11-01', null],
  ])('custom range: %s', async (_name, from, to, message) => {
    const { container } = await renderPage();
    mockGet.mockClear();
    fireEvent.change(rangeSelect(container), { target: { value: 'custom' } });
    fireEvent.change(screen.getByLabelText('From'), { target: { value: from } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: to } });
    const apply = screen.getByRole('button', { name: 'Apply' });
    if (message) {
      expect(screen.getByTestId('insights-range-error')).toHaveTextContent(message);
      expect(apply).toBeDisabled();
      expect(mockGet).not.toHaveBeenCalled();
      return;
    }
    expect(screen.queryByTestId('insights-range-error')).toBeNull();
    // Picking "Custom" alone fetches nothing until Apply.
    expect(mockGet).not.toHaveBeenCalled();
    fireEvent.click(apply);
    await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(5));
    expect(mockGet).toHaveBeenCalledWith('compute', {
      workspaceId: 'ws1',
      from: `${from}T00:00:00.000Z`,
      // The end day is included: `to` is the midnight after it.
      to: new Date(Date.parse(`${to}T00:00:00.000Z`) + 86_400_000).toISOString(),
    });
  });

  it('ignores a stale response for an old range', async () => {
    let releaseOld: (value: unknown) => void = () => {};
    mockGet.mockImplementation((s: InsightsSection, q: { range?: string }) => {
      if (s === 'compute' && q.range === '30d') return new Promise((resolve) => { releaseOld = resolve; });
      if (s === 'compute') return Promise.resolve({ ...COMPUTE, totalWsec: 36_000 });
      return Promise.resolve(FULL[s]);
    });
    const { container } = render(<InsightsView />);
    fireEvent.change(rangeSelect(container), { target: { value: '7d' } });
    await waitFor(() => expect(within(screen.getByTestId('compute-total')).getByText('10')).toBeInTheDocument());
    await act(async () => {
      releaseOld({ ...COMPUTE, totalWsec: 3600 });
    });
    expect(within(screen.getByTestId('compute-total')).getByText('10')).toBeInTheDocument();
  });

  it('refetches when the workspace changes', async () => {
    await renderPage();
    mockGet.mockClear();
    act(() => useWorkspaceStore.setState({ currentWorkspaceId: 'ws2' }));
    await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(5));
    expect(mockGet).toHaveBeenCalledWith('speed', { workspaceId: 'ws2', range: '30d' });
  });
});

describe('analytics', () => {
  const viewed = () => mockTrack.mock.calls.filter(([event]) => event === 'insights_viewed').map(([, props]) => props);

  it('tracks each section once per range', async () => {
    const { container, rerender } = await renderPage();
    expect(viewed()).toEqual(expect.arrayContaining(SECTIONS.map((section) => ({ section, range: '30d' }))));
    expect(viewed()).toHaveLength(5);

    rerender(<InsightsView />);
    expect(viewed()).toHaveLength(5);

    fireEvent.change(rangeSelect(container), { target: { value: '7d' } });
    await waitFor(() => expect(viewed()).toHaveLength(10));
    expect(viewed().slice(5)).toEqual(expect.arrayContaining(SECTIONS.map((section) => ({ section, range: '7d' }))));
  });

  it('sends custom for a custom range and no identifiers', async () => {
    const { container } = await renderPage();
    mockTrack.mockClear();
    fireEvent.change(rangeSelect(container), { target: { value: 'custom' } });
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-10-01' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-11-01' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(viewed()).toHaveLength(5));
    for (const props of viewed()) {
      expect(Object.keys(props as object).sort()).toEqual(['range', 'section']);
      expect((props as { range: string }).range).toBe('custom');
    }
  });

  it('does not track a section that failed', async () => {
    mockGet.mockImplementation((s: InsightsSection) => (s === 'output' ? Promise.reject(new Error('nope')) : Promise.resolve(FULL[s])));
    await renderPage();
    expect(viewed()).toHaveLength(4);
    expect(viewed()).not.toContainEqual({ section: 'output', range: '30d' });
  });
});

describe('top sessions', () => {
  it('opens a live session', async () => {
    await renderPage();
    fireEvent.click(within(sectionEl('top')).getByRole('button', { name: 'Fix the login' }));
    expect(useNavigationStore.getState().route).toEqual({ view: 'workbench', id: 'wb-live' });
  });

  it('opens an archived session', async () => {
    await renderPage();
    fireEvent.click(within(sectionEl('top')).getByRole('button', { name: 'Old work' }));
    expect(useNavigationStore.getState().route).toEqual({ view: 'workbench', id: 'wb-old' });
  });

  it('does not open a deleted session', async () => {
    await renderPage();
    expect(within(sectionEl('top')).queryByRole('button', { name: 'Deleted session' })).toBeNull();
  });
});

describe('helpers', () => {
  it.each<[string, string, string | null]>([
    ['2026-01-01', '2027-01-01', null],
    ['2026-01-01', '2027-01-02', 'Pick a range of 366 days or less.'],
    ['2026-02-30', '2026-03-05', 'Pick a start date and an end date.'],
    ['not-a-date', '2026-03-05', 'Pick a start date and an end date.'],
  ])('validateCustomRange(%s, %s)', (from, to, expected) => {
    expect(validateCustomRange(from, to)).toBe(expected);
  });

  it.each([
    [{ preset: '7d' as const }, { range: '7d' }],
    [{ preset: 'custom' as const, from: '2026-10-01', to: '2026-10-08' }, { from: '2026-10-01T00:00:00.000Z', to: '2026-10-09T00:00:00.000Z' }],
  ])('insightsRangeQuery(%j)', (range, expected) => {
    expect(insightsRangeQuery(range)).toEqual(expected);
  });

  it('groups unknown fix-run sources into Other', () => {
    expect(groupFixRuns([{ source: 'a', count: 1 }, { source: 'merge_queue', count: 2 }, { source: 'b', count: 3 }])).toEqual([
      { label: 'Other', count: 4 },
      { label: 'Merge queue', count: 2 },
    ]);
  });

  it.each([
    ['unknown', 'Default model'],
    ['gpt-6-sol', 'gpt-6-sol'],
  ])('modelLabel(%s)', (model, expected) => {
    expect(modelLabel(model)).toBe(expected);
  });
});
