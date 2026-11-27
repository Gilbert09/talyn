import '@testing-library/jest-dom';
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { defaultMobileNotificationPreferences, type MobileNotificationPreferences, type SpacesTeam } from '@talyn/shared';
import {
  NotificationsSettings,
  PHONE_SAVE_DEBOUNCE_MS,
  validPhonePreferences,
} from '../renderer/components/settings/sections/NotificationsSettings';

import { useSpacesStore } from '../renderer/stores/spaces';

const mockSpaceGet = jest.fn();
const mockSpaceSave = jest.fn();
const mockGet = jest.fn();
const mockUpdate = jest.fn();
const mockWriteDefaults = jest.fn();
const mockSetBlocked = jest.fn();
const mockState: { workspaceId: string | null; notifyOnFinish: boolean; blocked: boolean; spaces: boolean } = {
  workspaceId: 'ws1',
  notifyOnFinish: true,
  blocked: false,
  spaces: false,
};

jest.mock('../renderer/lib/api', () => ({
  api: {
    spaces: {
      notificationPreferences: (...a: unknown[]) => mockSpaceGet(...a),
      setNotificationsMuted: (...a: unknown[]) => mockSpaceSave(...a),
    },
    mobileNotifications: {
      getPreferences: (...a: unknown[]) => mockGet(...a),
      updatePreferences: (...a: unknown[]) => mockUpdate(...a),
    },
  },
}));
jest.mock('../renderer/lib/sessionDefaults', () => ({
  useSessionDefaults: () => ({ notifyOnFinish: mockState.notifyOnFinish }),
  writeSessionDefaults: (...a: unknown[]) => mockWriteDefaults(...a),
}));
jest.mock('../renderer/hooks/useApi', () => ({
  getMergeBlockedNotifyEnabled: () => mockState.blocked,
  setMergeBlockedNotifyEnabled: (...a: unknown[]) => mockSetBlocked(...a),
}));
jest.mock('../renderer/stores/workspace', () => ({
  useWorkspaceStore: (selector: (s: unknown) => unknown) =>
    selector({ currentWorkspaceId: mockState.workspaceId, features: { spaces: mockState.spaces } }),
}));

const prefs = (over: Partial<MobileNotificationPreferences> = {}): MobileNotificationPreferences => ({
  ...defaultMobileNotificationPreferences('ws1'),
  ...over,
});

const checkbox = (name: string) => screen.getByRole('checkbox', { name: new RegExp(name) });

async function renderLoaded(initial = prefs({ enabled: true })) {
  mockGet.mockResolvedValue({ preferences: initial, providerAvailable: true });
  render(<NotificationsSettings />);
  await screen.findByText('Enable workspace notifications');
}

beforeEach(() => {
  jest.useRealTimers();
  mockSpaceGet.mockReset().mockResolvedValue({ mutedSpaceIds: [] });
  mockSpaceSave.mockReset().mockResolvedValue({ mutedSpaceIds: ['automations'] });
  mockState.spaces = false;
  useSpacesStore.setState({ teams: null, mutedSpaceIds: [], notificationsLoaded: false, notificationsError: null, notificationsSaving: false });
  mockGet.mockReset();
  mockUpdate.mockReset();
  mockWriteDefaults.mockReset();
  mockSetBlocked.mockReset();
  mockState.workspaceId = 'ws1';
  mockState.notifyOnFinish = true;
  mockState.blocked = false;
  mockUpdate.mockImplementation(async (p: MobileNotificationPreferences) => ({ preferences: p, providerAvailable: true }));
});
afterEach(cleanup);

describe('NotificationsSettings: this computer', () => {
  it('shows the two desktop toggles with their stored values', async () => {
    mockState.blocked = true;
    await renderLoaded();
    expect(checkbox('agent finishes')).toBeChecked();
    expect(checkbox('merge-queue PR is blocked')).toBeChecked();
  });

  it.each([
    ['agent finishes', true, () => expect(mockWriteDefaults).toHaveBeenCalledWith({ notifyOnFinish: false })],
    ['merge-queue PR is blocked', false, () => expect(mockSetBlocked).toHaveBeenCalledWith(true)],
  ])('saves the %s toggle', async (name, _initial, assert) => {
    await renderLoaded();
    fireEvent.click(checkbox(name));
    assert();
  });
});

