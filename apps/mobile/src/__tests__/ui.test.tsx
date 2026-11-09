import { fireEvent, render, renderHook, screen } from '@testing-library/react-native';
import { NavigationBar } from 'expo-navigation-bar';
import * as SystemUI from 'expo-system-ui';
import * as ReactNative from 'react-native';

import { Button, Disclosure, Input, ListRow, Notice } from '../components/UI';
import { SystemChrome } from '../components/SystemChrome';
import { themeForScheme, useTheme } from '../theme/tokens';

jest.mock('expo-navigation-bar', () => ({ NavigationBar: jest.fn(() => null) }));
jest.mock('expo-system-ui', () => ({ setBackgroundColorAsync: jest.fn(async () => {}) }));
afterEach(() => jest.restoreAllMocks());

function luminance(hex: string) {
  const channels = [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16) / 255)
    .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}
function contrast(first: string, second: string) {
  const values = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

describe('Talyn mobile theme', () => {
  it.each(['light', 'dark'] as const)('follows the %s system theme and configures system chrome', async (mode) => {
    jest.spyOn(ReactNative, 'useColorScheme').mockReturnValue(mode);
    const { result } = await renderHook(useTheme);
    expect(result.current.mode).toBe(mode);
    expect(result.current.statusBarStyle).toBe(mode === 'dark' ? 'light-content' : 'dark-content');
    await render(<SystemChrome />);
    expect(SystemUI.setBackgroundColorAsync).toHaveBeenLastCalledWith(result.current.background);
    expect(NavigationBar).toHaveBeenLastCalledWith(expect.objectContaining({ style: mode === 'dark' ? 'light' : 'dark' }), undefined);
  });
  it.each([null, undefined, 'unspecified'])('uses light colors when the system theme is %s', (mode) => {
    expect(themeForScheme(mode).mode).toBe('light');
  });
  it.each(['light', 'dark'])('keeps %s text and semantic colors readable on every surface', (mode) => {
    const c = themeForScheme(mode);
    for (const surface of [c.background, c.paper, c.elevated]) {
      for (const foreground of [c.text, c.muted, c.primaryAction, c.destructive, c.success, c.warning, c.information]) {
        expect(contrast(foreground, surface)).toBeGreaterThanOrEqual(4.5);
      }
    }
    expect(contrast(c.primaryText, c.primaryAction)).toBeGreaterThanOrEqual(4.5);
  });
});

describe('native controls', () => {
  it.each(['primary', 'secondary', 'quiet', 'destructive'] as const)('supports the enabled and disabled %s action', async (variant) => {
    const press = jest.fn();
    const view = await render(<Button title="Continue" variant={variant} onPress={press} />);
    await fireEvent.press(screen.getByRole('button', { name: 'Continue' }));
    expect(press).toHaveBeenCalledTimes(1);
    await view.rerender(<Button title="Continue" variant={variant} onPress={press} disabled />);
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
    await fireEvent.press(screen.getByRole('button', { name: 'Continue' }));
    expect(press).toHaveBeenCalledTimes(1);
  });
  it('exposes workspace selection and keeps long names available', async () => {
    const press = jest.fn();
    const name = 'A workspace with a long name for a small phone';
    await render(<ListRow title={name} selected onPress={press} accessibilityLabel={`Select workspace ${name}`} />);
    expect(screen.getByRole('button', { selected: true })).toHaveAccessibleName(`Select workspace ${name}`);
    await fireEvent.press(screen.getByRole('button'));
    expect(press).toHaveBeenCalledTimes(1);
  });
  it('announces errors and supplies an accessible recovery action', async () => {
    const retry = jest.fn();
    await render(<Notice message="Could not load this view." alert><Button title="Try again" onPress={retry} /></Notice>);
    expect(screen.getByRole('alert', { name: 'Could not load this view.' })).toBeVisible();
    await fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
    expect(retry).toHaveBeenCalledTimes(1);
  });
  it('labels progress without exposing a false error', async () => {
    await render(<Notice message="Loading workspaces" loading />);
    expect(screen.getByLabelText('Loading')).toBeVisible();
    expect(screen.queryByRole('alert')).toBeNull();
  });
  it('keeps secondary details available through an accessible disclosure', async () => {
    await render(<Disclosure title="Account details"><Input accessibilityLabel="Account reference" value="reference" editable={false} /></Disclosure>);
    expect(screen.getByRole('button', { expanded: false })).toBeVisible();
    expect(screen.queryByLabelText('Account reference')).toBeNull();
    await fireEvent.press(screen.getByRole('button'));
    expect(screen.getByRole('button', { expanded: true })).toBeVisible();
    expect(screen.getByDisplayValue('reference')).toBeVisible();
  });
});
