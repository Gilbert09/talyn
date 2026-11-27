import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import { SpaceNotificationSettings } from '../features/spaces/SpaceNotificationSettings';

const mockLife = { activity: 'active', reachability: 'online' };
const mockLifecycle = { subscribe: () => () => {}, getSnapshot: () => mockLife };
const mockTeams = jest.fn();
const mockRead = jest.fn();
const mockSave = jest.fn();
const mockListeners = new Map<string, () => void>();

jest.mock('@talyn/client/native', () => ({
  teams: { list: () => mockTeams() },
  spaces: { notificationPreferences: () => mockRead(), setNotificationsMuted: (...args: unknown[]) => mockSave(...args) },
  wsClient: { on: (name: string, listener: () => void) => {
    mockListeners.set(name, listener);
    return () => mockListeners.delete(name);
  } },
}));
jest.mock('../auth/AuthProvider', () => ({
  useAuth: () => ({ user: { id: 'user' } }),
  useMobileRuntime: () => ({ lifecycle: mockLifecycle }),
}));
jest.mock('../lib/features', () => ({ useFeatures: () => ({ spaces: true }) }));

beforeEach(() => {
  mockTeams.mockResolvedValue([{ id: 'team', name: 'Work', spaces: [
    { id: 'automation', name: 'Automations' }, { id: 'manual', name: 'Manual' },
  ] }]);
  mockRead.mockResolvedValue({ mutedSpaceIds: [] });
  mockSave.mockResolvedValue({ mutedSpaceIds: ['automation'] });
});

it('loads saved preferences and saves a personal mute', async () => {
  await render(<SpaceNotificationSettings offline={false} />);
  const toggle = await screen.findByRole('switch', { name: 'Automations' });
  expect(toggle.props.value).toBe(true);
  mockRead.mockResolvedValue({ mutedSpaceIds: ['automation'] });
  await fireEvent(toggle, 'valueChange', false);
  expect(mockSave).toHaveBeenCalledWith('automation', true);
  await waitFor(() => expect(screen.getByRole('switch', { name: 'Automations' }).props.value).toBe(false));
});

it('blocks rapid edits while saving and restores the value on failure', async () => {
  let reject!: (reason: Error) => void;
  mockSave.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
  await render(<SpaceNotificationSettings offline={false} />);
  await fireEvent(await screen.findByRole('switch', { name: 'Automations' }), 'valueChange', false);
  expect(screen.getByRole('switch', { name: 'Manual' })).toBeDisabled();
  await fireEvent(screen.getByRole('switch', { name: 'Manual' }), 'valueChange', false);
  expect(mockSave).toHaveBeenCalledTimes(1);
  await act(async () => reject(new Error('Unavailable')));
  expect(screen.getByRole('switch', { name: 'Automations' }).props.value).toBe(true);
  expect(screen.getByRole('alert', { name: /could not be saved/ })).toBeVisible();
});

it('disables edits offline', async () => {
  await render(<SpaceNotificationSettings offline />);
  expect(await screen.findByRole('switch', { name: 'Automations' })).toBeDisabled();
  expect(mockSave).not.toHaveBeenCalled();
});

it.each(['preferences', 'teams'])('shows a retry after a failed %s load', async (source) => {
  (source === 'preferences' ? mockRead : mockTeams).mockRejectedValueOnce(new Error('Unavailable'));
  await render(<SpaceNotificationSettings offline={false} />);
  expect(await screen.findByRole('alert', { name: /could not load/ })).toBeVisible();
  expect(screen.queryByRole('switch', { name: 'Automations' })).toBeNull();
  await fireEvent.press(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByRole('switch', { name: 'Automations' })).toBeEnabled();
});

it('refreshes when another device changes a space preference', async () => {
  await render(<SpaceNotificationSettings offline={false} />);
  await screen.findByRole('switch', { name: 'Automations' });
  mockRead.mockResolvedValue({ mutedSpaceIds: ['automation'] });
  await act(async () => mockListeners.get('space:notifications')?.());
  expect(screen.getByRole('switch', { name: 'Automations' }).props.value).toBe(false);
});

it.each(['preferences', 'teams'])('keeps controls after a failed %s refresh', async (source) => {
  jest.useFakeTimers();
  try {
    mockRead.mockResolvedValue({ mutedSpaceIds: ['automation'] });
    await render(<SpaceNotificationSettings offline={false} />);
    await screen.findByRole('switch', { name: 'Automations' });
    (source === 'preferences' ? mockRead : mockTeams).mockRejectedValueOnce(new Error('Unavailable'));
    await act(async () => { jest.advanceTimersByTime(120_000); });
    expect(screen.getByRole('switch', { name: 'Automations' })).toBeEnabled();
    expect(screen.getByRole('switch', { name: 'Automations' }).props.value).toBe(false);
    expect(screen.getByRole('alert', { name: /could not load/ })).toBeVisible();
    await fireEvent.press(screen.getByRole('button', { name: 'Retry' }));
    expect(screen.queryByRole('alert', { name: /could not load/ })).toBeNull();
    expect(screen.getByRole('switch', { name: 'Automations' }).props.value).toBe(false);
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
  expect(screen.getByRole('switch', { name: 'Automations' }).props.value).toBe(false);
  expect(screen.getByRole('alert', { name: /could not be saved/ })).toBeVisible();
});

it('blocks other edits while restoring an unlisted mute', async () => {
  let resolve!: (value: { mutedSpaceIds: string[] }) => void;
  mockRead.mockResolvedValue({ mutedSpaceIds: ['old-space'] });
  mockSave.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
  await render(<SpaceNotificationSettings offline={false} />);
  await fireEvent.press(await screen.findByRole('button', { name: 'Restore alerts' }));
  expect(screen.getByRole('switch', { name: 'Automations' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Restore alerts' })).toBeDisabled();
  await fireEvent.press(screen.getByRole('button', { name: 'Restore alerts' }));
  expect(mockSave).toHaveBeenCalledTimes(1);
  mockRead.mockResolvedValue({ mutedSpaceIds: [] });
  await act(async () => resolve({ mutedSpaceIds: [] }));
  expect(screen.queryByRole('button', { name: 'Restore alerts' })).toBeNull();
});
