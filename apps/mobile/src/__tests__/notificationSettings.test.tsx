import { fireEvent, render, screen } from '@testing-library/react-native';
import { defaultMobileNotificationPreferences } from '@talyn/shared';

import { NotificationSettings } from '../notifications/Settings';
import type { NotificationController, PushSnapshot } from '../notifications/controller';

function fixture(state: PushSnapshot['state'] = 'disabled', enabled = false) {
  const snapshot: PushSnapshot = { state, preferences: { ...defaultMobileNotificationPreferences('workspace'), enabled },
    providerAvailable: true, tapIssue: null };
  const controller = { getSnapshot: () => snapshot, subscribe: () => () => {},
    enableDevice: jest.fn(), save: jest.fn(), refresh: jest.fn() };
  return { controller, render: (offline = false) => render(<NotificationSettings controller={controller as unknown as NotificationController} offline={offline} />) };
}

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
    expect(screen.getByRole('button', { name: 'Save notification settings' })).toBeDisabled();
    expect(screen.getByRole('switch', { name: 'Enable workspace notifications' })).toBeDisabled();
  });
  it('edits categories, quiet hours, timezone, and reserved preview preferences', async () => {
    const f = fixture('ready', true); await f.render();
    await fireEvent(screen.getByRole('switch', { name: 'CI failures' }), 'valueChange', false);
    await fireEvent(screen.getByRole('switch', { name: 'Quiet hours' }), 'valueChange', true);
    await fireEvent.changeText(screen.getByLabelText('Quiet hours start'), '21:30');
    await fireEvent.changeText(screen.getByLabelText('Quiet hours end'), '07:00');
    await fireEvent.changeText(screen.getByLabelText('Notification timezone'), 'America/New_York');
    await fireEvent(screen.getByRole('switch', { name: 'Sensitive preview preference' }), 'valueChange', true);
    await fireEvent.press(screen.getByRole('button', { name: 'Save notification settings' }));
    expect(f.controller.save).toHaveBeenCalledWith(expect.objectContaining({
      categories: expect.objectContaining({ ci_failure: false }), quietHours: { enabled: true, start: '21:30', end: '07:00' },
      timezone: 'America/New_York', sensitivePreview: true,
    }));
    expect(screen.getByText(/All alerts currently use generic text/)).toBeVisible();
  });
  it.each([['Quiet hours start', '25:90'], ['Notification timezone', 'not-a-timezone']])('announces invalid %s', async (label, value) => {
    const f = fixture('ready', true); await f.render(); await fireEvent.changeText(screen.getByLabelText(label), value);
    await fireEvent.press(screen.getByRole('button', { name: 'Save notification settings' }));
    expect(screen.getByRole('alert', { name: 'Use a valid timezone and times in HH:MM format.' })).toBeVisible();
    expect(f.controller.save).not.toHaveBeenCalled();
  });
});
