import '@testing-library/jest-dom';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { AppearanceSettings } from '../renderer/components/settings/sections/AppearanceSettings';
import { buildAppShortcuts } from '../renderer/components/layout/appShortcuts';
import { clearShortcuts, registerShortcuts, runShortcut } from '../renderer/lib/shortcuts';
import { nextZoomFactor, type ZoomStep } from '../main/zoomSteps';

type ZoomBridge = {
  get: jest.Mock<Promise<number>, []>;
  step: jest.Mock<Promise<number>, [ZoomStep]>;
  onChange: jest.Mock<() => void, [(factor: number) => void]>;
};

let factor = 1;
let listener: ((f: number) => void) | null = null;
let zoom: ZoomBridge;

function installBridge(start: number) {
  factor = start;
  listener = null;
  zoom = {
    get: jest.fn(async () => factor),
    step: jest.fn(async (step: ZoomStep) => {
      factor = nextZoomFactor(factor, step);
      return factor;
    }),
    onChange: jest.fn((cb: (f: number) => void) => {
      listener = cb;
      return () => {
        listener = null;
      };
    }),
  };
  (window as unknown as { electron: unknown }).electron = { zoom };
}

afterEach(() => {
  delete (window as unknown as { electron?: unknown }).electron;
  clearShortcuts();
});

async function renderSettings() {
  render(<AppearanceSettings />);
  return screen.findByText(`${Math.round(factor * 100)}%`);
}

describe('Appearance → Zoom', () => {
  it('shows the saved size and steps it with the buttons', async () => {
    installBridge(1.1);
    await renderSettings();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    });
    expect(zoom.step).toHaveBeenLastCalledWith('in');
    expect(screen.getByText('125%')).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
    });
    expect(zoom.step).toHaveBeenLastCalledWith('out');
    expect(screen.getByText('110%')).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    });
    expect(zoom.step).toHaveBeenLastCalledWith('reset');
    expect(screen.getByText('100%')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reset' })).toBeDisabled();
  });

  it.each([
    [0.5, 'Zoom out'],
    [2, 'Zoom in'],
  ])('at %s disables %s', async (start, name) => {
    installBridge(start);
    await renderSettings();
    expect(screen.getByRole('button', { name })).toBeDisabled();
  });

  it('follows a change made from the menu or the keyboard', async () => {
    installBridge(1);
    await renderSettings();
    act(() => listener?.(1.5));
    expect(screen.getByText('150%')).toBeInTheDocument();
  });

  it('is hidden outside the desktop bridge', () => {
    render(<AppearanceSettings />);
    expect(screen.queryByText('Zoom')).not.toBeInTheDocument();
  });
});

describe('zoom menu commands', () => {
  it.each([
    ['view.zoomIn', 'in'],
    ['view.zoomOut', 'out'],
    ['view.zoomReset', 'reset'],
  ] as const)('%s asks the main process to zoom %s', (id, step) => {
    installBridge(1);
    registerShortcuts(buildAppShortcuts());
    runShortcut(id);
    expect(zoom.step).toHaveBeenCalledWith(step);
  });
});
