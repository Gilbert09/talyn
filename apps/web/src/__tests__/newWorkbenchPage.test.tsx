import { vi, describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
/**
 * @jest-environment jsdom
 */
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Features, Workbench, WorkbenchReadiness, Workspace } from '@talyn/shared';
import type { PRRow } from '../lib/api';
import { NewWorkbenchPage } from '../pages/NewWorkbenchPage';
import { openNewWorkbench, prefillFromPr } from '../components/workbench/new/openNewWorkbench';
import { defaultRepositoryId } from '../components/workbench/new/lastRepository';
import { useWorkspaceStore } from '../stores/workspace';
import { useWorkbenchStore } from '../stores/workbenches';
import { useNavigationStore } from '../stores/navigation';
import { usePullRequestStore } from '../stores/pullRequests';
import { downscaleImage } from '../lib/imageDownscale';

vi.mock('../lib/supabase', () => ({
  isSupabaseConfigured: () => false,
  supabase: null,
}));
vi.mock('../lib/imageDownscale', () => ({ downscaleImage: vi.fn() }));

const mockReadiness = vi.fn();
const mockCreate = vi.fn();
const mockSend = vi.fn();
vi.mock('../lib/api', () => ({
  ApiNetworkError: class ApiNetworkError extends Error {
    online = true;
  },
  api: {
    workbenches: {
      readiness: (...args: unknown[]) => mockReadiness(...args),
      create: (...args: unknown[]) => mockCreate(...args),
      updateChat: vi.fn(),
      createChat: vi.fn(),
      sendMessage: (...args: unknown[]) => mockSend(...args),
    },
    pullRequests: {},
  },
}));

const READY: WorkbenchReadiness = {
  sandbox: {
    ok: true,
    reasons: [],
    agents: { claude: { ok: true }, codex: { ok: true } },
  },
};
const NOT_DEPLOYED: WorkbenchReadiness = {
  sandbox: {
    ok: false,
    reasons: [
      {
        code: 'fleet_not_deployed',
        message: 'Talyn Fleet is not deployed: set TALYN_FLEET_URL.',
      },
    ],
    agents: { claude: { ok: false }, codex: { ok: false } },
  },
};
const CODEX_ONLY: WorkbenchReadiness = {
  sandbox: {
    ok: true,
    reasons: [],
    agents: {
      claude: {
        ok: false,
        reason: {
          code: 'agent_not_connected',
          message: 'Connect Claude to Talyn Fleet.',
        },
      },
      codex: { ok: true },
    },
  },
};

const REPOS = [
  {
    id: 'r1',
    workspaceId: 'ws1',
    owner: 'acme',
    repo: 'api',
    fullName: 'acme/api',
  },
  {
    id: 'r2',
    workspaceId: 'ws1',
    owner: 'acme',
    repo: 'web',
    fullName: 'acme/web',
  },
];

function pr(over: Partial<PRRow> = {}): PRRow {
  return {
    id: 'pr42',
    workspaceId: 'ws1',
    repositoryId: 'r1',
    number: 42,
    state: 'open',
    authored: true,
    summary: {
      title: 'Speed up search',
      headBranch: 'feat/search',
      baseBranch: 'develop',
      draft: false,
    },
    ...over,
  } as unknown as PRRow;
}

function wb(id: string, over: Partial<Workbench> = {}): Workbench {
  return {
    id,
    workspaceId: 'ws1',
    repositoryId: 'r1',
    repoFullName: 'acme/api',
    name: id,
    branch: `b-${id}`,
    baseBranch: 'main',
    runtime: 'sandbox',
    agent: 'claude',
    status: 'ready',
    sandboxState: 'running',
    pullRequestId: null,
    archivedAt: null,
    settings: {},
    createdAt: '2026-10-13T00:00:00Z',
    updatedAt: '2026-10-13T00:00:00Z',
    ...over,
  } as Workbench;
}

