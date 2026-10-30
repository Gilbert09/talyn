import { Suspense } from 'react';
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lazyWithReload, reloadForStaleChunk } from '../lib/lazyWithReload';

const reload = vi.fn();

beforeEach(() => {
  sessionStorage.clear();
  reload.mockClear();
  vi.stubGlobal('location', { ...window.location, reload });
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('reloadForStaleChunk', () => {
  it('reloads once, then not again inside the window', () => {
    expect(reloadForStaleChunk(1_000_000)).toBe(true);
    expect(reloadForStaleChunk(1_030_000)).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('reloads again after the window has passed', () => {
    expect(reloadForStaleChunk(1_000_000)).toBe(true);
    expect(reloadForStaleChunk(1_061_000)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it('does not reload while offline', () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    expect(reloadForStaleChunk()).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });
});

describe('lazyWithReload', () => {
  it('keeps the Suspense fallback and reloads when the chunk is gone', async () => {
    const Panel = lazyWithReload(() =>
      Promise.reject(new TypeError('Failed to fetch dynamically imported module'))
    );
    await act(async () => {
      render(
        <Suspense fallback={<p>loading</p>}>
          <Panel />
        </Suspense>
      );
    });
    expect(screen.getByText('loading')).toBeTruthy();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('renders the component when the import succeeds', async () => {
    const Panel = lazyWithReload(() =>
      Promise.resolve({ default: () => <p>panel</p> })
    );
    await act(async () => {
      render(
        <Suspense fallback={<p>loading</p>}>
          <Panel />
        </Suspense>
      );
    });
    expect(screen.getByText('panel')).toBeTruthy();
    expect(reload).not.toHaveBeenCalled();
  });
});
