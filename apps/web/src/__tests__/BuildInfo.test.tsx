import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { BuildInfo } from '../components/panels/BuildInfo';

const { mockOpenExternal, mockToastSuccess, mockToastError } = vi.hoisted(() => ({
  mockOpenExternal: vi.fn(),
  mockToastSuccess: vi.fn(),
  mockToastError: vi.fn(),
}));
vi.mock('../lib/openExternal', () => ({
  openExternal: (url: string) => mockOpenExternal(url),
}));
vi.mock('../stores/toast', () => ({
  toast: {
    success: (title: string) => mockToastSuccess(title),
    error: (title: string) => mockToastError(title),
  },
}));

const SHA = '0123456789abcdef0123456789abcdef01234567';
const URL = `https://github.com/Gilbert09/talyn/commit/${SHA}`;

describe('BuildInfo', () => {
  const writeText = vi.fn();

  beforeEach(() => {
    Object.assign(navigator, { clipboard: { writeText } });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('shows the short SHA and links to the commit on GitHub', () => {
    render(<BuildInfo commit={SHA} />);

    expect(screen.getByTestId('build-version').textContent).toMatch(/^web\//);
    const link = screen.getByTestId('build-commit-link');
    expect(link.textContent).toBe('0123456');
    expect(link.getAttribute('title')).toBe(SHA);
    expect(link.getAttribute('href')).toBe(URL);

    fireEvent.click(link);
    expect(mockOpenExternal).toHaveBeenCalledWith(URL);
  });

  it.each([
    ['success', () => writeText.mockResolvedValue(undefined), mockToastSuccess],
    ['failure', () => writeText.mockRejectedValue(new Error('denied')), mockToastError],
  ])('copies the full SHA and reports %s', async (_name, arrange, toastFn) => {
    arrange();
    render(<BuildInfo commit={SHA} />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy the full commit SHA' }));
    });
    expect(writeText).toHaveBeenCalledWith(SHA);
    expect(toastFn).toHaveBeenCalledTimes(1);
  });

  it('shows Unknown and no link when the build has no commit', () => {
    render(<BuildInfo commit={null} />);

    expect(screen.getByTestId('build-commit-unknown').textContent).toBe('Unknown');
    expect(screen.queryByTestId('build-commit-link')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Copy the full commit SHA' })).toBeNull();
  });
});
