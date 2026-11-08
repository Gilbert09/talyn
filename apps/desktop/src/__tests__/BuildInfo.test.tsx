import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { BuildInfo } from '../renderer/components/settings/sections/BuildInfo';

const mockOpenExternal = jest.fn();
jest.mock('../renderer/lib/openExternal', () => ({
  openExternal: (url: string) => mockOpenExternal(url),
}));

const mockToastSuccess = jest.fn();
const mockToastError = jest.fn();
jest.mock('../renderer/stores/toast', () => ({
  toast: {
    success: (title: string) => mockToastSuccess(title),
    error: (title: string) => mockToastError(title),
  },
}));

const SHA = '0123456789abcdef0123456789abcdef01234567';

describe('BuildInfo', () => {
  const original = {
    commit: process.env.TALYN_BUILD_COMMIT,
    version: process.env.TALYN_APP_VERSION,
  };
  const writeText = jest.fn();

  beforeEach(() => {
    Object.assign(navigator, { clipboard: { writeText } });
  });

  afterEach(() => {
    cleanup();
    jest.clearAllMocks();
    for (const [key, value] of [
      ['TALYN_BUILD_COMMIT', original.commit],
      ['TALYN_APP_VERSION', original.version],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('shows the short SHA and links to the commit on GitHub', () => {
    process.env.TALYN_BUILD_COMMIT = SHA;
    process.env.TALYN_APP_VERSION = '0.3.20';
    render(<BuildInfo />);

    expect(screen.getByTestId('build-version')).toHaveTextContent('0.3.20');
    const link = screen.getByTestId('build-commit-link');
    expect(link).toHaveTextContent('0123456');
    expect(link).toHaveAttribute('title', SHA);
    expect(link).toHaveAttribute('href', `https://github.com/Gilbert09/talyn/commit/${SHA}`);

    fireEvent.click(link);
    expect(mockOpenExternal).toHaveBeenCalledWith(
      `https://github.com/Gilbert09/talyn/commit/${SHA}`
    );
  });

  it.each([
    ['success', () => writeText.mockResolvedValue(undefined), mockToastSuccess],
    ['failure', () => writeText.mockRejectedValue(new Error('denied')), mockToastError],
  ])('copies the full SHA and reports %s', async (_name, arrange, toastFn) => {
    process.env.TALYN_BUILD_COMMIT = SHA;
    arrange();
    render(<BuildInfo />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy the full commit SHA' }));
    });
    expect(writeText).toHaveBeenCalledWith(SHA);
    expect(toastFn).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['not a full SHA', 'abc1234'],
  ])('shows Unknown and no link when the commit is %s', (_name, value) => {
    if (value === undefined) delete process.env.TALYN_BUILD_COMMIT;
    else process.env.TALYN_BUILD_COMMIT = value;
    render(<BuildInfo />);

    expect(screen.getByTestId('build-commit-unknown')).toHaveTextContent('Unknown');
    expect(screen.queryByTestId('build-commit-link')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Copy the full commit SHA' })).toBeNull();
  });
});
