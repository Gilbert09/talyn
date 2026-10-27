import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Workbench } from '@talyn/shared';
import type { WorkbenchOps } from '../lib/workbenchOps';
import { FilesTab } from '../components/workbench/FilesTab';

// Monaco does not run in jsdom. The lazy viewer module is replaced by a plain one.
vi.mock('../components/workbench/CodeViewer', () => ({
  default: ({ path, content }: { path: string; content: string }) => (
    <pre data-testid="code-viewer" data-path={path}>
      {content}
    </pre>
  ),
}));

type ReadResult = { content: string; binary: boolean };

function makeOps(read: (path: string) => Promise<ReadResult>): WorkbenchOps {
  return {
    unavailable: null,
    listFiles: vi.fn(async () => ['src/app.ts', 'logo.png', 'big.log', 'README.md']),
    readFile: vi.fn(read),
  } as unknown as WorkbenchOps;
}

const textOps = () =>
  makeOps(async (path) => {
    if (path === 'logo.png') return { content: 'iVBOR', binary: true };
    if (path === 'big.log') throw new Error('big.log is too large to open here.');
    return { content: `contents of ${path}`, binary: false };
  });

function renderTab(ops: WorkbenchOps) {
  return render(<FilesTab workbench={{ id: 'wb1' } as Workbench} ops={ops} visible />);
}

async function openFile(name: string) {
  const row = await screen.findByText(name);
  await act(async () => {
    fireEvent.click(row);
  });
}

afterEach(cleanup);

describe('FilesTab viewer', () => {
  it('opens a file in the viewer under its path', async () => {
    const ops = textOps();
    renderTab(ops);
    await openFile('README.md');

    const viewer = await screen.findByTestId('code-viewer');
    expect(viewer.textContent).toContain('contents of README.md');
    expect(viewer.getAttribute('data-path')).toBe('README.md');
    expect(screen.getByTitle('README.md')).toBeTruthy();
    expect(screen.getByTestId('file-tree').classList.contains('max-h-[40%]')).toBe(true);
    expect(ops.readFile).toHaveBeenCalledWith('README.md');
  });

  it('opens a nested file with its full path in the header', async () => {
    renderTab(textOps());
    await openFile('src');
    await openFile('app.ts');
    expect((await screen.findByTestId('code-viewer')).getAttribute('data-path')).toBe('src/app.ts');
    expect(screen.getByTitle('src/app.ts')).toBeTruthy();
  });

  it('closes the file with the close button, and the tree takes the full height again', async () => {
    renderTab(textOps());
    await openFile('README.md');
    await screen.findByTestId('code-viewer');

    fireEvent.click(screen.getByRole('button', { name: 'Close file' }));

    expect(screen.queryByTestId('code-viewer')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Close file' })).toBeNull();
    const tree = screen.getByTestId('file-tree');
    expect(tree.classList.contains('flex-1')).toBe(true);
    expect(tree.classList.contains('max-h-[40%]')).toBe(false);
  });

  it('closes the file on Escape inside the viewer', async () => {
    renderTab(textOps());
    await openFile('README.md');
    const viewer = await screen.findByTestId('code-viewer');

    fireEvent.keyDown(viewer, { key: 'Escape' });

    expect(screen.queryByTestId('code-viewer')).toBeNull();
    expect(screen.getByTestId('file-tree').classList.contains('flex-1')).toBe(true);
  });

  it('keeps the file open when something inside already handled Escape', async () => {
    renderTab(textOps());
    await openFile('README.md');
    const viewer = await screen.findByTestId('code-viewer');
    viewer.addEventListener('keydown', (e) => e.preventDefault());

    fireEvent.keyDown(viewer, { key: 'Escape' });

    expect(screen.getByTestId('code-viewer')).toBeTruthy();
  });

  it('ignores keys other than Escape', async () => {
    renderTab(textOps());
    await openFile('README.md');
    const viewer = await screen.findByTestId('code-viewer');

    fireEvent.keyDown(viewer, { key: 'Enter' });
    fireEvent.keyDown(viewer, { key: 'f', metaKey: true });

    expect(screen.getByTestId('code-viewer')).toBeTruthy();
  });

  it('does not close on Escape from the tree', async () => {
    renderTab(textOps());
    await openFile('README.md');
    await screen.findByTestId('code-viewer');

    fireEvent.keyDown(screen.getByText('logo.png'), { key: 'Escape' });

    expect(screen.getByTestId('code-viewer')).toBeTruthy();
  });

  it('shows the binary message and no editor for a binary file', async () => {
    renderTab(textOps());
    await openFile('logo.png');

    expect(await screen.findByText('logo.png is a binary file.')).toBeTruthy();
    expect(screen.queryByTestId('code-viewer')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Close file' }));
    expect(screen.queryByText('logo.png is a binary file.')).toBeNull();
  });

  it('shows the read error for a file that is too large, and can still close it', async () => {
    renderTab(textOps());
    await openFile('big.log');

    expect(await screen.findByText('big.log is too large to open here.')).toBeTruthy();
    expect(screen.queryByTestId('code-viewer')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Close file' }));
    expect(screen.queryByText('big.log is too large to open here.')).toBeNull();
  });

  it('shows a loading line until the file arrives, with the close button already there', async () => {
    let resolve: (r: ReadResult) => void = () => {};
    renderTab(makeOps(() => new Promise<ReadResult>((r) => (resolve = r))));
    await openFile('README.md');

    expect(screen.getByText(/Loading README\.md/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Close file' })).toBeTruthy();

    await act(async () => resolve({ content: 'late', binary: false }));
    expect((await screen.findByTestId('code-viewer')).textContent).toContain('late');
  });

  it('switches to another file', async () => {
    renderTab(textOps());
    await openFile('README.md');
    await screen.findByTestId('code-viewer');
    await openFile('src');
    await openFile('app.ts');

    expect(await screen.findByText('contents of src/app.ts')).toBeTruthy();
    expect(screen.queryByText('contents of README.md')).toBeNull();
  });
});
