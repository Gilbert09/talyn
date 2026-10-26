import { vi, describe, it, expect, afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Workbench } from '@talyn/shared';
import type { WorkbenchOps } from '../lib/workbenchOps';
import { FilesTab } from '../components/workbench/FilesTab';

const ops = {
  unavailable: null,
  listFiles: vi.fn(async () => ['src/app.ts', 'package.json', 'notes.zzzz']),
} as unknown as WorkbenchOps;

afterEach(cleanup);

describe('FilesTab icons', () => {
  it('shows the icon for each file type and folder', async () => {
    const { container } = render(<FilesTab workbench={{ id: 'wb1' } as Workbench} ops={ops} visible />);
    await waitFor(() => expect(container.querySelector('img[src="/file-icons/nodejs.svg"]')).toBeInTheDocument());
    expect(container.querySelector('img[src="/file-icons/folder-src.svg"]')).toBeInTheDocument();
    expect(container.querySelector('img[src="/file-icons/file.svg"]')).toBeInTheDocument();

    fireEvent.click(screen.getByText('src'));
    await waitFor(() => expect(container.querySelector('img[src="/file-icons/typescript.svg"]')).toBeInTheDocument());
    expect(container.querySelector('img[src="/file-icons/folder-src-open.svg"]')).toBeInTheDocument();
  });
});
