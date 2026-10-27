/**
 * @jest-environment jsdom
 */
import '@testing-library/jest-dom';
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Workbench } from '@talyn/shared';
import type { WorkbenchOps } from '../renderer/lib/workbenchOps';
import { FilesTab } from '../renderer/components/workbench/FilesTab';

// Monaco does not run in jsdom. The lazy viewer module is replaced by a plain one.
jest.mock('../renderer/components/workbench/CodeViewer', () => ({
  __esModule: true,
  default: ({ path, content }: { path: string; content: string }) => (
    <pre data-testid="code-viewer" data-path={path}>
      {content}
    </pre>
  ),
}));

jest.mock('../renderer/lib/fileIconUrl', () => ({
  loadFileIconUrl: async () => null,
}));

type ReadResult = { content: string; binary: boolean };

function makeOps(read: (path: string) => Promise<ReadResult>): WorkbenchOps {
  return {
    unavailable: null,
    listFiles: jest.fn(async () => ['src/app.ts', 'logo.png', 'big.log', 'README.md']),
    readFile: jest.fn(read),
  } as unknown as WorkbenchOps;
}

const textOps = () =>
  makeOps(async (path) => {
    if (path === 'logo.png') return { content: 'iVBOR', binary: true };
    if (path === 'big.log') throw new Error('File exceeds the 2 MiB limit');
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
    expect(viewer).toHaveTextContent('contents of README.md');
    expect(viewer).toHaveAttribute('data-path', 'README.md');
    expect(screen.getByTitle('README.md')).toBeInTheDocument();
    expect(screen.getByTestId('file-tree')).toHaveClass('max-h-[40%]');
    expect(ops.readFile).toHaveBeenCalledWith('README.md');
  });

  it('opens a nested file with its full path in the header', async () => {
    renderTab(textOps());
    await openFile('src');
    await openFile('app.ts');
    expect(await screen.findByTestId('code-viewer')).toHaveAttribute('data-path', 'src/app.ts');
    expect(screen.getByTitle('src/app.ts')).toBeInTheDocument();
  });

  it('closes the file with the close button, and the tree takes the full height again', async () => {
    renderTab(textOps());
    await openFile('README.md');
    await screen.findByTestId('code-viewer');

    fireEvent.click(screen.getByRole('button', { name: 'Close file' }));

    expect(screen.queryByTestId('code-viewer')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Close file' })).not.toBeInTheDocument();
    const tree = screen.getByTestId('file-tree');
    expect(tree).toHaveClass('flex-1');
    expect(tree).not.toHaveClass('max-h-[40%]');
  });

  it('closes the file on Escape inside the viewer', async () => {
    renderTab(textOps());
    await openFile('README.md');
    const viewer = await screen.findByTestId('code-viewer');

    fireEvent.keyDown(viewer, { key: 'Escape' });

    expect(screen.queryByTestId('code-viewer')).not.toBeInTheDocument();
    expect(screen.getByTestId('file-tree')).toHaveClass('flex-1');
  });

  it('keeps the file open when something inside already handled Escape', async () => {
    renderTab(textOps());
    await openFile('README.md');
    const viewer = await screen.findByTestId('code-viewer');
    viewer.addEventListener('keydown', (e) => e.preventDefault());

    fireEvent.keyDown(viewer, { key: 'Escape' });

    expect(screen.getByTestId('code-viewer')).toBeInTheDocument();
  });

  it('ignores keys other than Escape', async () => {
    renderTab(textOps());
    await openFile('README.md');
    const viewer = await screen.findByTestId('code-viewer');

    fireEvent.keyDown(viewer, { key: 'Enter' });
    fireEvent.keyDown(viewer, { key: 'f', metaKey: true });

    expect(screen.getByTestId('code-viewer')).toBeInTheDocument();
  });

  it('does not close on Escape from the tree', async () => {
    renderTab(textOps());
    await openFile('README.md');
    await screen.findByTestId('code-viewer');

    fireEvent.keyDown(screen.getByText('logo.png'), { key: 'Escape' });

    expect(screen.getByTestId('code-viewer')).toBeInTheDocument();
  });

  it('shows the binary message and no editor for a binary file', async () => {
    renderTab(textOps());
    await openFile('logo.png');

    expect(await screen.findByText('logo.png is a binary file.')).toBeInTheDocument();
    expect(screen.queryByTestId('code-viewer')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close file' }));
    expect(screen.queryByText('logo.png is a binary file.')).not.toBeInTheDocument();
  });

  it('shows the read error for a file that is too large, and can still close it', async () => {
    renderTab(textOps());
    await openFile('big.log');

    expect(await screen.findByText('File exceeds the 2 MiB limit')).toBeInTheDocument();
    expect(screen.queryByTestId('code-viewer')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close file' }));
    expect(screen.queryByText('File exceeds the 2 MiB limit')).not.toBeInTheDocument();
  });

  it('shows a loading line until the file arrives, with the close button already there', async () => {
    let resolve: (r: ReadResult) => void = () => {};
    renderTab(makeOps(() => new Promise<ReadResult>((r) => (resolve = r))));
    await openFile('README.md');

    expect(screen.getByText(/Loading README\.md/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close file' })).toBeInTheDocument();

    await act(async () => resolve({ content: 'late', binary: false }));
    expect(await screen.findByTestId('code-viewer')).toHaveTextContent('late');
  });

  it('switches to another file', async () => {
    renderTab(textOps());
    await openFile('README.md');
    await screen.findByTestId('code-viewer');
    await openFile('src');
    await openFile('app.ts');

    expect(await screen.findByText('contents of src/app.ts')).toBeInTheDocument();
    expect(screen.queryByText('contents of README.md')).not.toBeInTheDocument();
  });
});
