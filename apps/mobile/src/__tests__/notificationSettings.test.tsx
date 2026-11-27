import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { defaultMobileNotificationPreferences, type MobileNotificationPreferences } from '@talyn/shared';

import { deviceTimezone, NotificationSettings, SAVE_DEBOUNCE, shiftTime, validPreferences } from '../notifications/Settings';
import type { PushState } from '../notifications/controller';

function fixture(state: PushState = 'disabled', enabled = false, patch: Partial<MobileNotificationPreferences> = {}) {
  const controller = {
    loadWorkspaceSettings: jest.fn(async (workspaceId: string) => ({
      state, preferences: { ...defaultMobileNotificationPreferences(workspaceId), enabled, ...patch }, providerAvailable: true,
    })),
    saveWorkspaceSettings: jest.fn(async (preferences: MobileNotificationPreferences, permission?: boolean) => ({
      state: permission ? 'ready' as const : state, preferences, providerAvailable: true,
    })),
  };
  const ui = (offline = false, workspaceId = 'workspace') => <NotificationSettings key={workspaceId}
    controller={controller} offline={offline} workspaceId={workspaceId} />;
  return { controller, ui, render: (offline = false) => render(ui(offline)) };
}
const flush = async () => { await act(async () => { jest.advanceTimersByTime(SAVE_DEBOUNCE); }); };

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

