import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
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
} from '@talyn/shared';

const { mockGet, MockApiError } = vi.hoisted(() => {
  class HoistedApiError extends Error {
    constructor(message: string, readonly status: number, readonly code?: string) {
      super(message);
    }
  }
  return { mockGet: vi.fn(), MockApiError: HoistedApiError };
});

vi.mock('../lib/supabase', () => ({ isSupabaseConfigured: () => false, supabase: null }));
vi.mock('../components/auth/AuthProvider', () => ({ useAuth: () => ({ user: null }) }));
vi.mock('../lib/analytics', () => ({ trackEvent: vi.fn(), captureAnalyticsException: vi.fn(), registerSuperProperties: vi.fn() }));
vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, ApiError: MockApiError, insights: { get: mockGet } };
});

import { trackEvent } from '../lib/analytics';
import { InsightsView } from '../pages/InsightsView';
import { AppSidebar } from '../components/layout/AppSidebar';
import { useWorkspaceStore } from '../stores/workspace';
import { useWorkbenchStore } from '../stores/workbenches';
import { useNavigationStore } from '../stores/navigation';
import { pathForRoute, routeForPath } from '../lib/routes';
import {
  analyticsRange,
  customRangeError,
  fixSourceLabel,
  groupFixRuns,
  insightsOffered,
  rangeQuery,
} from '../lib/insights';

const RANGE = { from: '2026-10-05T00:00:00.000Z', to: '2026-11-04T00:00:00.000Z', preset: '30d' as const };

const compute: InsightsComputeResponse = {
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
    periodStart: '2026-10-15T00:00:00.000Z',
    periodEnd: '2026-11-15T00:00:00.000Z',
    includedWsec: 720000,
    usedWsec: 36000,
    creditMicrosUsed: 2_500_000,
  },
};

const tokens = { inputTokens: 1000, outputTokens: 2000, cacheReadTokens: 500_000, cacheWriteTokens: 0 };

const agents: InsightsAgentsResponse = {
  range: RANGE,
  totals: { ...tokens, turns: 5, failedTurns: 1, agentSteps: 40, costMicros: 1_230_000, turnsWithCost: 3 },
  byAgent: [
    { ...tokens, agent: 'claude', turns: 3, costMicros: 1_230_000 },
    { inputTokens: 10, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, agent: 'codex', turns: 2, costMicros: null },
  ],
  byModel: [
    { ...tokens, agent: 'claude', model: 'claude-sonnet-4-5', turns: 3, costMicros: 1_230_000 },
    { inputTokens: 10, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, agent: 'codex', model: 'unknown', turns: 2, costMicros: null },
  ],
  days: [{ date: '2026-11-03', ...tokens, turns: 5 }],
  turnDuration: { count: 5, p50Ms: 30_000, p90Ms: 90_000 },
};

const output: InsightsOutputResponse = {
  range: RANGE,
  sessions: { created: 12, withPullRequest: 7, pullRequestsMerged: 5 },
  tasks: { created: 3, completed: 2, failed: 1, withPullRequest: 2 },
  fixRuns: [
    { source: 'merge_queue', count: 4 },
    { source: 'auto_keep', count: 2 },
    { source: 'code_review', count: 1 },
    { source: 'mystery', count: 3 },
  ],
  mergeQueue: { landed: 9 },
  codeReview: { reviews: 6, findings: [{ severity: 'blocker', count: 2 }, { severity: 'nit', count: 8 }] },
};

const p = (count: number, p50Ms: number | null, p90Ms: number | null) => ({ count, p50Ms, p90Ms });

const speed: InsightsSpeedResponse = {
  range: RANGE,
  boxStart: { ...p(10, 12_400, 30_000), byCause: [{ cause: 'new', ...p(8, 12_000, 20_000) }, { cause: 'move', ...p(2, 40_000, 50_000) }] },
  wake: { ...p(4, 850, 2000), bySource: [{ source: 'host', ...p(3, 500, 900) }, { source: 'storage', ...p(1, 9000, 9000) }] },
  firstReply: p(20, 3000, 7000),
  firstReplyNewSession: p(5, 15_000, 25_000),
  turnStart: p(20, 400, 1200),
};

const top: InsightsTopResponse = {
  range: RANGE,
  repositoriesByHours: [{ repository: 'acme/web', wsec: 7200, tokens: 1000 }],
  repositoriesByTokens: [{ repository: 'acme/api', wsec: 0, tokens: 5_600_000 }],
  sessionsByHours: [
    { workbenchId: 'wb-live', title: 'Fix login', repository: 'acme/web', archived: false, wsec: 3600, tokens: 0 },
    { workbenchId: 'wb-arch', title: 'Old work', repository: 'acme/web', archived: true, wsec: 1800, tokens: 0 },
  ],
  sessionsByTokens: [{ workbenchId: 'wb-gone', title: null, repository: null, archived: false, wsec: 0, tokens: 2000 }],
};

