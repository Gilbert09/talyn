import type { AgentEvent, WorkbenchEvent } from '@talyn/shared';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { ActionSheetIOS, Alert } from 'react-native';

import { resetImageDrafts } from '../features/chat/attachmentDrafts';
import { WorkbenchDetailScreen } from '../features/sessions/WorkbenchDetailScreen';
import { fixture } from './workflowFixtures';

jest.setTimeout(15000);

let mockActive = fixture();
const mockAuth = { getAccessToken: async () => 'token' };
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ id: 'session-one' }),
  Link: ({ children }: { children: React.ReactNode }) => children,
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: () => true }),
  Stack: { Screen: () => null },
}));
jest.mock('../auth/AuthProvider', () => ({
  useMobileRuntime: () => ({ workflow: mockActive.store, auth: mockAuth }), useNetwork: () => 'online',
  useWorkspace: () => ({ selected: 'one', choices: [{ id: 'one', name: 'Test workspace' }] }),
}));
jest.mock('@talyn/client/native', () => ({ ...jest.requireActual('@talyn/client/native'), getApiBaseUrl: () => 'https://api.test' }));
jest.mock('expo-image-picker', () => ({
  launchImageLibraryAsync: jest.fn(), launchCameraAsync: jest.fn(), requestCameraPermissionsAsync: jest.fn(),
}));
const mockPicker = jest.requireMock('expo-image-picker') as Record<'launchImageLibraryAsync' | 'launchCameraAsync' | 'requestCameraPermissionsAsync', jest.Mock>;
const mockActions = {
  stop: jest.fn(), approvePlan: jest.fn(), setPlanMode: jest.fn(),
  send: jest.fn(async () => ({ queued: false })),
  uploadImage: jest.fn(async (_id: string, file: { name: string; mimeType: string }) => ({ name: file.name, mimeType: file.mimeType, path: `.context/attachments/${file.name}` })),
};
jest.mock('../features/chat/actions', () => ({ get chatActions() { return mockActions; } }));

beforeEach(() => {
  mockActive.store.dispose(); mockActive = fixture(); resetImageDrafts(); jest.clearAllMocks();
  mockPicker.requestCameraPermissionsAsync.mockResolvedValue({ granted: true });
  mockActive.api.workbenches.events.mockResolvedValue({ events: [], cursor: 0, oldestSeq: 1, hasOlder: false });
});
afterEach(() => { mockActive.store.dispose(); jest.restoreAllMocks(); });

const pickLibrary = () => {
  mockPicker.launchImageLibraryAsync.mockResolvedValue({ canceled: false, assets: [{ uri: 'file:///cat.jpg', fileName: 'cat.jpg', mimeType: 'image/jpeg', fileSize: 1000 }] });
  jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions').mockImplementation((_options, callback) => callback(0));
};

describe('composer images', () => {
  it('attaches a photo, shows it, and removes it', async () => {
    pickLibrary();
    await render(<WorkbenchDetailScreen kind="session" />);
    await fireEvent.press(await screen.findByRole('button', { name: 'Attach an image' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Remove cat.jpg' })).toBeVisible());
    expect(mockActions.uploadImage).toHaveBeenCalledWith('session-one', expect.objectContaining({ name: 'cat.jpg', mimeType: 'image/jpeg' }), expect.any(Function));
    await fireEvent.press(screen.getByRole('button', { name: 'Remove cat.jpg' }));
    expect(screen.queryByRole('button', { name: 'Remove cat.jpg' })).toBeNull();
  });

  it('sends the text with the uploaded attachment, and clears both', async () => {
    pickLibrary();
    await render(<WorkbenchDetailScreen kind="session" />);
    await fireEvent.press(await screen.findByRole('button', { name: 'Attach an image' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Remove cat.jpg' })).toBeVisible());
    await fireEvent.changeText(screen.getByLabelText('Message'), 'What is this?');
    await fireEvent.press(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(mockActions.send).toHaveBeenCalledWith('chat-one', { text: 'What is this?', attachments: [{ name: 'cat.jpg', mimeType: 'image/jpeg', path: '.context/attachments/cat.jpg' }] }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Remove cat.jpg' })).toBeNull());
  });

  it('does not send images without text', async () => {
    pickLibrary();
    await render(<WorkbenchDetailScreen kind="session" />);
    await fireEvent.press(await screen.findByRole('button', { name: 'Attach an image' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Remove cat.jpg' })).toBeVisible());
    expect(screen.getByText('Add a message to send with the images.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Send message' })).toBeDisabled();
  });

  it('explains a camera permission denial and points to settings', async () => {
    mockPicker.requestCameraPermissionsAsync.mockResolvedValue({ granted: false });
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions').mockImplementation((_options, callback) => callback(1));
    await render(<WorkbenchDetailScreen kind="session" />);
    await fireEvent.press(await screen.findByRole('button', { name: 'Attach an image' }));
    await waitFor(() => expect(alert).toHaveBeenCalledWith('Allow access to the camera', expect.stringContaining('phone settings'), expect.any(Array)));
    expect(mockPicker.launchCameraAsync).not.toHaveBeenCalled();
  });

  it('shows an error for an image that cannot be attached', async () => {
    mockPicker.launchImageLibraryAsync.mockResolvedValue({ canceled: false, assets: [{ uri: 'file:///a.heic', fileName: 'a.heic', mimeType: 'image/heic' }] });
    jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions').mockImplementation((_options, callback) => callback(0));
    await render(<WorkbenchDetailScreen kind="session" />);
    await fireEvent.press(await screen.findByRole('button', { name: 'Attach an image' }));
    await waitFor(() => expect(screen.getByText('a.heic: Only PNG, JPEG, WebP and GIF images can be attached.')).toBeVisible());
    expect(mockActions.uploadImage).not.toHaveBeenCalled();
  });
});

describe('message images', () => {
  it('shows an attached image in the user bubble and opens it full screen', async () => {
    const events: WorkbenchEvent[] = [{ chatId: 'chat-one', seq: 1, turn: 1, createdAt: '2026-11-08T11:00:00Z', event: { seq: 1, type: 'user', talyn_user_message: true,
      message: { content: [{ type: 'text', text: 'See this' }] }, talyn: { attachments: [{ name: 'cat.jpg', mimeType: 'image/jpeg', path: '.context/attachments/cat.jpg' }] } } as AgentEvent }];
    mockActive.api.workbenches.events.mockResolvedValue({ events, cursor: 1, oldestSeq: 1, hasOlder: false });
    await render(<WorkbenchDetailScreen kind="session" />);
    const open = await screen.findByRole('button', { name: 'Open cat.jpg' });
    await fireEvent.press(open);
    await act(async () => {});
    expect(await screen.findByRole('button', { name: 'Close image' })).toBeVisible();
    await fireEvent.press(screen.getByRole('button', { name: 'Close image' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Close image' })).toBeNull());
  });
});
