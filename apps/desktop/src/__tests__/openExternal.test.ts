import { isOpenInBrowserClick, openExternal } from '../renderer/lib/openExternal';

describe('isOpenInBrowserClick', () => {
  it.each([
    ['plain left click', { metaKey: false, ctrlKey: false, button: 0 }, false],
    ['cmd-click', { metaKey: true, ctrlKey: false, button: 0 }, true],
    ['ctrl-click', { metaKey: false, ctrlKey: true, button: 0 }, true],
    ['middle click', { metaKey: false, ctrlKey: false, button: 1 }, true],
    ['right click', { metaKey: false, ctrlKey: false, button: 2 }, false],
  ])('%s → %s', (_label, event, expected) => {
    expect(isOpenInBrowserClick(event)).toBe(expected);
  });
});

describe('openExternal', () => {
  const url = 'https://github.com/acme/repo/pull/1';
  const originalElectron = (window as unknown as { electron?: unknown }).electron;
  const originalOpen = window.open;

  afterEach(() => {
    (window as unknown as { electron?: unknown }).electron = originalElectron;
    window.open = originalOpen;
  });

  it('routes through the Electron bridge when available', async () => {
    const openExternalBridge = jest.fn().mockResolvedValue(undefined);
    (window as unknown as { electron?: unknown }).electron = {
      auth: { openExternal: openExternalBridge },
    };
    const windowOpen = jest.fn();
    window.open = windowOpen as unknown as typeof window.open;

    await openExternal(url);

    expect(openExternalBridge).toHaveBeenCalledWith(url);
    expect(windowOpen).not.toHaveBeenCalled();
  });

  it('falls back to window.open without the Electron bridge', async () => {
    (window as unknown as { electron?: unknown }).electron = undefined;
    const windowOpen = jest.fn();
    window.open = windowOpen as unknown as typeof window.open;

    await openExternal(url);

    expect(windowOpen).toHaveBeenCalledWith(url, '_blank', 'noopener,noreferrer');
  });
});
