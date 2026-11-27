import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import { SpaceNotificationSettings } from '../features/spaces/SpaceNotificationSettings';

const mockLife = { activity: 'active', reachability: 'online' };
const mockLifecycle = { subscribe: () => () => {}, getSnapshot: () => mockLife };
const mockTeams = jest.fn();
const mockRead = jest.fn();
const mockSave = jest.fn();
const mockSavePhone = jest.fn();
const mockListeners = new Map<string, () => void>();

jest.mock('@talyn/client/native', () => ({
  teams: { list: () => mockTeams() },
  spaces: {
    notificationPreferences: () => mockRead(),
    setNotificationsMuted: (...args: unknown[]) => mockSave(...args),
    setPhoneNotificationCategories: (...args: unknown[]) => mockSavePhone(...args),
    setPhoneNotificationCategory: (...args: unknown[]) => mockSavePhone(...args),
  },
  wsClient: { on: (name: string, listener: () => void) => {
    mockListeners.set(name, listener);
    return () => mockListeners.delete(name);
  } },
}));
jest.mock('../auth/AuthProvider', () => ({
  useAuth: () => ({ user: { id: 'user' } }),
  useMobileRuntime: () => ({ lifecycle: mockLifecycle }),
}));
jest.mock('expo-router', () => ({ Link: ({ children }: { children: unknown }) => children, useFocusEffect: jest.fn() }));
jest.mock('../lib/features', () => ({ useFeatures: () => ({ spaces: true }) }));

beforeEach(() => {
  mockTeams.mockResolvedValue([{ id: 'team', name: 'Work', spaces: [
    { id: 'automation', name: 'Automations' }, { id: 'manual', name: 'Manual' },
  ] }]);
  mockRead.mockResolvedValue({ mutedSpaceIds: [] });
  mockSave.mockResolvedValue({ mutedSpaceIds: ['automation'] });
});

it('loads saved preferences and saves a personal mute', async () => {
  await render(<SpaceNotificationSettings offline={false} spaceId="automation" />);
  const toggle = await screen.findByRole('switch', { name: 'Mute space' });
  expect(toggle.props.value).toBe(false);
  mockRead.mockResolvedValue({ mutedSpaceIds: ['automation'] });
  await fireEvent(toggle, 'valueChange', true);
  expect(mockSave).toHaveBeenCalledWith('automation', true);
  await waitFor(() => expect(screen.getByRole('switch', { name: 'Mute space' }).props.value).toBe(true));
});

it('blocks rapid edits while saving and restores the value on failure', async () => {
  let reject!: (reason: Error) => void;
  mockSave.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
  await render(<SpaceNotificationSettings offline={false} spaceId="automation" />);
  await fireEvent(await screen.findByRole('switch', { name: 'Mute space' }), 'valueChange', true);
  expect(screen.getByRole('switch', { name: 'Mute space' })).toBeDisabled();
  await fireEvent(screen.getByRole('switch', { name: 'Mute space' }), 'valueChange', false);
  expect(mockSave).toHaveBeenCalledTimes(1);
  await act(async () => reject(new Error('Unavailable')));
  expect(screen.getByRole('switch', { name: 'Mute space' }).props.value).toBe(false);
  expect(screen.getByRole('alert', { name: /could not be saved/ })).toBeVisible();
});

it('disables edits offline', async () => {
  await render(<SpaceNotificationSettings offline spaceId="automation" />);
  expect(await screen.findByRole('switch', { name: 'Mute space' })).toBeDisabled();
  expect(mockSave).not.toHaveBeenCalled();
});

it.each([
  ['On', true], ['Off', false], ['Use workspace default', null],
] as const)('sets a phone alert type to %s and keeps the other choices', async (label, value) => {
  const prior = { session_update: false, ci_failure: value === false };
  const categories = value === null ? { session_update: false } : { ...prior, ci_failure: value };
  mockRead.mockResolvedValue({ mutedSpaceIds: [], phoneCategoriesBySpace: { automation: prior } });
  mockSavePhone.mockResolvedValue({ mutedSpaceIds: [], phoneCategoriesBySpace: { automation: categories } });

  await render(<SpaceNotificationSettings offline={false} spaceId="automation" />);
  await fireEvent.press(await screen.findByRole('button', { name: 'CI failures' }));
  await fireEvent.press(screen.getByRole('button', { name: label }));

  expect(mockSavePhone).toHaveBeenCalledWith('automation', 'ci_failure', value);
  expect(mockSave).not.toHaveBeenCalled();
});

it('sends only the selected category after another device changes a preference with the picker open', async () => {
  mockRead.mockResolvedValue({ mutedSpaceIds: [], phoneCategoriesBySpace: { automation: { session_update: false } } });
  await render(<SpaceNotificationSettings offline={false} spaceId="automation" />);
  await fireEvent.press(await screen.findByRole('button', { name: 'CI failures' }));
  mockRead.mockResolvedValue({ mutedSpaceIds: [], phoneCategoriesBySpace: { automation: { session_update: true } } });
  await act(async () => mockListeners.get('space:notifications')?.());
  const saved = { mutedSpaceIds: [], phoneCategoriesBySpace: { automation: { session_update: true, ci_failure: false } } };
  mockSavePhone.mockResolvedValue(saved);
  mockRead.mockResolvedValue(saved);
  await fireEvent.press(screen.getByRole('button', { name: 'Off' }));

  expect(mockSavePhone).toHaveBeenCalledWith('automation', 'ci_failure', false);
});

