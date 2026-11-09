import { act, render, renderHook, screen } from '@testing-library/react-native';
import { AccessibilityInfo } from 'react-native';

import { BootScreen } from '../components/BootScreen';
import { OWL_BOOT_LINES, owlArt, useOwlBlink } from '../lib/owl';

beforeEach(() => {
  jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(false);
});

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

describe('owl art', () => {
  it.each([
    ['O   O', ' ( O   O )'],
    ['-   -', ' ( -   - )'],
  ])('renders eyes %s', (eyes, eyeLine) => {
    expect(owlArt(eyes).split('\n')[1]).toBe(eyeLine);
  });

  it.each([0, 1, 2, 3, 4])('keeps line %i the same width in both states', (index) => {
    expect(owlArt('O   O').split('\n')[index].length).toBe(owlArt('-   -').split('\n')[index].length);
  });

  it('has the six desktop boot lines', () => {
    expect(OWL_BOOT_LINES).toHaveLength(6);
  });
});

describe('useOwlBlink', () => {
  it('blinks after the hold and reopens', async () => {
    jest.useFakeTimers();
    jest.spyOn(Math, 'random').mockReturnValue(0.5);
    const { result } = await renderHook(() => useOwlBlink());
    expect(result.current).toBe(false);
    await act(() => jest.advanceTimersByTime(2799));
    expect(result.current).toBe(false);
    await act(() => jest.advanceTimersByTime(1));
    expect(result.current).toBe(true);
    await act(() => jest.advanceTimersByTime(130));
    expect(result.current).toBe(false);
  });

  it('never blinks when disabled', async () => {
    jest.useFakeTimers();
    const { result } = await renderHook(() => useOwlBlink(false));
    await act(() => jest.advanceTimersByTime(10000));
    expect(result.current).toBe(false);
  });
});

describe('BootScreen', () => {
  it('shows the first line and its accessibility label', async () => {
    await render(<BootScreen label="Loading workspace" />);
    expect(screen.getByRole('progressbar', { name: 'Loading workspace' })).toBeTruthy();
    expect(screen.getByText(OWL_BOOT_LINES[0])).toBeTruthy();
  });

  it('keeps the first line when motion is reduced', async () => {
    jest.useFakeTimers();
    jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true);
    await render(<BootScreen />);
    await act(async () => { await Promise.resolve(); });
    await act(() => jest.advanceTimersByTime(5000));
    expect(screen.getByRole('progressbar', { name: 'Starting Talyn' })).toBeTruthy();
    expect(screen.getByText(OWL_BOOT_LINES[0])).toBeTruthy();
    expect(screen.queryByText(OWL_BOOT_LINES[1])).toBeNull();
  });
});
