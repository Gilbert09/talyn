import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Workbench } from '@talyn/shared';
import { SidebarWorkbenchList } from '../components/layout/SidebarWorkbenchList';
import { useWorkbenchStore } from '../stores/workbenches';
import { installNavigation, useNavigationStore } from '../stores/navigation';
import { toast } from '../stores/toast';

const update = vi.fn();
vi.mock('../lib/api', () => ({ api: { workbenches: { update: (...args: unknown[]) => update(...args) } } }));
vi.mock('../stores/toast', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const workbench = {
  id: 'lisbon',
  workspaceId: 'ws1',
  repositoryId: 'r1',
  repoFullName: 'acme/app',
  name: 'lisbon',
  branch: 'branch-lisbon',
  baseBranch: 'main',
  runtime: 'sandbox',
  sandboxState: 'running',
  status: 'ready',
  pullRequestId: null,
  diffStat: null,
  archivedAt: null,
  createdAt: '2026-10-13T00:00:00Z',
  updatedAt: '2026-10-13T00:00:00Z',
} as Workbench;

beforeAll(() => {
  installNavigation();
  (globalThis as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  (globalThis as { DOMRect: unknown }).DOMRect = class {
    constructor(public x = 0, public y = 0, public width = 0, public height = 0) {}
    static fromRect(rect: { x?: number; y?: number; width?: number; height?: number } = {}) {
      return new (globalThis.DOMRect as new (...args: (number | undefined)[]) => DOMRect)(rect.x, rect.y, rect.width, rect.height);
    }
    get left() { return this.x; }
    get top() { return this.y; }
    get right() { return this.x + this.width; }
    get bottom() { return this.y + this.height; }
  };
});

beforeEach(() => {
  update.mockReset();
  vi.mocked(toast.error).mockClear();
  useWorkbenchStore.getState().setWorkspace('ws1');
  useWorkbenchStore.getState().setWorkbenches('ws1', [workbench]);
  useNavigationStore.getState().navigate({ view: 'home' });
});

afterEach(() => cleanup());

async function editTitle(value: string, key = 'Enter') {
  fireEvent.contextMenu(screen.getByRole('button', { name: /lisbon/ }));
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Rename' }));
  const input = await screen.findByRole('textbox', { name: 'Session title' });
  expect(input).toHaveAttribute('maxLength', '100');
  fireEvent.change(input, { target: { value } });
  fireEvent.keyDown(input, { key });
}

describe('sidebar session rename', () => {
  it('saves the trimmed title', async () => {
    update.mockResolvedValue({ ...workbench, title: 'New title' });
    render(<SidebarWorkbenchList workbenches={[workbench]} />);
    await editTitle('  New title  ');
    await waitFor(() => expect(update).toHaveBeenCalledWith('lisbon', { title: 'New title' }));
    expect(useWorkbenchStore.getState().workbenches.lisbon.title).toBe('New title');
    expect(useNavigationStore.getState().route).toEqual({ view: 'home' });
  });

  it('cancels on Escape and ignores an empty title', async () => {
    render(<SidebarWorkbenchList workbenches={[workbench]} />);
    await editTitle('Other title', 'Escape');
    expect(update).not.toHaveBeenCalled();
    await editTitle('   ');
    await editTitle('lisbon');
    expect(update).not.toHaveBeenCalled();
    expect(useWorkbenchStore.getState().workbenches.lisbon.title).toBeUndefined();
  });

  it('restores the old title and shows an error after a failed save', async () => {
    update.mockRejectedValue(new Error('offline'));
    render(<SidebarWorkbenchList workbenches={[workbench]} />);
    await editTitle('Other title');
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Could not rename the session', 'offline'));
    expect(useWorkbenchStore.getState().workbenches.lisbon.title).toBeUndefined();
  });
});