beforeAll(() => {
  (global as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  mockReadiness.mockResolvedValue(READY);
  useWorkspaceStore.setState({
    currentWorkspaceId: 'ws1',
    workspaces: [
      {
        id: 'ws1',
        name: 'Acme',
        repos: [
          { id: 'x1', name: 'acme/api', url: '', defaultBranch: 'main' },
          { id: 'x2', name: 'acme/web', url: '', defaultBranch: 'trunk' },
        ],
        settings: {},
      } as unknown as Workspace,
    ],
    repositories: REPOS,
    features: { workbenches: true } as Features,
  });
  useWorkbenchStore.getState().setWorkspace('ws1');
  useWorkbenchStore.getState().setWorkbenches('ws1', []);
  useWorkbenchStore.setState({ newWorkbench: { seq: 0, prefill: null } });
  usePullRequestStore.setState({ rows: [] });
  useNavigationStore.getState().navigate({ view: 'home' });
});

afterEach(cleanup);

async function renderPage() {
  const utils = render(<NewWorkbenchPage />);
  await waitFor(() => expect(mockReadiness).toHaveBeenCalledWith('ws1'));
  // useReadiness settles through several promise hops; one macrotask drains them all.
  await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
  return utils;
}

const textarea = () => screen.getByRole('textbox', { name: 'Task' });

describe('NewWorkbenchPage', () => {
  it('adds a pasted image chip and removes it', async () => {
    vi.mocked(downscaleImage).mockResolvedValue('data:image/png;base64,aGVsbG8=');
    await renderPage();
    const file = new File(['image'], 'shot.png', { type: 'image/png' });
    fireEvent.paste(textarea(), { clipboardData: { items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }] } });
    expect(await screen.findByText('shot.png')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove shot.png' }));
    expect(screen.queryByText('shot.png')).toBeNull();
  });

  it('sends a dropped image with the first message once', async () => {
    vi.mocked(downscaleImage).mockResolvedValue('data:image/png;base64,aGVsbG8=');
    mockCreate.mockResolvedValue(wb('new-with-image', { chats: [{ id: 'first-chat' }] as Workbench['chats'] }));
    mockSend.mockResolvedValue({ queued: true });
    await renderPage();
    const file = new File(['image'], 'shot.png', { type: 'image/png' });
    fireEvent.drop(textarea(), { dataTransfer: { files: [file] } });
    await screen.findByText('shot.png');
    fireEvent.change(textarea(), { target: { value: 'Inspect this image' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create and start' }));
    await waitFor(() => expect(mockSend).toHaveBeenCalledWith('first-chat', expect.objectContaining({
      text: 'Inspect this image',
      attachments: [{ name: 'shot.png', mimeType: 'image/png', dataBase64: 'aGVsbG8=' }],
    })));
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ prompt: undefined }));
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('defaults to the first watched repository and its default branch', async () => {
    await renderPage();
    expect(screen.getByRole('button', { name: 'Repository' })).toHaveTextContent('acme/api');
    expect(screen.getByRole('combobox', { name: 'Base branch' })).toHaveAttribute('placeholder', 'main');
    expect(textarea()).toHaveFocus();
  });

  it('defaults to the repository last used in this workspace', async () => {
    localStorage.setItem('talyn-new-workbench-repo:ws1', 'r2');
    await renderPage();
    expect(screen.getByRole('button', { name: 'Repository' })).toHaveTextContent('acme/web');
    expect(screen.getByRole('combobox', { name: 'Base branch' })).toHaveAttribute('placeholder', 'trunk');
  });

  it('shows no runtime or folder control', async () => {
    await renderPage();
    expect(screen.queryByRole('radiogroup', { name: 'Runtime' })).toBeNull();
    expect(screen.queryByText(/Choose folder/)).toBeNull();
  });

  it('disables Sandbox with the reason when readiness says no', async () => {
    mockReadiness.mockResolvedValue(NOT_DEPLOYED);
    await renderPage();
    expect(screen.getByText(/Sandbox unavailable:/).parentElement).toHaveTextContent(
      'Talyn Fleet is not deployed: set TALYN_FLEET_URL.',
    );
    expect(screen.getByRole('button', { name: 'Create and start' })).toBeDisabled();
  });

  it('says plainly when the server is down, and Retry asks again', async () => {
    mockReadiness.mockRejectedValueOnce(new Error('Could not reach backend: GET /workbenches/readiness'));
    mockReadiness.mockResolvedValue(READY);
    await renderPage();
    const reason = await screen.findByText(/Sandbox unavailable:/);
    expect(reason.parentElement).toHaveTextContent('Talyn’s server is not responding');
    expect(reason.parentElement).not.toHaveTextContent('GET /workbenches');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByText(/Sandbox unavailable:/)).toBeNull());
    expect(screen.queryByText(/Sandbox unavailable:/)).toBeNull();
  });

  it('moves to an agent that is ready', async () => {
    mockReadiness.mockResolvedValue(CODEX_ONLY);
    await renderPage();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Agent' })).toHaveTextContent('Codex'));
  });

  it('Enter creates on the chosen repository with the text as the first prompt', async () => {
    localStorage.setItem('talyn-new-workbench-repo:ws1', 'r2');
    mockCreate.mockResolvedValue(wb('fix-login', { repositoryId: 'r2', repoFullName: 'acme/web' }));
    await renderPage();
    fireEvent.change(textarea(), {
      target: { value: 'Fix the login redirect' },
    });
    await act(async () => {
      fireEvent.keyDown(textarea(), { key: 'Enter' });
    });
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        repositoryId: 'r2',
        runtime: 'sandbox',
        agent: 'claude',
        prompt: 'Fix the login redirect',
      }),
    );
    expect(useNavigationStore.getState().route).toEqual({
      view: 'workbench',
      id: 'fix-login',
    });
    expect(localStorage.getItem('talyn-new-workbench-repo:ws1')).toBe('r2');
  });

  it('starts with the stored internet default and sends a sandbox override', async () => {
    localStorage.setItem('talyn.session.defaults', JSON.stringify({ internetAccess: false }));
    mockCreate.mockResolvedValue(wb('offline'));
    await renderPage();
    const toggle = screen.getByRole('switch', { name: 'Internet access' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    fireEvent.change(textarea(), { target: { value: 'Read the code' } });
    await act(async () => {
      fireEvent.keyDown(textarea(), { key: 'Enter' });
    });
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ internetAccess: false }));
  });

  it.each([
    ['Shift+Enter', { key: 'Enter', shiftKey: true }],
    ['Enter on an empty composer', { key: 'Enter' }],
  ])('%s does not create', async (label, event) => {
    await renderPage();
    if (label.startsWith('Shift')) fireEvent.change(textarea(), { target: { value: 'something' } });
    fireEvent.keyDown(textarea(), event);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('keeps the text and shows the reason when the create is refused', async () => {
    mockCreate.mockRejectedValue(
      Object.assign(new Error('Connect Claude to Talyn Fleet first.'), {
        status: 409,
      }),
    );
    await renderPage();
    fireEvent.change(textarea(), { target: { value: 'Add dark mode' } });
    await act(async () => {
      fireEvent.keyDown(textarea(), { key: 'Enter' });
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('Connect Claude to Talyn Fleet first.');
    expect(textarea()).toHaveValue('Add dark mode');
    expect(useNavigationStore.getState().route).toEqual({ view: 'home' });
  });

  it('Shift+Tab toggles plan mode', async () => {
    await renderPage();
    const plan = screen.getByRole('button', { name: /Plan/ });
    expect(plan).toHaveAttribute('aria-pressed', 'false');
    fireEvent.keyDown(textarea(), { key: 'Tab', shiftKey: true });
    expect(plan).toHaveAttribute('aria-pressed', 'true');
  });

  it('a PR prefill shows the PR and creates on its branch', async () => {
    usePullRequestStore.setState({ rows: [pr()] });
    mockCreate.mockResolvedValue(wb('search'));
    openNewWorkbench(prefillFromPr(pr()));
    await renderPage();
    expect(screen.getByText('#42')).toBeInTheDocument();
    expect(screen.getByText('Speed up search')).toBeInTheDocument();
    expect(useWorkbenchStore.getState().newWorkbench.prefill).toBeNull();

    fireEvent.change(textarea(), { target: { value: 'Address the review' } });
    await act(async () => {
      fireEvent.keyDown(textarea(), { key: 'Enter' });
    });
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        repositoryId: 'r1',
        branch: 'feat/search',
        baseBranch: 'develop',
        fromPullRequestId: 'pr42',
      }),
    );
  });

  it('Esc drops a prefill and returns to a new branch', async () => {
    usePullRequestStore.setState({ rows: [pr()] });
    openNewWorkbench(prefillFromPr(pr()));
    await renderPage();
    expect(screen.getByText('#42')).toBeInTheDocument();
    fireEvent.keyDown(textarea(), { key: 'Escape' });
    expect(screen.queryByText('#42')).not.toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Base branch' })).toHaveValue('');
  });

  it('lists recent workbenches, newest first, and links to History for archived ones', async () => {
    useWorkbenchStore.getState().setWorkbenches('ws1', [
      wb('older', { updatedAt: '2026-10-10T00:00:00Z' }),
      wb('newer', {
        updatedAt: '2026-10-14T00:00:00Z',
        repoFullName: 'acme/web',
      }),
      wb('gone', { status: 'archived', archivedAt: '2026-10-12T00:00:00Z' }),
    ]);
    await renderPage();
    const rows = screen.getAllByRole('button').filter((b) => b.getAttribute('data-attr') === 'home-recent-row');
    expect(rows.map((r) => r.textContent?.slice(0, 5))).toEqual(['newer', 'older']);
    fireEvent.click(screen.getByRole('button', { name: /1 archived/ }));
    expect(useNavigationStore.getState().route).toEqual({ view: 'history' });
  });
});

describe('defaultRepositoryId', () => {
  it.each([
    ['stored and still watched', 'r2', 'r2'],
    ['stored but no longer watched', 'gone', 'r1'],
    ['nothing stored', null, 'r1'],
  ])('%s', (_label, stored, expected) => {
    if (stored) localStorage.setItem('talyn-new-workbench-repo:ws1', stored);
    expect(defaultRepositoryId('ws1', REPOS)).toBe(expected);
  });

  it('is empty with no repositories', () => {
    expect(defaultRepositoryId('ws1', [])).toBe('');
  });
});
