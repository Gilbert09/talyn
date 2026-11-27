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
