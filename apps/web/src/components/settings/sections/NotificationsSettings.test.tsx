import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultMobileNotificationPreferences, type MobileNotificationPreferences, type SpacesTeam } from '@talyn/shared';
import {
  NotificationsSettings,
  PHONE_SAVE_DEBOUNCE_MS,
  validPhonePreferences,
} from './NotificationsSettings';

import { useSpacesStore } from '../../../stores/spaces';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  spaceGet: vi.fn(),
  spaceSave: vi.fn(),
  spaceCategory: vi.fn(),
  spaceReset: vi.fn(),
  update: vi.fn(),
  writeDefaults: vi.fn(),
  setBlocked: vi.fn(),
  state: { workspaceId: 'ws1' as string | null, notifyOnFinish: true, blocked: false, spaces: false },
}));
const { get: mockGet, update: mockUpdate, writeDefaults: mockWriteDefaults, setBlocked: mockSetBlocked, state: mockState } = mocks;

vi.mock('../../../lib/api', () => ({
  api: {
    spaces: {
      notificationPreferences: (...a: unknown[]) => mocks.spaceGet(...a),
      setNotificationsMuted: (...a: unknown[]) => mocks.spaceSave(...a),
      setPhoneNotificationCategory: (...a: unknown[]) => mocks.spaceCategory(...a),
      setPhoneNotificationCategories: (...a: unknown[]) => mocks.spaceReset(...a),
    },
    mobileNotifications: {
      getPreferences: (...a: unknown[]) => mocks.get(...a),
      updatePreferences: (...a: unknown[]) => mocks.update(...a),
    },
  },
}));
vi.mock('../../../lib/sessionDefaults', () => ({
  useSessionDefaults: () => ({ notifyOnFinish: mocks.state.notifyOnFinish }),
  writeSessionDefaults: (...a: unknown[]) => mocks.writeDefaults(...a),
}));
vi.mock('../../../hooks/useApi', () => ({
  getMergeBlockedNotifyEnabled: () => mocks.state.blocked,
  setMergeBlockedNotifyEnabled: (...a: unknown[]) => mocks.setBlocked(...a),
}));
vi.mock('../../../stores/workspace', () => ({
  useWorkspaceStore: (selector: (s: unknown) => unknown) =>
    selector({ currentWorkspaceId: mocks.state.workspaceId, features: { spaces: mocks.state.spaces } }),
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
  vi.useRealTimers();
  mocks.spaceGet.mockReset().mockResolvedValue({ mutedSpaceIds: [] });
  mocks.spaceSave.mockReset().mockResolvedValue({ mutedSpaceIds: ['automations'] });
  mocks.spaceCategory.mockReset();
  mocks.spaceReset.mockReset();
  mockState.spaces = false;
  useSpacesStore.setState({ teams: null, mutedSpaceIds: [], phoneCategoriesBySpace: {}, notificationsLoaded: false, notificationsError: null, notificationsSaving: false });
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

describe('NotificationsSettings: this browser', () => {
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
    vi.useFakeTimers({ shouldAdvanceTime: false });
    fireEvent.click(checkbox('PR reviews'));
    fireEvent.click(checkbox('CI failures'));
    expect(screen.getByText('Saving…')).toBeInTheDocument();
    expect(mockUpdate).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(PHONE_SAVE_DEBOUNCE_MS);
    });
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockUpdate.mock.calls[0][0].categories).toMatchObject({ pr_review: false, ci_failure: false });
    vi.useRealTimers();
    expect(await screen.findByText('Saved.')).toBeInTheDocument();
  });

  it('saves a pending edit when the page closes', async () => {
    await renderLoaded();
    vi.useFakeTimers({ shouldAdvanceTime: false });
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
    vi.useFakeTimers({ shouldAdvanceTime: false });
    fireEvent.click(checkbox('^Quiet hours$'));
    await act(async () => {
      vi.advanceTimersByTime(PHONE_SAVE_DEBOUNCE_MS);
    });
    const saved = mockUpdate.mock.calls[0][0] as MobileNotificationPreferences;
    expect(saved.quietHours.enabled).toBe(true);
    expect(saved.timezone).toBe(local);
  });

  it('edits the quiet hours times', async () => {
    await renderLoaded(prefs({ enabled: true, quietHours: { enabled: true, start: '22:00', end: '08:00' } }));
    vi.useFakeTimers({ shouldAdvanceTime: false });
    fireEvent.change(screen.getByLabelText('Quiet hours start'), { target: { value: '21:30' } });
    await act(async () => {
      vi.advanceTimersByTime(PHONE_SAVE_DEBOUNCE_MS);
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
    await waitFor(() => expect(mocks.spaceGet).toHaveBeenCalledTimes(1));
    expect(checkbox('^Automations$')).toBeChecked();
    fireEvent.click(checkbox('^Automations$'));
    await waitFor(() => expect(checkbox('^Automations$')).not.toBeChecked());
    expect(mocks.spaceSave).toHaveBeenCalledWith('automations', true);
    expect(checkbox('^Work$')).toBeChecked();
  });

  it('turns notifications back on for a muted space', async () => {
    mocks.spaceGet.mockResolvedValue({ mutedSpaceIds: ['automations'] });
    mocks.spaceSave.mockResolvedValue({ mutedSpaceIds: [] });
    await renderLoaded();
    await waitFor(() => expect(checkbox('^Automations$')).not.toBeChecked());
    fireEvent.click(checkbox('^Automations$'));
    await waitFor(() => expect(checkbox('^Automations$')).toBeChecked());
    expect(mocks.spaceSave).toHaveBeenCalledWith('automations', false);
  });

  it.each([
    ['on', true], ['off', false], ['default', null],
  ] as const)('saves %s for one space phone alert type', async (choice, value) => {
    const initial = value === false;
    mocks.spaceGet.mockResolvedValue({
      mutedSpaceIds: [],
      phoneCategoriesBySpace: { automations: { ci_failure: initial, human_gate: true } },
    });
    mocks.spaceCategory.mockResolvedValue({
      mutedSpaceIds: [],
      phoneCategoriesBySpace: { automations: { ...(value === null ? {} : { ci_failure: value }), human_gate: true } },
    });
    await renderLoaded();
    fireEvent.click(screen.getByLabelText('Automations phone alert types'));
    const ci = screen.getByRole('combobox', { name: 'Automations CI failures' });
    expect(ci).toHaveValue(initial ? 'on' : 'off');
    fireEvent.change(ci, { target: { value: choice } });
    await waitFor(() => expect(ci).toHaveValue(choice));
    expect(mocks.spaceCategory).toHaveBeenCalledWith('automations', 'ci_failure', value);
    expect(screen.getByRole('combobox', { name: 'Automations Human input' })).toHaveValue('on');
    expect(mocks.spaceSave).not.toHaveBeenCalled();
  });

  it('shows phone choices without enabling edits for a muted space', async () => {
    mocks.spaceGet.mockResolvedValue({
      mutedSpaceIds: ['automations'], phoneCategoriesBySpace: { automations: { human_gate: true } },
    });
    await renderLoaded();
    fireEvent.click(screen.getByLabelText('Automations phone alert types'));
    const choice = screen.getByRole('combobox', { name: 'Automations Human input' });
    expect(choice).toHaveValue('on');
    expect(choice).toBeDisabled();
  });

  it('resets phone choices for an unlisted space and keeps its mute', async () => {
    useSpacesStore.setState({ teams: [] });
    mocks.spaceGet.mockResolvedValue({
      mutedSpaceIds: ['old'], phoneCategoriesBySpace: { old: { ci_failure: true } },
    });
    mocks.spaceReset.mockResolvedValue({ mutedSpaceIds: ['old'] });
    await renderLoaded();
    fireEvent.click(await screen.findByRole('button', { name: 'Reset phone alert types' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Reset phone alert types' })).toBeNull());
    expect(mocks.spaceReset).toHaveBeenCalledWith('old', {});
    expect(screen.getByRole('button', { name: 'Restore alerts' })).toBeVisible();
  });

  it('restores the previous preference when a save fails', async () => {
    mocks.spaceSave.mockRejectedValue(new Error('offline'));
    await renderLoaded();
    fireEvent.click(checkbox('^Automations$'));
    await waitFor(() => expect(mocks.spaceSave).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(checkbox('^Automations$')).toBeChecked());
    expect(checkbox('^Work$')).toBeChecked();
  });
  it('disables every space while a save is pending', async () => {
    let finish!: (value: { mutedSpaceIds: string[] }) => void;
    mocks.spaceSave.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    await renderLoaded();
    fireEvent.click(checkbox('^Automations$'));
    expect(checkbox('^Automations$')).toBeDisabled();
    expect(checkbox('^Work$')).toBeDisabled();
    fireEvent.click(checkbox('^Work$'));
    expect(mocks.spaceSave).toHaveBeenCalledTimes(1);
    await act(async () => { finish({ mutedSpaceIds: ['automations'] }); });
    expect(checkbox('^Automations$')).not.toBeDisabled();
    expect(checkbox('^Automations$')).not.toBeChecked();
    expect(checkbox('^Work$')).toBeChecked();
  });

  it('disables space edits until the preferences load and offers a retry', async () => {
    mocks.spaceGet.mockRejectedValueOnce(new Error('offline'));
    await renderLoaded();
    const retry = await screen.findByRole('button', { name: 'Retry' });
    expect(checkbox('^Automations$')).toBeDisabled();
    expect(mocks.spaceSave).not.toHaveBeenCalled();
    mocks.spaceGet.mockResolvedValue({ mutedSpaceIds: ['automations'] });
    fireEvent.click(retry);
    await waitFor(() => expect(checkbox('^Automations$')).not.toBeDisabled());
    expect(checkbox('^Automations$')).not.toBeChecked();
  });

  it.each([true, false])('restores missing muted spaces with live spaces: %s', async (hasLiveSpaces) => {
    if (!hasLiveSpaces) useSpacesStore.setState({ teams: [] });
    mocks.spaceGet.mockResolvedValue({ mutedSpaceIds: ['old-a', 'old-b'] });
    mocks.spaceSave.mockResolvedValueOnce({ mutedSpaceIds: ['old-b'] }).mockResolvedValueOnce({ mutedSpaceIds: [] });
    await renderLoaded();
    const restore = await screen.findByRole('button', { name: 'Restore alerts' });
    expect(screen.getByText('2 other muted spaces')).toBeInTheDocument();
    fireEvent.click(restore);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Restore alerts' })).toBeNull());
    expect(mocks.spaceSave).toHaveBeenNthCalledWith(1, 'old-a', false);
    expect(mocks.spaceSave).toHaveBeenNthCalledWith(2, 'old-b', false);
    if (hasLiveSpaces) expect(checkbox('^Automations$')).toBeChecked();
  });

  it('keeps the remaining mute after a partial restore fails', async () => {
    mocks.spaceGet.mockResolvedValue({ mutedSpaceIds: ['old-a', 'old-b'] });
    mocks.spaceSave.mockResolvedValueOnce({ mutedSpaceIds: ['old-b'] }).mockRejectedValueOnce(new Error('offline'));
    await renderLoaded();
    fireEvent.click(await screen.findByRole('button', { name: 'Restore alerts' }));
    await waitFor(() => expect(mocks.spaceSave).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Restore alerts' })).not.toBeDisabled());
    expect(screen.getByText('1 other muted space')).toBeInTheDocument();
    expect(useSpacesStore.getState().mutedSpaceIds).toEqual(['old-b']);
    mocks.spaceSave.mockResolvedValueOnce({ mutedSpaceIds: [] });
    fireEvent.click(screen.getByRole('button', { name: 'Restore alerts' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Restore alerts' })).toBeNull());
  });

  it('blocks other edits while missing spaces are being restored', async () => {
    mocks.spaceGet.mockResolvedValue({ mutedSpaceIds: ['old-a', 'old-b'] });
    let finish!: (value: { mutedSpaceIds: string[] }) => void;
    mocks.spaceSave.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }))
      .mockResolvedValueOnce({ mutedSpaceIds: [] });
    await renderLoaded();
    fireEvent.click(await screen.findByRole('button', { name: 'Restore alerts' }));
    expect(checkbox('^Automations$')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Restore alerts' })).toBeDisabled();
    await act(async () => finish({ mutedSpaceIds: ['old-b'] }));
    await waitFor(() => expect(checkbox('^Automations$')).not.toBeDisabled());
  });

});