describe('NotificationsSettings: phone', () => {
  it('loads the preferences of the current workspace', async () => {
    await renderLoaded(prefs({ enabled: true, categories: { ...prefs().categories, ci_failure: false } }));
    expect(mockGet).toHaveBeenCalledWith('ws1');
    expect(checkbox('Enable workspace notifications')).toBeChecked();
    expect(checkbox('CI failures')).not.toBeChecked();
    expect(checkbox('PR reviews')).toBeChecked();
  });

  it('disables the details while workspace notifications are off', async () => {
    await renderLoaded(prefs({ enabled: false }));
    expect(checkbox('PR reviews')).toBeDisabled();
    expect(checkbox('away from my computer')).toBeDisabled();
    expect(checkbox('^Quiet hours$')).toBeDisabled();
    expect(screen.getByLabelText('Quiet hours start')).toBeDisabled();
  });

  it('debounces a run of edits into one save with the last value', async () => {
    await renderLoaded();
    jest.useFakeTimers();
    fireEvent.click(checkbox('PR reviews'));
    fireEvent.click(checkbox('CI failures'));
    expect(screen.getByText('Saving…')).toBeInTheDocument();
    expect(mockUpdate).not.toHaveBeenCalled();
    await act(async () => {
      jest.advanceTimersByTime(PHONE_SAVE_DEBOUNCE_MS);
    });
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockUpdate.mock.calls[0][0].categories).toMatchObject({ pr_review: false, ci_failure: false });
    jest.useRealTimers();
    expect(await screen.findByText('Saved.')).toBeInTheDocument();
  });

  it('saves a pending edit when the page closes', async () => {
    await renderLoaded();
    jest.useFakeTimers();
    fireEvent.click(checkbox('away from my computer'));
    cleanup();
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockUpdate.mock.calls[0][0].onlyWhenAway).toBe(false);
  });

  it('reports a failed save', async () => {
    mockUpdate.mockRejectedValue(new Error('down'));
    await renderLoaded();
    fireEvent.click(checkbox('PR reviews'));
    expect(await screen.findByText('Settings could not be saved. Try again.', {}, { timeout: 2000 })).toBeInTheDocument();
  });

  it('turning on quiet hours moves a UTC schedule to the local timezone', async () => {
    const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
    await renderLoaded(prefs({ enabled: true, timezone: 'UTC' }));
    jest.useFakeTimers();
    fireEvent.click(checkbox('^Quiet hours$'));
    await act(async () => {
      jest.advanceTimersByTime(PHONE_SAVE_DEBOUNCE_MS);
    });
    const saved = mockUpdate.mock.calls[0][0] as MobileNotificationPreferences;
    expect(saved.quietHours.enabled).toBe(true);
    expect(saved.timezone).toBe(local);
  });

  it('edits the quiet hours times', async () => {
    await renderLoaded(prefs({ enabled: true, quietHours: { enabled: true, start: '22:00', end: '08:00' } }));
    jest.useFakeTimers();
    fireEvent.change(screen.getByLabelText('Quiet hours start'), { target: { value: '21:30' } });
    await act(async () => {
      jest.advanceTimersByTime(PHONE_SAVE_DEBOUNCE_MS);
    });
    expect(mockUpdate.mock.calls[0][0].quietHours).toEqual({ enabled: true, start: '21:30', end: '08:00' });
  });

  it('shows a retry when the preferences do not load', async () => {
    mockGet.mockRejectedValueOnce(new Error('down'));
    render(<NotificationsSettings />);
    const retry = await screen.findByRole('button', { name: 'Retry' });
    mockGet.mockResolvedValue({ preferences: prefs(), providerAvailable: true });
    fireEvent.click(retry);
    expect(await screen.findByText('Enable workspace notifications')).toBeInTheDocument();
  });

  it('warns when push delivery is not available', async () => {
    mockGet.mockResolvedValue({ preferences: prefs(), providerAvailable: false });
    render(<NotificationsSettings />);
    expect(await screen.findByText(/Push delivery is not available/)).toBeInTheDocument();
  });
});

