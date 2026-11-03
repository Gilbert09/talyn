import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { SETUP_LIST_LIMITS, type SetupListStep, type WorkspaceSandboxSetup } from '@talyn/shared';
import { SandboxSetupSettings, dotfilesProblem } from '../components/settings/sections/SandboxSetupSettings';

const sandboxGet = vi.fn();
const sandboxPut = vi.fn();
const sandboxRetry = vi.fn();
const listRepos = vi.fn();

vi.mock('../lib/api', () => ({
  api: {
    workspaces: {
      sandboxSetup: {
        get: (...args: unknown[]) => sandboxGet(...args),
        put: (...args: unknown[]) => sandboxPut(...args),
        retryStep: (...args: unknown[]) => sandboxRetry(...args),
      },
    },
    github: { listRepos: (...args: unknown[]) => listRepos(...args) },
  },
}));
vi.mock('../stores/workspace', () => ({
  useWorkspaceStore: (selector: (state: unknown) => unknown) => selector({ currentWorkspaceId: 'ws1' }),
}));

function step(patch: Partial<SetupListStep> = {}): SetupListStep {
  return {
    id: 'w1', repositoryId: null, position: 0, name: 'Install ripgrep', command: 'apt-get install -y ripgrep', kind: 'apt',
    runOn: 'image', origin: 'user', status: 'active', statusReason: null, statusChangedAt: null, acceptedBy: 'person',
    timeoutSec: null, boxOnlyReason: null, why: null, sourceWorkbenchId: null, seenCount: 0, sessionCount: 0,
    firstSeenAt: '2026-11-01T10:00:00Z', lastSeenAt: '2026-11-01T10:00:00Z', confirmedAt: '2026-11-01T10:00:00Z',
    imageAppliedAt: '2026-11-01T10:00:00Z', imageFailedAt: null, imageFailureReason: null, boxFailureCount: 0,
    boxLastFailure: null, lastDurationMs: null, typicalDurationMs: null, measuredBoxes: 0,
    createdAt: '2026-11-01T10:00:00Z', updatedAt: '2026-11-01T10:00:00Z', ...patch,
  };
}

function sandbox(patch: Partial<WorkspaceSandboxSetup> = {}): WorkspaceSandboxSetup {
  return { workspaceId: 'ws1', dotfiles: null, hosts: [], steps: [], limits: SETUP_LIST_LIMITS, ...patch };
}

async function renderWith(value: WorkspaceSandboxSetup) {
  sandboxGet.mockResolvedValue(value);
  render(<SandboxSetupSettings />);
  await screen.findByText('Dotfiles');
}

