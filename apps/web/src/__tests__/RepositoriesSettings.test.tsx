import '@testing-library/jest-dom/vitest';
import { useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { WebRepoRow } from '../components/settings/RepositoryRow';

const { getSize, setSize, getBake, putBake, getPreview, patchPreview, detectPreview } = vi.hoisted(() => ({
  getSize: vi.fn(), setSize: vi.fn(), getBake: vi.fn(), putBake: vi.fn(), getPreview: vi.fn(), patchPreview: vi.fn(), detectPreview: vi.fn(),
}));

vi.mock('../lib/api', () => ({ api: { repositories: {
  sandboxSize: { get: getSize, set: setSize },
  bake: { get: getBake, put: putBake },
  preview: { get: getPreview, patch: patchPreview, detect: detectPreview },
} } }));
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
  getBake.mockResolvedValue(null);
  putBake.mockImplementation(async (_id, bake) => bake);
  setSize.mockResolvedValue({ setting: 'large', effective: 'large', detected: null });
  getPreview.mockResolvedValue(preview);
  patchPreview.mockResolvedValue({ ...preview, target: 'off', user: { target: 'off' } });
  detectPreview.mockResolvedValue(preview);
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
  expect(screen.getByText('Sessions')).toBeInTheDocument();
});

test('shows the selected size in the row', async () => {
  getSize.mockResolvedValue({ setting: 'xlarge', effective: 'xlarge', detected: null });
  render(<Row />);
  expect(await screen.findByText('X-Large · 16 GB')).toBeInTheDocument();
});

test('shows a bake pill before the detail opens', async () => {
  getBake.mockResolvedValue({ steps: [{ name: 'Install', run: 'echo ok' }] });
  render(<Row />);
  expect(await screen.findByText('Bake steps', { selector: '[data-attr="settings-repo-bake-pill"]' })).toBeInTheDocument();
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

test('adds, validates, saves, and removes bake steps', async () => {
  render(<Row />);
  fireEvent.click(screen.getByRole('button', { name: /PostHog\/posthog/ }));
  fireEvent.click(await screen.findByRole('button', { name: 'Add step' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save bake steps' }));
  expect(screen.getByRole('alert')).toHaveTextContent('Step 1 name');
  fireEvent.change(screen.getByLabelText('Step 1 name'), { target: { value: 'Install database' } });
  fireEvent.change(screen.getByLabelText('Step 1 command'), { target: { value: 'echo ready' } });
  fireEvent.change(screen.getByLabelText('Allowed hosts'), { target: { value: 'downloads.example.com' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save bake steps' }));
  await waitFor(() => expect(putBake).toHaveBeenCalledWith('r1', { steps: [{ name: 'Install database', run: 'echo ready', timeoutSec: 300 }], hosts: ['downloads.example.com'] }));
  expect(screen.getByText('Bake steps', { selector: '[data-attr="settings-repo-bake-pill"]' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Remove step 1' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save bake steps' }));
  await waitFor(() => expect(putBake).toHaveBeenLastCalledWith('r1', { steps: [] }));
});
