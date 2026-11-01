import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import type { Workbench } from '@talyn/shared';
import type { WorkbenchOps } from '../lib/workbenchOps';

const { previewGet, previewLink, answers, toastError } = vi.hoisted(() => ({
  previewGet: vi.fn(),
  previewLink: vi.fn(),
  answers: vi.fn(),
  toastError: vi.fn(),
}));
vi.mock('../lib/api', () => ({
  api: { repositories: { preview: { get: previewGet } }, workbenches: { previewLink } },
}));
vi.mock('../lib/previewProbe', () => ({ previewPortAnswers: answers }));
vi.mock('../stores/toast', () => ({ toast: { error: toastError, success: vi.fn(), info: vi.fn() } }));

const { SessionPreviewLinks } = await import('../components/workbench/SessionPreviewLinks');
const { useWorkspaceStore } = await import('../stores/workspace');
const { useWorkbenchStore } = await import('../stores/workbenches');

const workbench = {
  id: 'wb1', repositoryId: 'r1', runtime: 'sandbox', status: 'ready', archivedAt: null,
} as unknown as Workbench;
const sandboxConfig = { target: 'sandbox', ports: [{ port: 5173 }] };

function ops(extra: Partial<WorkbenchOps> = {}): WorkbenchOps {
  return { unavailable: null, runScript: vi.fn(async () => undefined), ...extra } as unknown as WorkbenchOps;
}

function setFeatures(previewLinks: boolean) {
  useWorkspaceStore.getState().setFeatures({ workbenches: true, previewLinks } as never);
}

describe('SessionPreviewLinks', () => {
  let tab: { closed: boolean; opener: unknown; close: ReturnType<typeof vi.fn>; location: { replace: ReturnType<typeof vi.fn> }; document: Document };

  beforeEach(() => {
    previewGet.mockReset().mockResolvedValue(sandboxConfig);
    previewLink.mockReset().mockResolvedValue({ url: 'https://abc-5173.preview.test/__talyn/auth?ticket=t', origin: 'https://abc-5173.preview.test', port: 5173, expiresAt: '' });
    answers.mockReset().mockResolvedValue(true);
    toastError.mockReset();
    tab = { closed: false, opener: window, close: vi.fn(), location: { replace: vi.fn() }, document: document.implementation.createHTMLDocument() };
    vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
    setFeatures(true);
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it.each([
    ['the deployment has no preview domain', () => setFeatures(false), workbench],
    ['the session is local', () => undefined, { ...workbench, runtime: 'local' } as Workbench],
    ['the session is archived', () => undefined, { ...workbench, status: 'archived' } as Workbench],
  ])('renders nothing when %s', async (_name, setup, wb) => {
    setup();
    const { container } = render(<SessionPreviewLinks workbench={wb} ops={ops()} />);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(container.innerHTML).toBe('');
  });

  it.each([['coder'], ['off']])('renders nothing for the %s target', async (target) => {
    previewGet.mockResolvedValue({ target, ports: [] });
    const { container } = render(<SessionPreviewLinks workbench={workbench} ops={ops()} />);
    await waitFor(() => expect(previewGet).toHaveBeenCalled());
    expect(container.innerHTML).toBe('');
  });

  it('starts the run script, mints a link and opens it in the new tab', async () => {
    const runScript = vi.fn(async () => undefined);
    useWorkbenchStore.setState({ scriptOutput: {} } as never);
    render(<SessionPreviewLinks workbench={workbench} ops={ops({ runScript })} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open preview' }));
    expect(window.open).toHaveBeenCalledWith('about:blank', '_blank');
    await waitFor(() => expect(tab.location.replace).toHaveBeenCalledWith('https://abc-5173.preview.test/__talyn/auth?ticket=t'));
    expect(tab.opener).toBeNull();
    expect(runScript).toHaveBeenCalledWith('run');
    expect(previewLink).toHaveBeenCalledWith('wb1', 5173);
  });

  it('does not start the run script when it is running', async () => {
    const runScript = vi.fn(async () => undefined);
    useWorkbenchStore.setState({ scriptOutput: { wb1: { run: { running: true } } } } as never);
    render(<SessionPreviewLinks workbench={workbench} ops={ops({ runScript })} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open preview' }));
    await waitFor(() => expect(tab.location.replace).toHaveBeenCalled());
    expect(runScript).not.toHaveBeenCalled();
  });

  it('closes the tab and says why when minting fails', async () => {
    useWorkbenchStore.setState({ scriptOutput: { wb1: { run: { running: true } } } } as never);
    previewLink.mockRejectedValue(new Error('Hosted previews are not set up on this deployment.'));
    render(<SessionPreviewLinks workbench={workbench} ops={ops()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open preview' }));
    await waitFor(() => expect(tab.close).toHaveBeenCalled());
    expect(toastError).toHaveBeenCalledWith('Could not open the preview', 'Hosted previews are not set up on this deployment.');
  });

  it('says to allow pop-ups when the browser blocks the tab', async () => {
    vi.mocked(window.open).mockReturnValue(null);
    render(<SessionPreviewLinks workbench={workbench} ops={ops()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open preview' }));
    expect(toastError).toHaveBeenCalledWith('Could not open the preview', 'Allow pop-ups for Talyn, then try again.');
    expect(previewLink).not.toHaveBeenCalled();
  });

  it('labels each port when there are several', async () => {
    previewGet.mockResolvedValue({ target: 'sandbox', ports: [{ port: 3000, label: 'web' }, { port: 8000 }] });
    render(<SessionPreviewLinks workbench={workbench} ops={ops()} />);
    expect(await screen.findByRole('button', { name: 'Open preview (web)' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open preview (8000)' })).toBeTruthy();
  });
});
