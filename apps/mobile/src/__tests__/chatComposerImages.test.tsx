import type { AgentEvent, WorkbenchEvent } from '@talyn/shared';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { ActionSheetIOS, Alert, TextInput } from 'react-native';

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
  uploadAttachment: jest.fn(async (_id: string, file: { name: string; mimeType: string }) => ({ name: file.name, mimeType: file.mimeType, path: `.context/attachments/${file.name}` })),
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
  it.each([
    ['library', 'launchImageLibraryAsync', 0],
    ['camera', 'launchCameraAsync', 1],
  ] as const)('attaches a photo from the %s, focuses the message, and removes the photo', async (_source, picker, menuIndex) => {
    const focus = jest.spyOn(TextInput.prototype, 'focus');
    mockPicker[picker].mockResolvedValue({ canceled: false, assets: [{ uri: 'file:///cat.jpg', fileName: 'cat.jpg', mimeType: 'image/jpeg', fileSize: 1000 }] });
    jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions').mockImplementation((_options, callback) => callback(menuIndex));
    await render(<WorkbenchDetailScreen kind="session" />);
    await fireEvent.press(await screen.findByRole('button', { name: 'Attach a photo or video' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Remove cat.jpg' })).toBeVisible());
    await waitFor(() => expect(focus).toHaveBeenCalledTimes(1));
    expect(mockActions.uploadAttachment).toHaveBeenCalledWith('session-one', expect.objectContaining({ name: 'cat.jpg', mimeType: 'image/jpeg' }), expect.any(Function));
    await fireEvent.press(screen.getByRole('button', { name: 'Remove cat.jpg' }));
    expect(screen.queryByRole('button', { name: 'Remove cat.jpg' })).toBeNull();
  });

  it('sends the text with the uploaded attachment, and clears both', async () => {
    pickLibrary();
    await render(<WorkbenchDetailScreen kind="session" />);
    await fireEvent.press(await screen.findByRole('button', { name: 'Attach a photo or video' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Remove cat.jpg' })).toBeVisible());
    await fireEvent.changeText(screen.getByLabelText('Message'), 'What is this?');
    await fireEvent.press(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(mockActions.send).toHaveBeenCalledWith('chat-one', { text: 'What is this?', attachments: [{ name: 'cat.jpg', mimeType: 'image/jpeg', path: '.context/attachments/cat.jpg' }] }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Remove cat.jpg' })).toBeNull());
  });

  it('sends an image without text', async () => {
    pickLibrary();
    await render(<WorkbenchDetailScreen kind="session" />);
    await fireEvent.press(await screen.findByRole('button', { name: 'Attach a photo or video' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Remove cat.jpg' })).toBeVisible());
    expect(screen.getByRole('button', { name: 'Send message' })).toBeEnabled();
    await fireEvent.press(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(mockActions.send).toHaveBeenCalledWith('chat-one', { text: '', attachments: [{ name: 'cat.jpg', mimeType: 'image/jpeg', path: '.context/attachments/cat.jpg' }] }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Remove cat.jpg' })).toBeNull());
  });

  describe('send while an attachment uploads', () => {
    const slowUpload = () => {
      let finish: (ok: boolean) => void = () => {};
      mockActions.uploadAttachment.mockImplementationOnce((_id, file) => new Promise((resolve, reject) => {
        finish = (ok) => ok ? resolve({ name: file.name, mimeType: file.mimeType, path: `.context/attachments/${file.name}` }) : reject(new Error('The upload failed.'));
      }));
      return (ok: boolean) => act(async () => finish(ok));
    };
    const holdSend = async () => {
      pickLibrary();
      await render(<WorkbenchDetailScreen kind="session" />);
      await fireEvent.press(await screen.findByRole('button', { name: 'Attach a photo or video' }));
      await waitFor(() => expect(screen.getByLabelText('cat.jpg, uploading')).toBeVisible());
      await fireEvent.changeText(screen.getByLabelText('Message'), 'What is this?');
      await fireEvent.press(screen.getByRole('button', { name: 'Send message' }));
      expect(screen.getByText('The message sends after the upload. Tap send again to cancel.')).toBeVisible();
    };

    it('holds the message and sends it with the attachment when the upload ends', async () => {
      const finish = slowUpload();
      await holdSend();
      expect(mockActions.send).not.toHaveBeenCalled();
      await finish(true);
      await waitFor(() => expect(mockActions.send).toHaveBeenCalledWith('chat-one', { text: 'What is this?', attachments: [{ name: 'cat.jpg', mimeType: 'image/jpeg', path: '.context/attachments/cat.jpg' }] }));
    });

    it('does not send when the upload fails', async () => {
      const finish = slowUpload();
      await holdSend();
      await finish(false);
      await waitFor(() => expect(screen.getByText('Remove the attachments that failed, or try them again.')).toBeVisible());
      expect(mockActions.send).not.toHaveBeenCalled();
    });

    it('cancels the held message on a second press', async () => {
      const finish = slowUpload();
      await holdSend();
      await fireEvent.press(screen.getByRole('button', { name: 'Cancel the waiting message' }));
      await finish(true);
      await waitFor(() => expect(screen.getByRole('button', { name: 'Send message' })).toBeEnabled());
      expect(mockActions.send).not.toHaveBeenCalled();
    });
  });

  it('explains a camera permission denial and points to settings', async () => {
    mockPicker.requestCameraPermissionsAsync.mockResolvedValue({ granted: false });
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions').mockImplementation((_options, callback) => callback(1));
    await render(<WorkbenchDetailScreen kind="session" />);
    await fireEvent.press(await screen.findByRole('button', { name: 'Attach a photo or video' }));
    await waitFor(() => expect(alert).toHaveBeenCalledWith('Allow access to the camera', expect.stringContaining('phone settings'), expect.any(Array)));
    expect(mockPicker.launchCameraAsync).not.toHaveBeenCalled();
  });

  it('shows an error for an image that cannot be attached', async () => {
    mockPicker.launchImageLibraryAsync.mockResolvedValue({ canceled: false, assets: [{ uri: 'file:///a.heic', fileName: 'a.heic', mimeType: 'image/heic' }] });
    jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions').mockImplementation((_options, callback) => callback(0));
    await render(<WorkbenchDetailScreen kind="session" />);
    await fireEvent.press(await screen.findByRole('button', { name: 'Attach a photo or video' }));
    await waitFor(() => expect(screen.getByText('a.heic: Only PNG, JPEG, WebP and GIF images and MP4, MOV and WebM videos can be attached.')).toBeVisible());
    expect(mockActions.uploadAttachment).not.toHaveBeenCalled();
  });
});

describe('composer videos', () => {
  const pickVideo = (asset: Record<string, unknown>) => {
    mockPicker.launchImageLibraryAsync.mockResolvedValue({ canceled: false, assets: [asset] });
    jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions').mockImplementation((_options, callback) => callback(0));
  };
  it('asks the library for photos and videos, and the camera for photos only', async () => {
    pickVideo({ uri: 'file:///clip.mov', fileName: 'clip.mov', mimeType: 'video/quicktime', fileSize: 1000 });
    await render(<WorkbenchDetailScreen kind="session" />);
    await fireEvent.press(await screen.findByRole('button', { name: 'Attach a photo or video' }));
    await waitFor(() => expect(mockPicker.launchImageLibraryAsync).toHaveBeenCalledWith(expect.objectContaining({ mediaTypes: ['images', 'videos'] })));
    jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions').mockImplementation((_options, callback) => callback(1));
    mockPicker.launchCameraAsync.mockResolvedValue({ canceled: true, assets: null });
    await fireEvent.press(screen.getByRole('button', { name: 'Attach a photo or video' }));
    await waitFor(() => expect(mockPicker.launchCameraAsync).toHaveBeenCalledWith(expect.objectContaining({ mediaTypes: ['images'] })));
  });
  it('attaches a video as a named chip, uploads it with its type, and sends it', async () => {
    pickVideo({ uri: 'file:///clip.mov', fileName: 'clip.mov', mimeType: 'video/quicktime', fileSize: 1000 });
    await render(<WorkbenchDetailScreen kind="session" />);
    await fireEvent.press(await screen.findByRole('button', { name: 'Attach a photo or video' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Remove clip.mov' })).toBeVisible());
    expect(screen.getByText('clip.mov')).toBeVisible();
    expect(mockActions.uploadAttachment).toHaveBeenCalledWith('session-one', expect.objectContaining({ name: 'clip.mov', mimeType: 'video/quicktime' }), expect.any(Function));
    await fireEvent.changeText(screen.getByPlaceholderText(/./), 'Why does it stutter?');
    await fireEvent.press(screen.getByRole('button', { name: /^Send/ }));
    await waitFor(() => expect(mockActions.send).toHaveBeenCalledWith('chat-one', { text: 'Why does it stutter?', attachments: [{ name: 'clip.mov', mimeType: 'video/quicktime', path: '.context/attachments/clip.mov' }] }));
  });
  it('names an unnamed video and allows send without text', async () => {
    pickVideo({ uri: 'file:///x', mimeType: 'video/mp4' });
    await render(<WorkbenchDetailScreen kind="session" />);
    await fireEvent.press(await screen.findByRole('button', { name: 'Attach a photo or video' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Remove video-1.mp4' })).toBeVisible());
    expect(screen.getByRole('button', { name: /^Send/ })).toBeEnabled();
  });
  it.each([
    [{ uri: 'file:///big.mp4', fileName: 'big.mp4', mimeType: 'video/mp4', fileSize: 50 * 1024 * 1024 + 1 }, 'big.mp4: The video is larger than 50 MB.'],
    [{ uri: 'file:///a.avi', fileName: 'a.avi', mimeType: 'video/x-msvideo' }, 'a.avi: Only PNG, JPEG, WebP and GIF images and MP4, MOV and WebM videos can be attached.'],
  ])('shows an error for %j', async (asset, message) => {
    pickVideo(asset);
    await render(<WorkbenchDetailScreen kind="session" />);
    await fireEvent.press(await screen.findByRole('button', { name: 'Attach a photo or video' }));
    await waitFor(() => expect(screen.getByText(message)).toBeVisible());
    expect(mockActions.uploadAttachment).not.toHaveBeenCalled();
  });
});

describe('message images', () => {
  it('shows a video attachment as a tile with its name', async () => {
    const events: WorkbenchEvent[] = [{ chatId: 'chat-one', seq: 1, turn: 1, createdAt: '2026-11-08T11:00:00Z', event: { seq: 1, type: 'user', talyn_user_message: true,
      message: { content: [{ type: 'text', text: 'See this' }] }, talyn: { attachments: [{ name: 'clip.mp4', mimeType: 'video/mp4', path: '.context/attachments/clip.mp4' }] } } as AgentEvent }];
    mockActive.api.workbenches.events.mockResolvedValue({ events, cursor: 1, oldestSeq: 1, hasOlder: false });
    await render(<WorkbenchDetailScreen kind="session" />);
    expect(await screen.findByLabelText('Video: clip.mp4')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Open clip.mp4' })).toBeNull();
  });

  it('shows a text file next to an image, by name', async () => {
    const events: WorkbenchEvent[] = [{ chatId: 'chat-one', seq: 1, turn: 1, createdAt: '2026-11-08T11:00:00Z', event: { seq: 1, type: 'user', talyn_user_message: true,
      message: { content: [{ type: 'text', text: 'See these' }] }, talyn: { attachments: [
        { name: 'cat.jpg', mimeType: 'image/jpeg', path: '.context/attachments/cat.jpg' },
        { name: 'notes.md', mimeType: 'text/plain', path: '.context/attachments/notes.md' },
      ] } } as AgentEvent }];
    mockActive.api.workbenches.events.mockResolvedValue({ events, cursor: 1, oldestSeq: 1, hasOlder: false });
    await render(<WorkbenchDetailScreen kind="session" />);
    expect(await screen.findByLabelText('File: notes.md')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Open cat.jpg' })).toBeVisible();
  });

  it('shows a text file alone, by name', async () => {
    const events: WorkbenchEvent[] = [{ chatId: 'chat-one', seq: 1, turn: 1, createdAt: '2026-11-08T11:00:00Z', event: { seq: 1, type: 'user', talyn_user_message: true,
      message: { content: [{ type: 'text', text: 'Read this' }] }, talyn: { attachments: [{ name: 'build.log', mimeType: 'text/plain', path: '.context/attachments/build.log' }] } } as AgentEvent }];
    mockActive.api.workbenches.events.mockResolvedValue({ events, cursor: 1, oldestSeq: 1, hasOlder: false });
    await render(<WorkbenchDetailScreen kind="session" />);
    expect(await screen.findByLabelText('File: build.log')).toBeVisible();
    expect(screen.queryByText('1 attachment')).toBeNull();
  });

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
