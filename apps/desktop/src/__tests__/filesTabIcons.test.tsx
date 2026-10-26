/**
 * @jest-environment jsdom
 */
import '@testing-library/jest-dom';
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Workbench } from '@talyn/shared';
import type { WorkbenchOps } from '../renderer/lib/workbenchOps';
import { FilesTab } from '../renderer/components/workbench/FilesTab';

jest.mock('../renderer/lib/fileIconUrl', () => ({
  loadFileIconUrl: async (name: string) => `/icons/${name}.svg`,
}));

const ops = {
  unavailable: null,
  listFiles: jest.fn(async () => ['src/app.ts', 'package.json', 'notes.zzzz']),
} as unknown as WorkbenchOps;

afterEach(cleanup);

describe('FilesTab icons', () => {
  it('shows the icon for each file type and folder', async () => {
    const { container } = render(<FilesTab workbench={{ id: 'wb1' } as Workbench} ops={ops} visible />);
    await waitFor(() => expect(container.querySelector('img[src="/icons/nodejs.svg"]')).toBeInTheDocument());
    expect(container.querySelector('img[src="/icons/folder-src.svg"]')).toBeInTheDocument();
    expect(container.querySelector('img[src="/icons/file.svg"]')).toBeInTheDocument();

    fireEvent.click(screen.getByText('src'));
    await waitFor(() => expect(container.querySelector('img[src="/icons/typescript.svg"]')).toBeInTheDocument());
    expect(container.querySelector('img[src="/icons/folder-src-open.svg"]')).toBeInTheDocument();
  });
});
