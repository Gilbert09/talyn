import '@testing-library/jest-dom/vitest';
import { useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { SETUP_LIST_LIMITS, type RepositorySetup, type SetupListStep } from '@talyn/shared';
import { WebRepoRow } from '../components/settings/RepositoryRow';

function repoSetup(steps: SetupListStep[]): RepositorySetup {
  return {
    repositoryId: 'r1', learningDisabled: false, windowDays: 14, maxLearnedSteps: 20, limits: SETUP_LIST_LIMITS,
    repoSetup: { command: null, source: null, readAt: null, runOnBox: 'always' }, steps, hosts: [], image: null,
    lastSetupTiming: null, timingHistory: [],
  };
}

const { getSize, setSize, getPreview, patchPreview, detectPreview, getSetup } = vi.hoisted(() => ({
  getSize: vi.fn(), setSize: vi.fn(), getPreview: vi.fn(), patchPreview: vi.fn(), detectPreview: vi.fn(), getSetup: vi.fn(),
}));

vi.mock('../lib/api', () => ({ api: { repositories: {
  sandboxSize: { get: getSize, set: setSize },
  preview: { get: getPreview, patch: patchPreview, detect: detectPreview },
  setup: { get: getSetup, put: vi.fn(), acceptStep: vi.fn(), dismissStep: vi.fn(), retryStep: vi.fn() },
} } }));
vi.mock('../stores/navigation', () => ({ useNavigationStore: { getState: () => ({ navigate: vi.fn() }) } }));
vi.mock('../stores/workspace', () => ({ useWorkspaceStore: (selector: (state: unknown) => unknown) => selector({ features: { workbenches: true } }) }));
vi.mock('../components/widgets/PollingOnlyBadge', () => ({ PollingOnlyBadge: () => null }));

const repo = { id: 'r1', owner: 'PostHog', repo: 'posthog', fullName: 'PostHog/posthog', workspaceId: 'ws' };
const preview = { target: 'sandbox', ports: [], source: 'detected', user: {}, reasons: [], detected: null };

function Row({ onRemove = vi.fn() }: { onRemove?: () => void }) {
  const [open, setOpen] = useState(false);
  return <WebRepoRow repo={repo} open={open} onToggle={() => setOpen(!open)} disabled={false} hasInstructions onInstructions={vi.fn()} onRemove={onRemove} />;
}

beforeEach(() => {
  getSize.mockResolvedValue({ setting: 'auto', effective: 'standard', detected: null });
  setSize.mockResolvedValue({ setting: 'large', effective: 'large', detected: null });
  getPreview.mockResolvedValue(preview);
  patchPreview.mockResolvedValue({ ...preview, target: 'off', user: { target: 'off' } });
  detectPreview.mockResolvedValue(preview);
  getSetup.mockResolvedValue(repoSetup([]));
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

test('shows summary pills and opens the detail without a trash icon', async () => {
  render(<Row />);
  expect(await screen.findByText('Standard · 4 GB (auto)')).toBeInTheDocument();
  expect(screen.getByText('Instructions')).toBeInTheDocument();
  expect(await screen.findByText('Preview: auto')).toBeInTheDocument();
  const row = screen.getByRole('button', { name: /PostHog\/posthog/ });
  expect(row.querySelector('svg.lucide-trash-2')).toBeNull();
  fireEvent.click(row);
  expect(row).toHaveAttribute('aria-expanded', 'true');
  expect(screen.getByText('Sandbox size', { selector: 'span' })).toBeInTheDocument();
  expect(await screen.findByText(/Each new box runs this list in order/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Add host' })).toBeInTheDocument();
});

test('shows the selected size in the row', async () => {
  getSize.mockResolvedValue({ setting: 'xlarge', effective: 'xlarge', detected: null });
  render(<Row />);
  expect(await screen.findByText('X-Large · 16 GB')).toBeInTheDocument();
});

test('saves size and preview choices, then confirms removal inline', async () => {
  const onRemove = vi.fn();
  render(<Row onRemove={onRemove} />);
  fireEvent.click(screen.getByRole('button', { name: /PostHog\/posthog/ }));
  fireEvent.change(await screen.findByLabelText('Sandbox size'), { target: { value: 'large' } });
  await waitFor(() => expect(setSize).toHaveBeenCalledWith('r1', 'large'));
  fireEvent.change(await screen.findByLabelText('Preview target for PostHog/posthog'), { target: { value: 'off' } });
  await waitFor(() => expect(patchPreview).toHaveBeenCalledWith('r1', { target: 'off' }));
  fireEvent.click(screen.getByRole('button', { name: 'Remove repository' }));
  expect(onRemove).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
  expect(onRemove).toHaveBeenCalledOnce();
});

function setupStep(patch: Partial<SetupListStep> = {}): SetupListStep {
  return {
    id: 's1', repositoryId: 'r1', position: 0, name: 'apt-get install -y libpq-dev', command: 'apt-get install -y libpq-dev', kind: 'apt',
    runOn: 'image', origin: 'learned', status: 'active', statusReason: null, statusChangedAt: null, acceptedBy: 'talyn', timeoutSec: null,
    boxOnlyReason: null, why: 'pg_config was missing', sourceWorkbenchId: 'wb-123456789', seenCount: 2, sessionCount: 2,
    firstSeenAt: '2026-11-01T10:00:00Z', lastSeenAt: '2026-11-02T10:00:00Z', confirmedAt: null, imageAppliedAt: null, imageFailedAt: null,
    imageFailureReason: null, boxFailureCount: 0, boxLastFailure: null, lastDurationMs: null, typicalDurationMs: null, measuredBoxes: 0,
    createdAt: '2026-11-01T10:00:00Z', updatedAt: '2026-11-01T10:00:00Z', ...patch,
  };
}

test.each([
  { name: 'an active step', steps: [setupStep()], pill: true },
  { name: 'only a suggested step', steps: [setupStep({ status: 'suggested' })], pill: false },
  { name: 'only a dismissed step', steps: [setupStep({ status: 'dismissed' })], pill: false },
  { name: 'only a disabled step', steps: [setupStep({ status: 'disabled' })], pill: false },
  { name: 'no steps', steps: [], pill: false },
])('setup pill with $name', async ({ steps, pill }) => {
  getSetup.mockResolvedValue(repoSetup(steps));
  const { container } = render(<Row />);
  await waitFor(() => expect(getSetup).toHaveBeenCalledWith('r1'));
  if (pill) {
    expect(await screen.findByText('Setup steps', { selector: '[data-attr="settings-repo-setup-pill"]' })).toBeInTheDocument();
  } else {
    await screen.findByText('Preview: auto');
    expect(container.querySelector('[data-attr="settings-repo-setup-pill"]')).toBeNull();
  }
});

test('shows the setup row in the detail', async () => {
  render(<Row />);
  fireEvent.click(screen.getByRole('button', { name: /PostHog\/posthog/ }));
  expect(await screen.findByText(/No steps yet/)).toBeInTheDocument();
  expect(screen.getByRole('switch', { name: 'Learn setup steps from sessions' })).toBeInTheDocument();
});