const DATA: InsightsResponseBySection = { compute, agents, output, speed, top };

const EMPTY: InsightsResponseBySection = {
  compute: { ...compute, totalWsec: 0, boxes: 0, days: [], bySize: [], byKind: [], period: null },
  agents: {
    ...agents,
    totals: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, turns: 0, failedTurns: 0, agentSteps: 0, costMicros: null, turnsWithCost: 0 },
    byAgent: [],
    byModel: [],
    days: [],
  },
  output: {
    ...output,
    sessions: { created: 0, withPullRequest: 0, pullRequestsMerged: 0 },
    tasks: { created: 0, completed: 0, failed: 0, withPullRequest: 0 },
    fixRuns: [],
    mergeQueue: { landed: 0 },
    codeReview: { reviews: 0, findings: [] },
  },
  speed: {
    ...speed,
    boxStart: { ...p(0, null, null), byCause: [] },
    wake: { ...p(0, null, null), bySource: [] },
    firstReply: p(0, null, null),
    firstReplyNewSession: p(0, null, null),
    turnStart: p(0, null, null),
  },
  top: { ...top, repositoriesByHours: [], repositoriesByTokens: [], sessionsByHours: [], sessionsByTokens: [] },
};

const SECTIONS: InsightsSection[] = ['compute', 'agents', 'output', 'speed', 'top'];

function setFeatures(features: Partial<Features> | null, workspaceId = 'ws1') {
  useWorkspaceStore.setState({
    currentWorkspaceId: workspaceId,
    workspaces: [{ id: 'ws1', name: 'Acme', repos: [] }, { id: 'ws2', name: 'Beta', repos: [] }] as never,
    features: features as Features | null,
    sidebarCollapsed: false,
    cloudProviders: [],
  });
}

function serveAll(data: InsightsResponseBySection = DATA) {
  mockGet.mockImplementation((section: InsightsSection) => Promise.resolve(data[section]));
}

const sectionEl = (section: InsightsSection) => screen.getByRole('region', { name: sectionTitle[section] });
const sectionTitle: Record<InsightsSection, string> = {
  compute: 'Compute',
  agents: 'Agent usage',
  output: 'Output',
  speed: 'Speed',
  top: 'Top lists',
};

async function renderLoaded() {
  render(<InsightsView />);
  await waitFor(() => expect(screen.queryByText('Loading')).not.toBeInTheDocument());
}