describe('accessible notification settings', () => {
  it('explains value and permission before explicit device opt-in', async () => {
    const f = fixture(); await f.render();
    expect(screen.getByRole('header', { name: 'Phone notifications' })).toBeVisible();
    expect(screen.getByText('Alerts show the session or pull request name and a short summary.')).toBeVisible();
    expect(screen.getByRole('switch', { name: 'Session updates' })).toBeDisabled();
    expect(f.controller.saveWorkspaceSettings).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByRole('button', { name: 'Enable notifications on this device' }));
    expect(f.controller.saveWorkspaceSettings).toHaveBeenCalledWith(expect.objectContaining({ enabled: true, workspaceId: 'workspace' }), true);
    expect(screen.getByRole('switch', { name: 'Session updates' })).toBeEnabled();
  });
  it.each([
    ['denied', /permission is denied/], ['unavailable', /provider or device configuration/], ['failed', /registration or settings failed/],
  ] as const)('announces the %s state without private diagnostics', async (state, message) => {
    const f = fixture(state); await f.render(); expect(screen.getByRole('alert', { name: message })).toBeVisible();
  });
  it('keeps controls hidden before settings load', async () => {
    const f = fixture('ready', true);
    f.controller.loadWorkspaceSettings.mockReturnValueOnce(new Promise(() => {}));
    await f.render();
    expect(screen.queryByRole('switch', { name: 'Enable workspace notifications' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save notification settings' })).toBeNull();
  });
  it('waits for an internet connection before loading settings', async () => {
    const f = fixture('ready', true);
    const view = await f.render(true);
    expect(screen.getByRole('alert', { name: /You are offline/ })).toBeVisible();
    expect(f.controller.loadWorkspaceSettings).not.toHaveBeenCalled();
    expect(screen.queryByRole('switch', { name: 'Enable workspace notifications' })).toBeNull();
    await view.rerender(f.ui());
    expect(f.controller.loadWorkspaceSettings).toHaveBeenCalledWith('workspace');
    expect(screen.getByRole('switch', { name: 'Enable workspace notifications' })).toBeEnabled();
    await view.rerender(f.ui(true));
    expect(screen.getByRole('switch', { name: 'Enable workspace notifications' })).toBeDisabled();
  });
  it.each(['Session updates', 'Quiet hours'])('disables %s while workspace notifications are off', async (label) => {
    const f = fixture('ready', false); await f.render();
    expect(screen.getByRole('switch', { name: label })).toBeDisabled();
  });
  it('shows the away-only switch on by default with its explanation', async () => {
    const f = fixture('ready', true); await f.render();
    const away = screen.getByRole('switch', { name: "Only when I'm away from my computer" });
    expect(away).toBeEnabled();
    expect(away.props.value).toBe(true);
    expect(screen.getByText('Talyn on your computer shows the alert instead while you are using it.')).toBeVisible();
  });
  it.each([true, false])('saves onlyWhenAway when switched to %s', async (value) => {
    const f = fixture('ready', true, { onlyWhenAway: !value }); await f.render();
    await fireEvent(screen.getByRole('switch', { name: "Only when I'm away from my computer" }), 'valueChange', value);
    await flush();
    expect(f.controller.saveWorkspaceSettings).toHaveBeenCalledWith(expect.objectContaining({ onlyWhenAway: value, enabled: true }), false);
  });
  it('disables the away-only switch while workspace notifications are off', async () => {
    const f = fixture('ready', false); await f.render();
    expect(screen.getByRole('switch', { name: "Only when I'm away from my computer" })).toBeDisabled();
  });
  it('saves once after a run of edits, without a save button', async () => {
    const f = fixture('ready', true); await f.render();
    await fireEvent(screen.getByRole('switch', { name: 'CI failures' }), 'valueChange', false);
    await fireEvent(screen.getByRole('switch', { name: 'PR reviews' }), 'valueChange', false);
    expect(screen.getByText('Saving…')).toBeVisible();
    expect(f.controller.saveWorkspaceSettings).not.toHaveBeenCalled();
    await flush();
    expect(f.controller.saveWorkspaceSettings).toHaveBeenCalledTimes(1);
    expect(f.controller.saveWorkspaceSettings).toHaveBeenCalledWith(expect.objectContaining({
      categories: expect.objectContaining({ ci_failure: false, pr_review: false }), sensitivePreview: false,
    }), false);
    expect(await screen.findByText('Saved.')).toBeVisible();
  });
  it.each(['back', 'workspace switch'])('saves an edit before debounce on %s', async (action) => {
    const f = fixture('ready', true);
    const view = await f.render();
    await fireEvent(screen.getByRole('switch', { name: 'CI failures' }), 'valueChange', false);
    expect(f.controller.saveWorkspaceSettings).not.toHaveBeenCalled();
    if (action === 'back') {
      await view.unmount();
    } else {
      await view.rerender(f.ui(false, 'other'));
      expect(f.controller.loadWorkspaceSettings).toHaveBeenLastCalledWith('other');
      expect(screen.getByRole('switch', { name: 'CI failures' }).props.value).toBe(true);
    }
    expect(f.controller.saveWorkspaceSettings).toHaveBeenCalledTimes(1);
    expect(f.controller.saveWorkspaceSettings).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 'workspace', categories: expect.objectContaining({ ci_failure: false }),
    }));
    await flush();
    expect(f.controller.saveWorkspaceSettings).toHaveBeenCalledTimes(1);
  });
  it('defaults quiet hours to the device timezone and steps times by 30 minutes', async () => {
    const f = fixture('ready', true); await f.render();
    await fireEvent(screen.getByRole('switch', { name: 'Quiet hours' }), 'valueChange', true);
    await fireEvent.press(screen.getByRole('button', { name: 'Quiet hours start later' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Quiet hours end earlier' }));
    await flush();
    expect(f.controller.saveWorkspaceSettings).toHaveBeenLastCalledWith(expect.objectContaining({
      quietHours: { enabled: true, start: '22:30', end: '07:30' },
      timezone: deviceTimezone() === 'UTC' ? 'UTC' : deviceTimezone(),
    }), false);
  });
  it('offers the device timezone when the saved one differs', async () => {
    const f = fixture('ready', true, { timezone: deviceTimezone() === 'Pacific/Auckland' ? 'America/New_York' : 'Pacific/Auckland' });
    await f.render();
    await fireEvent.press(screen.getByRole('button', { name: new RegExp("Use this device's timezone") }));
    await flush();
    expect(f.controller.saveWorkspaceSettings).toHaveBeenCalledWith(expect.objectContaining({ timezone: deviceTimezone() }), false);
  });
  it('announces an invalid saved timezone and does not save it', async () => {
    const f = fixture('ready', true, { timezone: 'not-a-timezone' }); await f.render();
    await fireEvent(screen.getByRole('switch', { name: 'CI failures' }), 'valueChange', false);
    await flush();
    expect(screen.getByRole('alert', { name: 'Use a valid timezone and times in HH:MM format.' })).toBeVisible();
    expect(f.controller.saveWorkspaceSettings).not.toHaveBeenCalled();
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