beforeEach(() => {
  listRepos.mockResolvedValue([{ full_name: 'tom/dotfiles' }, { full_name: 'tom/other' }]);
  sandboxPut.mockImplementation(async (_id: string, input: Partial<WorkspaceSandboxSetup>) => sandbox(input.dotfiles !== undefined ? { dotfiles: input.dotfiles } : {}));
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

test('shows the notes and offers the GitHub repositories', async () => {
  await renderWith(sandbox());
  expect(sandboxGet).toHaveBeenCalledWith('ws1');
  expect(screen.getByText(/Private repositories are cloned with your GitHub connection, read-only/)).toBeInTheDocument();
  expect(screen.getByText(/A change here rebuilds your images for each repository/)).toBeInTheDocument();
  await waitFor(() => expect(document.querySelectorAll('datalist option')).toHaveLength(2));
  expect(listRepos).toHaveBeenCalledWith('ws1');
});

test('saves the dotfiles with an empty branch and auto-detected install', async () => {
  await renderWith(sandbox());
  fireEvent.change(screen.getByLabelText('Dotfiles repository'), { target: { value: ' tom/dotfiles ' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save dotfiles' }));
  await waitFor(() => expect(sandboxPut).toHaveBeenCalledWith('ws1', { dotfiles: { slug: 'tom/dotfiles', ref: '', install: null } }));
});

test('saves a branch and an install command, then removes the dotfiles', async () => {
  await renderWith(sandbox());
  fireEvent.change(screen.getByLabelText('Dotfiles repository'), { target: { value: 'tom/dotfiles' } });
  fireEvent.change(screen.getByLabelText('Dotfiles branch'), { target: { value: 'linux' } });
  fireEvent.change(screen.getByLabelText('Dotfiles install command'), { target: { value: './install.sh --minimal' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save dotfiles' }));
  await waitFor(() => expect(sandboxPut).toHaveBeenCalledWith('ws1', { dotfiles: { slug: 'tom/dotfiles', ref: 'linux', install: './install.sh --minimal' } }));
  fireEvent.click(await screen.findByRole('button', { name: 'Remove dotfiles' }));
  await waitFor(() => expect(sandboxPut).toHaveBeenLastCalledWith('ws1', { dotfiles: null }));
});

test.each([
  { name: 'no slash', slug: 'dotfiles', install: '', problem: 'The repository must be owner/name.' },
  { name: 'empty', slug: '', install: '', problem: 'The repository must be owner/name.' },
  { name: 'a literal secret in install', slug: 'tom/dotfiles', install: 'TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789 ./install.sh', problem: /looks like it contains a secret/ },
  { name: 'a secret variable in install', slug: 'tom/dotfiles', install: './install.sh "$GITHUB_TOKEN"', problem: 'The install command reads a secret. The image build has no secrets.' },
])('refuses dotfiles with $name', async ({ slug, install, problem }) => {
  await renderWith(sandbox());
  fireEvent.change(screen.getByLabelText('Dotfiles repository'), { target: { value: slug } });
  fireEvent.change(screen.getByLabelText('Dotfiles install command'), { target: { value: install } });
  fireEvent.click(screen.getByRole('button', { name: 'Save dotfiles' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(problem);
  expect(sandboxPut).not.toHaveBeenCalled();
});

test.each([
  { slug: 'tom/dotfiles', install: '', ok: true },
  { slug: 'tom/dot.files-2', install: 'make install', ok: true },
  { slug: 'tom/dotfiles/extra', install: '', ok: false },
])('dotfilesProblem($slug, $install)', ({ slug, install, ok }) => {
  expect(dotfilesProblem(slug, install) === null).toBe(ok);
});

test('the workspace list reorders steps', async () => {
  await renderWith(sandbox({ steps: [step(), step({ id: 'w2', name: 'Two', status: 'disabled', statusReason: 'failed twice' })] }));
  expect(screen.getAllByText('You', { selector: '[data-attr="setup-step-origin"]' })).toHaveLength(2);
  fireEvent.click(screen.getByRole('button', { name: 'Move step Two up' }));
  await waitFor(() => expect(sandboxPut).toHaveBeenCalledWith('ws1', {
    steps: [
      { id: 'w2', name: 'Two', runOn: 'image', timeoutSec: null },
      { id: 'w1', name: 'Install ripgrep', runOn: 'image', timeoutSec: null },
    ],
  }));
});

test('retry replaces the one step', async () => {
  await renderWith(sandbox({ steps: [step({ status: 'disabled', statusReason: 'failed twice' })] }));
  sandboxRetry.mockResolvedValue(step());
  const row = document.querySelector('[data-step-id="w1"]') as HTMLElement;
  expect(within(row).getByText('Disabled: failed twice')).toBeInTheDocument();
  fireEvent.click(within(row).getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(sandboxRetry).toHaveBeenCalledWith('ws1', 'w1'));
  expect(await within(row).findByText('Active')).toBeInTheDocument();
});

test('adds a step to the workspace list', async () => {
  await renderWith(sandbox());
  fireEvent.click(screen.getByRole('button', { name: 'Add step' }));
  fireEvent.change(screen.getByLabelText('Step name'), { target: { value: 'Shell' } });
  fireEvent.change(screen.getByLabelText('Step command'), { target: { value: 'sudo apt-get install -y zsh' } });
  fireEvent.click(within(document.querySelector('[data-attr="setup-step-form"]') as HTMLElement).getByRole('button', { name: 'Add step' }));
  await waitFor(() => expect(sandboxPut).toHaveBeenCalledWith('ws1', {
    steps: [{ name: 'Shell', command: 'sudo apt-get install -y zsh', runOn: 'image', timeoutSec: null }],
  }));
});

test('refuses a literal secret in a new step', async () => {
  await renderWith(sandbox());
  fireEvent.click(screen.getByRole('button', { name: 'Add step' }));
  fireEvent.change(screen.getByLabelText('Step name'), { target: { value: 'Bad' } });
  fireEvent.change(screen.getByLabelText('Step command'), { target: { value: 'echo sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH' } });
  expect(screen.getByRole('alert')).toHaveTextContent(/looks like it contains a secret/);
  expect(sandboxPut).not.toHaveBeenCalled();
});

test('saves the workspace hosts', async () => {
  await renderWith(sandbox());
  fireEvent.change(screen.getByLabelText('Allowed extra hosts'), { target: { value: 'Cdn.Example.com' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add host' }));
  await waitFor(() => expect(sandboxPut).toHaveBeenCalledWith('ws1', { hosts: ['cdn.example.com'] }));
});

test('shows a save error from the backend', async () => {
  sandboxPut.mockRejectedValue(new Error('The dotfiles branch is not a valid branch, tag or commit.'));
  await renderWith(sandbox());
  fireEvent.change(screen.getByLabelText('Dotfiles repository'), { target: { value: 'tom/dotfiles' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save dotfiles' }));
  expect(await screen.findByText('The dotfiles branch is not a valid branch, tag or commit.')).toBeInTheDocument();
});