it('shows a space mute and disables edits to phone alert types', async () => {
  mockRead.mockResolvedValue({
    mutedSpaceIds: ['automation'], phoneCategoriesBySpace: { automation: { ci_failure: true } },
  });
  await render(<SpaceNotificationSettings offline={false} spaceId="automation" />);
  expect(await screen.findByRole('button', { name: 'CI failures' })).toBeDisabled();
  expect(screen.getByRole('switch', { name: 'Mute space' })).toBeEnabled();
});

it.each(['preferences', 'teams'])('shows a retry after a failed %s load', async (source) => {
  (source === 'preferences' ? mockRead : mockTeams).mockRejectedValueOnce(new Error('Unavailable'));
  await render(<SpaceNotificationSettings offline={false} spaceId="automation" />);
  expect(await screen.findByRole('alert', { name: /could not load/ })).toBeVisible();
  expect(screen.queryByRole('switch', { name: 'Mute space' })).toBeNull();
  await fireEvent.press(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByRole('switch', { name: 'Mute space' })).toBeEnabled();
});

it('refreshes when another device changes a space preference', async () => {
  await render(<SpaceNotificationSettings offline={false} spaceId="automation" />);
  await screen.findByRole('switch', { name: 'Mute space' });
  mockRead.mockResolvedValue({ mutedSpaceIds: ['automation'] });
  await act(async () => mockListeners.get('space:notifications')?.());
  expect(screen.getByRole('switch', { name: 'Mute space' }).props.value).toBe(true);
});

it.each(['preferences', 'teams'])('keeps controls after a failed %s refresh', async (source) => {
  jest.useFakeTimers();
  try {
    mockRead.mockResolvedValue({ mutedSpaceIds: ['automation'] });
    await render(<SpaceNotificationSettings offline={false} spaceId="automation" />);
    await screen.findByRole('switch', { name: 'Mute space' });
    (source === 'preferences' ? mockRead : mockTeams).mockRejectedValueOnce(new Error('Unavailable'));
    await act(async () => { jest.advanceTimersByTime(120_000); });
    expect(screen.getByRole('switch', { name: 'Mute space' })).toBeEnabled();
    expect(screen.getByRole('switch', { name: 'Mute space' }).props.value).toBe(true);
    expect(screen.getByRole('alert', { name: /could not load/ })).toBeVisible();
    await fireEvent.press(screen.getByRole('button', { name: 'Retry' }));
    expect(screen.queryByRole('alert', { name: /could not load/ })).toBeNull();
    expect(screen.getByRole('switch', { name: 'Mute space' }).props.value).toBe(true);
  } finally {
    jest.useRealTimers();
  }
});

it.each([false, true])('restores an unlisted mute when the team list is empty: %s', async (emptyTeams) => {
  if (emptyTeams) mockTeams.mockResolvedValue([]);
  mockRead.mockResolvedValue({ mutedSpaceIds: ['old-space'] });
  mockSave.mockResolvedValue({ mutedSpaceIds: [] });
  await render(<SpaceNotificationSettings offline={false} />);
  expect(await screen.findByText('1 other muted space')).toBeVisible();
  mockRead.mockResolvedValue({ mutedSpaceIds: [] });
  await fireEvent.press(screen.getByRole('button', { name: 'Restore alerts' }));
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Restore alerts' })).toBeNull());
  expect(mockSave).toHaveBeenCalledWith('old-space', false);
});

it('keeps remaining mutes after a partial restore failure', async () => {
  mockRead.mockResolvedValue({ mutedSpaceIds: ['automation', 'old-a', 'old-b'] });
  mockSave.mockResolvedValueOnce({ mutedSpaceIds: ['automation', 'old-b'] })
    .mockRejectedValueOnce(new Error('Unavailable'));
  await render(<SpaceNotificationSettings offline={false} />);
  await screen.findByRole('button', { name: 'Restore alerts' });
  mockRead.mockResolvedValue({ mutedSpaceIds: ['automation', 'old-b'] });
  await fireEvent.press(screen.getByRole('button', { name: 'Restore alerts' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Restore alerts' })).toBeEnabled());
  expect(mockSave.mock.calls).toEqual([['old-a', false], ['old-b', false]]);
  expect(screen.getByText('1 other muted space')).toBeVisible();
  expect(screen.getByText('Muted on all devices')).toBeVisible();
  expect(screen.getByRole('alert', { name: /could not be saved/ })).toBeVisible();
});

it('blocks other edits while restoring an unlisted mute', async () => {
  let resolve!: (value: { mutedSpaceIds: string[] }) => void;
  mockRead.mockResolvedValue({ mutedSpaceIds: ['old-space'] });
  mockSave.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  await render(<SpaceNotificationSettings offline={false} />);
  await fireEvent.press(await screen.findByRole('button', { name: 'Restore alerts' }));
  expect(screen.getByRole('button', { name: 'Restore alerts' })).toBeDisabled();
  await fireEvent.press(screen.getByRole('button', { name: 'Restore alerts' }));
  expect(mockSave).toHaveBeenCalledTimes(1);
  mockRead.mockResolvedValue({ mutedSpaceIds: [] });
  await act(async () => resolve({ mutedSpaceIds: [] }));
  expect(screen.queryByRole('button', { name: 'Restore alerts' })).toBeNull();
});
