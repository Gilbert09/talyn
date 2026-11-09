import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { defaultMobileNotificationPreferences, type MobileNotificationPreferences } from '@talyn/shared';

import { deviceTimezone, NotificationSettings, SAVE_DEBOUNCE, shiftTime, validPreferences } from '../notifications/Settings';
import type { NotificationController, PushSnapshot } from '../notifications/controller';

function fixture(state: PushSnapshot['state'] = 'disabled', enabled = false, patch: Partial<MobileNotificationPreferences> = {}) {
  const snapshot: PushSnapshot = { state, preferences: { ...defaultMobileNotificationPreferences('workspace'), enabled, ...patch },
    providerAvailable: true, tapIssue: null };
  const controller = { getSnapshot: () => snapshot, subscribe: () => () => {},
    enableDevice: jest.fn(), save: jest.fn(async () => {}), refresh: jest.fn() };
  return { controller, render: (offline = false) => render(<NotificationSettings controller={controller as unknown as NotificationController} offline={offline} />) };
}
const flush = async () => { await act(async () => { jest.advanceTimersByTime(SAVE_DEBOUNCE); }); };

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

describe('accessible notification settings', () => {
  it('explains value and permission before explicit device opt-in', async () => {
    const f = fixture(); await f.render();
    expect(screen.getByRole('header', { name: 'Notifications' })).toBeVisible();
    expect(screen.getByText(/Every workflow works without notifications/)).toBeVisible();
    expect(f.controller.enableDevice).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByRole('button', { name: 'Enable notifications on this device' }));
    expect(f.controller.enableDevice).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('switch', { name: 'Session updates' })).toBeDisabled();
  });
  it.each([
    ['denied', /permission is denied/], ['unavailable', /provider or device configuration/], ['failed', /registration or settings failed/],
  ] as const)('announces the %s state without private diagnostics', async (state, message) => {
    const f = fixture(state); await f.render(); expect(screen.getByRole('alert', { name: message })).toBeVisible();
  });
  it.each(['loading', 'offline'] as const)('disables writes when %s', async (condition) => {
    const f = fixture(condition === 'loading' ? 'loading' : 'ready', true); await f.render(condition === 'offline');
    expect(screen.getByRole('switch', { name: 'Enable workspace notifications' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save notification settings' })).toBeNull();
  });
  it.each(['Session updates', 'Quiet hours'])('disables %s while workspace notifications are off', async (label) => {
    const f = fixture('ready', false); await f.render();
    expect(screen.getByRole('switch', { name: label })).toBeDisabled();
  });
  it('saves once after a run of edits, without a save button', async () => {
    const f = fixture('ready', true); await f.render();
    await fireEvent(screen.getByRole('switch', { name: 'CI failures' }), 'valueChange', false);
    await fireEvent(screen.getByRole('switch', { name: 'PR reviews' }), 'valueChange', false);
    expect(screen.getByText('Saving…')).toBeVisible();
    expect(f.controller.save).not.toHaveBeenCalled();
    await flush();
    expect(f.controller.save).toHaveBeenCalledTimes(1);
    expect(f.controller.save).toHaveBeenCalledWith(expect.objectContaining({
      categories: expect.objectContaining({ ci_failure: false, pr_review: false }), sensitivePreview: false,
    }));
    expect(await screen.findByText('Saved.')).toBeVisible();
  });
  it('defaults quiet hours to the device timezone and steps times by 30 minutes', async () => {
    const f = fixture('ready', true); await f.render();
    await fireEvent(screen.getByRole('switch', { name: 'Quiet hours' }), 'valueChange', true);
    await fireEvent.press(screen.getByRole('button', { name: 'Quiet hours start later' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Quiet hours end earlier' }));
    await flush();
    expect(f.controller.save).toHaveBeenLastCalledWith(expect.objectContaining({
      quietHours: { enabled: true, start: '22:30', end: '07:30' },
      timezone: deviceTimezone() === 'UTC' ? 'UTC' : deviceTimezone(),
    }));
  });
  it('offers the device timezone when the saved one differs', async () => {
    const f = fixture('ready', true, { timezone: deviceTimezone() === 'Pacific/Auckland' ? 'America/New_York' : 'Pacific/Auckland' });
    await f.render();
    await fireEvent.press(screen.getByRole('button', { name: new RegExp("Use this device's timezone") }));
    await flush();
    expect(f.controller.save).toHaveBeenCalledWith(expect.objectContaining({ timezone: deviceTimezone() }));
  });
  it('announces an invalid saved timezone and does not save it', async () => {
    const f = fixture('ready', true, { timezone: 'not-a-timezone' }); await f.render();
    await fireEvent(screen.getByRole('switch', { name: 'CI failures' }), 'valueChange', false);
    await flush();
    expect(screen.getByRole('alert', { name: 'Use a valid timezone and times in HH:MM format.' })).toBeVisible();
    expect(f.controller.save).not.toHaveBeenCalled();
  });
  it('has no placeholder preview setting', async () => {
    const f = fixture('ready', true); await f.render();
    expect(screen.queryByText(/Sensitive preview/)).toBeNull();
  });
});

describe('notification setting helpers', () => {
  it.each([
    ['22:00', 30, '22:30'], ['23:30', 30, '00:00'], ['00:00', -30, '23:30'], ['08:15', -30, '07:45'], ['bad', 30, '00:30'],
  ])('shifts %s by %i minutes to %s', (value, minutes, expected) => expect(shiftTime(value, minutes)).toBe(expected));
  it.each([
    [{ timezone: 'Europe/London', start: '22:00', end: '08:00' }, true],
    [{ timezone: 'not-a-timezone', start: '22:00', end: '08:00' }, false],
    [{ timezone: 'UTC', start: '25:00', end: '08:00' }, false],
    [{ timezone: 'UTC', start: '22:00', end: '8:00' }, false],
  ])('validates %o', ({ timezone, start, end }, expected) => {
    const value = { ...defaultMobileNotificationPreferences('workspace'), timezone, quietHours: { enabled: true, start, end } };
    expect(validPreferences(value)).toBe(expected);
  });
});