describe('validPhonePreferences', () => {
  it.each([
    [{}, true],
    [{ timezone: 'Europe/London' }, true],
    [{ timezone: 'Not/AZone' }, false],
    [{ quietHours: { enabled: true, start: '24:00', end: '08:00' } }, false],
    [{ quietHours: { enabled: true, start: '22:00', end: '8:00' } }, false],
    [{ quietHours: { enabled: true, start: '', end: '08:00' } }, false],
  ])('%j -> %s', (over, expected) => {
    expect(validPhonePreferences(prefs(over as Partial<MobileNotificationPreferences>))).toBe(expected);
  });
});


describe('NotificationsSettings: team spaces', () => {
  beforeEach(() => {
    mockState.spaces = true;
    useSpacesStore.setState({ teams: [{
      id: 'team', name: 'Team', spaces: [
        { id: 'automations', name: 'Automations' },
        { id: 'work', name: 'Work' },
      ],
    }] as SpacesTeam[] });
  });

  it('loads the personal preferences and saves a space mute', async () => {
    await renderLoaded();
    await waitFor(() => expect(mockSpaceGet).toHaveBeenCalledTimes(1));
    expect(checkbox('^Automations$')).toBeChecked();
    fireEvent.click(checkbox('^Automations$'));
    await waitFor(() => expect(checkbox('^Automations$')).not.toBeChecked());
    expect(mockSpaceSave).toHaveBeenCalledWith('automations', true);
    expect(checkbox('^Work$')).toBeChecked();
  });

  it('turns notifications back on for a muted space', async () => {
    mockSpaceGet.mockResolvedValue({ mutedSpaceIds: ['automations'] });
    mockSpaceSave.mockResolvedValue({ mutedSpaceIds: [] });
    await renderLoaded();
    await waitFor(() => expect(checkbox('^Automations$')).not.toBeChecked());
    fireEvent.click(checkbox('^Automations$'));
    await waitFor(() => expect(checkbox('^Automations$')).toBeChecked());
    expect(mockSpaceSave).toHaveBeenCalledWith('automations', false);
  });

  it('restores the previous preference when a save fails', async () => {
    mockSpaceSave.mockRejectedValue(new Error('offline'));
    await renderLoaded();
    fireEvent.click(checkbox('^Automations$'));
    await waitFor(() => expect(mockSpaceSave).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(checkbox('^Automations$')).toBeChecked());
    expect(checkbox('^Work$')).toBeChecked();
  });
  it('disables every space while a save is pending', async () => {
    let finish!: (value: { mutedSpaceIds: string[] }) => void;
    mockSpaceSave.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    await renderLoaded();
    fireEvent.click(checkbox('^Automations$'));
    expect(checkbox('^Automations$')).toBeDisabled();
    expect(checkbox('^Work$')).toBeDisabled();
    fireEvent.click(checkbox('^Work$'));
    expect(mockSpaceSave).toHaveBeenCalledTimes(1);
    await act(async () => { finish({ mutedSpaceIds: ['automations'] }); });
    expect(checkbox('^Automations$')).not.toBeDisabled();
    expect(checkbox('^Automations$')).not.toBeChecked();
    expect(checkbox('^Work$')).toBeChecked();
  });

  it('disables space edits until the preferences load and offers a retry', async () => {
    mockSpaceGet.mockRejectedValueOnce(new Error('offline'));
    await renderLoaded();
    const retry = await screen.findByRole('button', { name: 'Retry' });
    expect(checkbox('^Automations$')).toBeDisabled();
    expect(mockSpaceSave).not.toHaveBeenCalled();
    mockSpaceGet.mockResolvedValue({ mutedSpaceIds: ['automations'] });
    fireEvent.click(retry);
    await waitFor(() => expect(checkbox('^Automations$')).not.toBeDisabled());
    expect(checkbox('^Automations$')).not.toBeChecked();
  });

});