beforeAll(() => {
  (global as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

beforeEach(() => {
  vi.mocked(trackEvent).mockClear();
  mockGet.mockReset();
  serveAll();
  setFeatures({ workbenches: true, usageInsights: true });
  useNavigationStore.setState({ route: { view: 'insights' }, backStack: [], forwardStack: [] });
});

afterEach(cleanup);

describe('navigation', () => {
  it.each([
    [true, true],
    [false, false],
  ])('usageInsights=%s draws the nav entry: %s', (flag, shown) => {
    setFeatures({ workbenches: true, usageInsights: flag });
    useWorkbenchStore.getState().setWorkspace('ws1');
    render(<AppSidebar />);
    const entry = document.querySelector('[data-attr="nav-insights"]');
    if (shown) {
      expect(entry).toBeInTheDocument();
      expect(entry).toHaveTextContent('Insights');
    } else {
      expect(entry).toBeNull();
    }
  });

  it('opens the insights route from the nav entry', () => {
    useNavigationStore.setState({ route: { view: 'home' } });
    useWorkbenchStore.getState().setWorkspace('ws1');
    render(<AppSidebar />);
    fireEvent.click(document.querySelector('[data-attr="nav-insights"]')!);
    expect(useNavigationStore.getState().route).toEqual({ view: 'insights' });
  });

  it.each([
    ['/insights', { view: 'insights' }],
    ['/insights/', { view: 'insights' }],
  ])('routeForPath(%s)', (path, route) => {
    expect(routeForPath(path)).toEqual(route);
    expect(pathForRoute({ view: 'insights' })).toBe('/insights');
  });

  it.each([
    [null, false],
    [{}, false],
    [{ usageInsights: false }, false],
    [{ usageInsights: true }, true],
  ])('insightsOffered(%j) is %s', (features, offered) => {
    expect(insightsOffered(features as Features | null)).toBe(offered);
  });
});

describe('gate', () => {
  it('shows the unavailable state and fetches nothing when the flag is off', () => {
    setFeatures({ workbenches: true, usageInsights: false });
    render(<InsightsView />);
    expect(screen.getByText('Insights is not available on your account.')).toBeInTheDocument();
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('draws nothing while features are still loading', () => {
    setFeatures(null);
    const { container } = render(<InsightsView />);
    expect(container).toBeEmptyDOMElement();
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('shows the unavailable text when a section answers insights_unavailable', async () => {
    mockGet.mockImplementation((section: InsightsSection) =>
      section === 'top' ? Promise.reject(new MockApiError('Forbidden', 403, 'insights_unavailable')) : Promise.resolve(DATA[section])
    );
    await renderLoaded();
    expect(within(sectionEl('top')).getByText('Insights is not available on your account.')).toBeInTheDocument();
  });
});

describe('sections', () => {
  it('fetches every section in parallel for the active workspace and the default range', async () => {
    await renderLoaded();
    expect(mockGet).toHaveBeenCalledTimes(5);
    for (const section of SECTIONS) expect(mockGet).toHaveBeenCalledWith(section, { workspaceId: 'ws1', range: '30d' });
  });

  it.each<[InsightsSection, string[]]>([
    ['compute', ['2.5 box-hours', 'Box runs started', 'Sessions', 'Code review', 'Standard', 'Your plan: Pro', '10 of 200 box-hours used', 'Credits spent this period: $2.50', 'This card covers your whole account, across all your workspaces. The figures above are for this workspace only.']],
    ['agents', ['503K', 'Estimated cost at API prices', '$1.23', 'Cost estimate covers 3 of 5 turns.', '1 failed', 'Claude', 'Codex', 'claude-sonnet-4-5', 'Default model', 'Input (not from cache)', 'Cache read']],
    ['output', ['12', 'Pull requests merged', 'Merge queue', 'Keep green', 'Code review fixes', 'Other', 'Landed by the merge queue', 'Blocker', 'Major', 'Minor', 'Nit']],
    ['speed', ['Box start', 'Median 12.4 s', 'New box', 'Moved to another host', 'From the host', 'From storage', '850 ms', 'First reply in a new session', 'Turn start', '20 samples']],
    ['top', ['acme/web', 'acme/api', '5.6M tokens', 'Fix login', 'Old work', 'Archived', 'Deleted session']],
  ])('%s renders its data', async (section, texts) => {
    await renderLoaded();
    const el = sectionEl(section);
    for (const text of texts) expect(within(el).getAllByText(text, { exact: false }).length).toBeGreaterThan(0);
  });

  it('says the subscription pays for the tokens, not Talyn', async () => {
    await renderLoaded();
    expect(
      within(sectionEl('agents')).getByText(/own Claude or Codex subscription pays for these tokens, not Talyn/)
    ).toBeInTheDocument();
  });

  it('shows "Not reported" when no turn reported a cost', async () => {
    serveAll({ ...DATA, agents: { ...agents, totals: { ...agents.totals, costMicros: null, turnsWithCost: 0 } } });
    await renderLoaded();
    const cost = sectionEl('agents').querySelector('[data-attr="insights-agents-cost"]')!;
    expect(cost).toHaveTextContent('Estimated cost at API prices');
    expect(cost).toHaveTextContent('Not reported');
    expect(cost).not.toHaveTextContent('$');
  });

  it('folds every unknown fix-run source into one Other row', async () => {
    serveAll({ ...DATA, output: { ...output, fixRuns: [{ source: 'a', count: 1 }, { source: 'b', count: 2 }] } });
    await renderLoaded();
    const list = sectionEl('output').querySelector('[data-attr="insights-output-fix-runs"]')!;
    expect(within(list as HTMLElement).getAllByRole('listitem')).toHaveLength(1);
    expect(list).toHaveTextContent('Other');
    expect(list).toHaveTextContent('3');
  });

  it('draws a bar per day with its value in the accessible name', async () => {
    await renderLoaded();
    const days = sectionEl('compute').querySelector('[data-attr="insights-compute-days"]')!;
    const bars = within(days as HTMLElement).getAllByRole('img');
    expect(bars).toHaveLength(2);
    expect(bars[1]).toHaveAttribute('aria-label', expect.stringContaining('1.5 box-hours'));
  });

  it('opens a live session from the top list, and leaves archived and deleted ones as text', async () => {
    await renderLoaded();
    const el = sectionEl('top');
    fireEvent.click(within(el).getByRole('button', { name: 'Fix login' }));
    expect(useNavigationStore.getState().route).toEqual({ view: 'workbench', id: 'wb-live' });
    expect(within(el).queryByRole('button', { name: 'Old work' })).toBeNull();
    expect(within(el).queryByRole('button', { name: 'Deleted session' })).toBeNull();
  });

  it.each<[InsightsSection, string]>([
    ['compute', 'No box time in this range.'],
    ['agents', 'No agent turns in this range.'],
    ['output', 'No output in this range.'],
    ['speed', 'No timing data in this range.'],
    ['top', 'No usage in this range.'],
  ])('%s shows its empty state', async (section, text) => {
    serveAll(EMPTY);
    await renderLoaded();
    expect(within(sectionEl(section)).getByText(text)).toBeInTheDocument();
  });

  it('keeps the account plan card when the workspace used no box time', async () => {
    serveAll({ ...EMPTY, compute: { ...EMPTY.compute, period: compute.period } });
    await renderLoaded();
    const el = sectionEl('compute');
    expect(within(el).getByText('No box time in this range.')).toBeInTheDocument();
    expect(within(el).getByText('Your plan: Pro')).toBeInTheDocument();
  });

  it.each(SECTIONS)('%s shows an error with a Retry that fetches again', async (section) => {
    let fail = true;
    mockGet.mockImplementation((s: InsightsSection) =>
      s === section && fail ? Promise.reject(new Error('Backend is down')) : Promise.resolve(DATA[s])
    );
    await renderLoaded();
    const el = sectionEl(section);
    expect(within(el).getByRole('alert')).toHaveTextContent('Backend is down');
    for (const other of SECTIONS.filter((s) => s !== section)) {
      expect(within(sectionEl(other)).queryByRole('alert')).toBeNull();
    }
    fail = false;
    fireEvent.click(within(el).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(within(sectionEl(section)).queryByRole('alert')).toBeNull());
    expect(mockGet.mock.calls.filter(([s]) => s === section)).toHaveLength(2);
  });
});

describe('range', () => {
  it.each([
    ['Last 7 days', '7d'],
    ['This billing period', 'period'],
  ])('%s refetches every section with range=%s', async (label, range) => {
    await renderLoaded();
    mockGet.mockClear();
    fireEvent.click(screen.getByRole('radio', { name: label }));
    await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(5));
    for (const section of SECTIONS) expect(mockGet).toHaveBeenCalledWith(section, { workspaceId: 'ws1', range });
  });

  it('applies a custom range as whole UTC days with the end day included', async () => {
    await renderLoaded();
    mockGet.mockClear();
    fireEvent.click(screen.getByRole('radio', { name: 'Custom' }));
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-10-01' } });
    fireEvent.change(screen.getByLabelText('To (included)'), { target: { value: '2026-10-31' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(5));
    expect(mockGet).toHaveBeenCalledWith('compute', {
      workspaceId: 'ws1',
      from: '2026-10-01T00:00:00.000Z',
      to: '2026-11-01T00:00:00.000Z',
    });
  });

  it.each([
    ['2026-10-10', '2026-10-09', 'The start date must be on or before the end date.'],
    ['2025-01-01', '2026-01-02', 'A range can cover at most 366 days.'],
    ['', '2026-10-09', 'Pick a start and an end date.'],
  ])('refuses %s to %s', async (from, to, message) => {
    await renderLoaded();
    mockGet.mockClear();
    fireEvent.click(screen.getByRole('radio', { name: 'Custom' }));
    fireEvent.change(screen.getByLabelText('From'), { target: { value: from } });
    fireEvent.change(screen.getByLabelText('To (included)'), { target: { value: to } });
    expect(screen.getByRole('alert')).toHaveTextContent(message);
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('refetches when the workspace changes', async () => {
    await renderLoaded();
    mockGet.mockClear();
    act(() => useWorkspaceStore.setState({ currentWorkspaceId: 'ws2' }));
    await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(5));
    expect(mockGet).toHaveBeenCalledWith('agents', { workspaceId: 'ws2', range: '30d' });
  });

  it('drops a response that arrives after the range changed', async () => {
    const pending: ((value: unknown) => void)[] = [];
    mockGet.mockImplementation((section: InsightsSection, query: { range?: string }) =>
      section === 'compute' && query.range === '30d'
        ? new Promise((resolve) => pending.push(resolve))
        : Promise.resolve(section === 'compute' ? { ...compute, totalWsec: 36000 } : DATA[section])
    );
    render(<InsightsView />);
    fireEvent.click(screen.getByRole('radio', { name: 'Last 7 days' }));
    await waitFor(() => expect(sectionEl('compute').querySelector('[data-attr="insights-compute-total"]')).toHaveTextContent('10 box-hours'));
    await act(async () => pending.forEach((resolve) => resolve(compute)));
    expect(sectionEl('compute').querySelector('[data-attr="insights-compute-total"]')).toHaveTextContent('10 box-hours');
  });
});

describe('analytics', () => {
  const viewed = () => vi.mocked(trackEvent).mock.calls.filter(([event]) => event === 'insights_viewed');

  it('tracks insights_viewed once per section with the range', async () => {
    await renderLoaded();
    await waitFor(() => expect(viewed()).toHaveLength(5));
    for (const section of SECTIONS) expect(trackEvent).toHaveBeenCalledWith('insights_viewed', { section, range: '30d' });
  });

  it.each([
    ['Last 7 days', '7d'],
    ['This billing period', 'period'],
  ])('tracks again after a change to %s', async (label, range) => {
    await renderLoaded();
    await waitFor(() => expect(viewed()).toHaveLength(5));
    fireEvent.click(screen.getByRole('radio', { name: label }));
    await waitFor(() => expect(viewed()).toHaveLength(10));
    for (const section of SECTIONS) expect(trackEvent).toHaveBeenCalledWith('insights_viewed', { section, range });
  });

  it('tracks a custom range as custom, with no dates or ids', async () => {
    await renderLoaded();
    await waitFor(() => expect(viewed()).toHaveLength(5));
    fireEvent.click(screen.getByRole('radio', { name: 'Custom' }));
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-10-01' } });
    fireEvent.change(screen.getByLabelText('To (included)'), { target: { value: '2026-10-31' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(viewed()).toHaveLength(10));
    for (const [, props] of viewed().slice(5)) {
      expect(Object.keys(props as object).sort()).toEqual(['range', 'section']);
      expect((props as { range: string }).range).toBe('custom');
    }
  });

  it('does not track a section that failed', async () => {
    mockGet.mockImplementation((s: InsightsSection) => (s === 'speed' ? Promise.reject(new Error('nope')) : Promise.resolve(DATA[s])));
    await renderLoaded();
    await waitFor(() => expect(viewed()).toHaveLength(4));
    expect(trackEvent).not.toHaveBeenCalledWith('insights_viewed', expect.objectContaining({ section: 'speed' }));
  });
});

describe('helpers', () => {
  it.each([
    ['merge_queue', 'Merge queue'],
    ['auto_keep', 'Keep green'],
    ['code_review', 'Code review fixes'],
    ['manual', 'Other'],
    ['', 'Other'],
  ])('fixSourceLabel(%s) is %s', (source, label) => {
    expect(fixSourceLabel(source)).toBe(label);
  });

  it('groupFixRuns adds unknown sources together', () => {
    expect(groupFixRuns([{ source: 'x', count: 1 }, { source: 'merge_queue', count: 2 }, { source: 'y', count: 4 }])).toEqual([
      { label: 'Other', count: 5 },
      { label: 'Merge queue', count: 2 },
    ]);
  });

  it.each([
    ['2026-01-01', '2026-01-01', null],
    ['2026-01-01', '2027-01-01', null],
    ['2026-01-01', '2027-01-02', 'A range can cover at most 366 days.'],
    ['2026-01-02', '2026-01-01', 'The start date must be on or before the end date.'],
    ['2026-1-1', '2026-01-02', 'Pick a start and an end date.'],
    ['2026-02-30', '2026-03-02', 'Pick a start and an end date.'],
  ])('customRangeError(%s, %s) is %s', (from, to, error) => {
    expect(customRangeError(from, to)).toBe(error);
  });

  it.each([
    [{ kind: 'preset', preset: '7d' } as const, { range: '7d' }],
    [{ kind: 'custom', from: '2026-03-01', to: '2026-03-01' } as const, { from: '2026-03-01T00:00:00.000Z', to: '2026-03-02T00:00:00.000Z' }],
    [{ kind: 'custom', from: '2026-03-02', to: '2026-03-01' } as const, null],
  ])('rangeQuery(%j)', (choice, query) => {
    expect(rangeQuery(choice)).toEqual(query);
  });

  it.each([
    [{ kind: 'preset', preset: '30d' } as const, '30d'],
    [{ kind: 'preset', preset: 'period' } as const, 'period'],
    [{ kind: 'custom', from: '2026-03-01', to: '2026-03-02' } as const, 'custom'],
  ])('analyticsRange(%j) is %s', (choice, range) => {
    expect(analyticsRange(choice)).toBe(range);
  });
});
