import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { ActionSheetIOS, Alert } from 'react-native';

import { readImageDrafts, resetImageDrafts } from '../features/chat/attachmentDrafts';
import type { ImageDraft } from '../features/chat/attachments';
import { inlineImage, inlineSize, jpegName, MAX_INLINE_BASE64 } from '../features/chat/inlineImage';
import { NewWorkScreen } from '../features/create/NewWorkScreen';
import { inlineBlock } from '../features/create/useInlineImages';
import { fixture, session } from './workflowFixtures';

jest.setTimeout(15000);

let mockActive = fixture();
const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: () => true };
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({}),
  usePathname: () => '/new',
  Link: ({ children }: { children: React.ReactNode }) => children,
  useRouter: () => mockRouter,
  Stack: { Screen: () => null },
}));
const mockContextSnapshot = { status: 'ready' as const, spaceId: null };
const mockContext = { getSnapshot: () => mockContextSnapshot, subscribe: () => () => {}, select: jest.fn(async () => {}) };
const mockWorkspace = { status: 'ready', selected: 'one', choices: [{ id: 'one', name: 'Test workspace' }] };
jest.mock('../auth/AuthProvider', () => ({
  useMobileRuntime: () => ({ workflow: mockActive.store, lifecycle: mockActive.lifecycle, workspace: { getSnapshot: () => mockWorkspace, select: jest.fn() },
    context: mockContext }),
  useNetwork: () => 'online', useAuth: () => ({ user: { id: 'user-one' } }),
  useWorkspace: () => mockWorkspace,
}));
jest.mock('expo-image-picker', () => ({
  launchImageLibraryAsync: jest.fn(), launchCameraAsync: jest.fn(), requestCameraPermissionsAsync: jest.fn(),
}));
const mockPicker = jest.requireMock('expo-image-picker') as Record<'launchImageLibraryAsync', jest.Mock>;
const mockImage = { saveAsync: jest.fn(), release: jest.fn() };
const mockContextRef = { renderAsync: jest.fn(async () => mockImage), release: jest.fn() };
jest.mock('expo-image-manipulator', () => ({
  ImageManipulator: { manipulate: jest.fn(() => mockContextRef) },
  SaveFormat: { JPEG: 'jpeg', PNG: 'png', WEBP: 'webp' },
}));
const mockManipulator = jest.requireMock('expo-image-manipulator') as { ImageManipulator: { manipulate: jest.Mock } };
const mockActions = { send: jest.fn(async (_chatId: string, _input: unknown) => ({ queued: true })) };
jest.mock('../features/chat/actions', () => ({ get chatActions() { return mockActions; } }));

beforeEach(() => {
  mockActive.store.dispose(); mockActive = fixture(); resetImageDrafts(); jest.clearAllMocks();
  mockImage.saveAsync.mockResolvedValue({ uri: 'file:///small.jpg', width: 1600, height: 1200, base64: 'AAAA' });
  mockContextRef.renderAsync.mockResolvedValue(mockImage);
  mockActions.send.mockResolvedValue({ queued: true });
});
afterEach(() => { mockActive.store.dispose(); jest.restoreAllMocks(); });

const draft = (patch: Partial<ImageDraft> = {}): ImageDraft => ({ id: 'a', uri: 'file:///a.jpg', name: 'a.jpg', mimeType: 'image/jpeg', status: 'ready',
  attachment: { name: 'a.jpg', mimeType: 'image/jpeg', dataBase64: 'AAAA' }, ...patch });

describe('inline images', () => {
  it.each([
    ['cat.png', 'cat.jpg'],
    ['cat.photo.heic', 'cat.photo.jpg'],
    ['cat', 'cat.jpg'],
    ['.png', 'photo.jpg'],
  ])('names %s as %s', (name, expected) => expect(jpegName(name)).toBe(expected));

  it.each<[string, ImageDraft[], string | null]>([
    ['no images', [], null],
    ['ready images', [draft(), draft({ id: 'b' })], null],
    ['an image still preparing', [draft(), draft({ id: 'b', status: 'uploading', attachment: undefined })], 'Preparing the images.'],
    ['a failed image', [draft({ status: 'error', attachment: undefined })], 'Remove the images that failed, or try them again.'],
    ['images over the JSON limit', [draft({ attachment: { name: 'a.jpg', mimeType: 'image/jpeg', dataBase64: 'A'.repeat(MAX_INLINE_BASE64 + 1) } })],
      'The images are too large to send together. Remove one.'],
    ['images at the JSON limit', [draft({ attachment: { name: 'a.jpg', mimeType: 'image/jpeg', dataBase64: 'A'.repeat(MAX_INLINE_BASE64) } })], null],
  ])('blocks a start for %s', (_name, drafts, expected) => expect(inlineBlock(drafts)).toBe(expected));

  it('counts only ready images in the inline size', () => {
    expect(inlineSize([draft(), draft({ id: 'b', status: 'uploading' }), draft({ id: 'c', status: 'error' })])).toBe(4);
  });

  it('makes a smaller JPEG with Base64 and releases the native objects', async () => {
    await expect(inlineImage('file:///cat.png', 'cat.png')).resolves.toEqual({ name: 'cat.jpg', mimeType: 'image/jpeg', dataBase64: 'AAAA' });
    expect(mockManipulator.ImageManipulator.manipulate).toHaveBeenCalledWith('file:///cat.png', { maxWidth: 1600, maxHeight: 1600 });
    expect(mockImage.saveAsync).toHaveBeenCalledWith({ format: 'jpeg', compress: 0.8, base64: true });
    expect(mockImage.release).toHaveBeenCalled();
    expect(mockContextRef.release).toHaveBeenCalled();
  });

  it.each([
    ['no Base64 in the result', () => mockImage.saveAsync.mockResolvedValue({ uri: 'file:///small.jpg', width: 1, height: 1 })],
    ['a failed save', () => mockImage.saveAsync.mockRejectedValue(new Error('disk full'))],
    ['a failed render', () => mockContextRef.renderAsync.mockRejectedValue(new Error('bad image'))],
  ])('fails and still releases on %s', async (_name, arrange) => {
    arrange();
    await expect(inlineImage('file:///cat.png', 'cat.png')).rejects.toThrow();
    expect(mockContextRef.release).toHaveBeenCalled();
  });
});

describe('new work with images', () => {
  const startButton = () => screen.getByRole('button', { name: 'Start session' });
  const pickLibrary = (assets = [{ uri: 'file:///cat.png', fileName: 'cat.png', mimeType: 'image/png', fileSize: 20_000_000 }]) => {
    mockPicker.launchImageLibraryAsync.mockResolvedValue({ canceled: false, assets });
    jest.spyOn(ActionSheetIOS, 'showActionSheetWithOptions').mockImplementation((_options, callback) => callback(0));
  };
  const attach = async () => {
    await fireEvent.press(await screen.findByRole('button', { name: 'Attach an image' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Remove cat.jpg' })).toBeVisible());
  };

  it('starts a session, then sends the prompt with the image inline', async () => {
    pickLibrary();
    await render(<NewWorkScreen />);
    await fireEvent.changeText(await screen.findByLabelText('Task'), 'Fix this screen');
    await attach();
    await waitFor(() => expect(startButton()).toBeEnabled());
    await fireEvent.press(startButton());
    await waitFor(() => expect(mockActive.api.workbenches.create).toHaveBeenCalledWith(expect.objectContaining({
      repositoryId: 'repo-one', prompt: undefined, namingText: 'Fix this screen' })));
    await waitFor(() => expect(mockActions.send).toHaveBeenCalledWith('chat-one', {
      text: 'Fix this screen', attachments: [{ name: 'cat.jpg', mimeType: 'image/jpeg', dataBase64: 'AAAA' }] }));
    expect(mockRouter.replace).toHaveBeenCalledWith({ pathname: '/sessions/[id]', params: { id: 'session-new' } });
    expect(readImageDrafts('new:prompt')).toEqual([]);
    expect(mockActive.store.local('new:prompt').draft).toBe('');
  });

  it('keeps a large photo, because it is made smaller first', async () => {
    pickLibrary();
    await render(<NewWorkScreen />);
    await attach();
    expect(screen.queryByText(/larger than 10 MB/)).toBeNull();
  });

  it('waits for an image that is still being prepared', async () => {
    let finish: (value: unknown) => void = () => {};
    mockImage.saveAsync.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    pickLibrary();
    await render(<NewWorkScreen />);
    await fireEvent.changeText(await screen.findByLabelText('Task'), 'Fix this screen');
    await fireEvent.press(screen.getByRole('button', { name: 'Attach an image' }));
    await waitFor(() => expect(startButton().props.accessibilityHint).toBe('Preparing the images.'));
    expect(startButton()).toBeDisabled();
    finish({ uri: 'file:///small.jpg', width: 1, height: 1, base64: 'AAAA' });
    await waitFor(() => expect(startButton()).toBeEnabled());
  });

  it('lets a failed image be tried again', async () => {
    mockImage.saveAsync.mockRejectedValueOnce(new Error('bad image'));
    pickLibrary();
    await render(<NewWorkScreen />);
    await fireEvent.changeText(await screen.findByLabelText('Task'), 'Fix this screen');
    await fireEvent.press(screen.getByRole('button', { name: 'Attach an image' }));
    const retry = await screen.findByRole('button', { name: 'Retry cat.jpg. The image could not be prepared.' });
    expect(startButton().props.accessibilityHint).toBe('Remove the images that failed, or try them again.');
    await fireEvent.press(retry);
    await waitFor(() => expect(startButton()).toBeEnabled());
  });

  it('starts without images as before', async () => {
    await render(<NewWorkScreen />);
    await fireEvent.changeText(await screen.findByLabelText('Task'), 'Fix the flaky test');
    await waitFor(() => expect(startButton()).toBeEnabled());
    await fireEvent.press(startButton());
    await waitFor(() => expect(mockActive.api.workbenches.create).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'Fix the flaky test', namingText: undefined })));
    expect(mockActions.send).not.toHaveBeenCalled();
  });

  it('moves the text and images into the new chat when the first message fails', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    mockActions.send.mockRejectedValueOnce(new Error('The server is busy.'));
    pickLibrary();
    await render(<NewWorkScreen />);
    await fireEvent.changeText(await screen.findByLabelText('Task'), 'Fix this screen');
    await attach();
    await waitFor(() => expect(startButton()).toBeEnabled());
    await fireEvent.press(startButton());
    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith({ pathname: '/sessions/[id]', params: { id: 'session-new' } }));
    expect(alert.mock.calls[0][0]).toBe('The first message did not send');
    expect(alert.mock.calls[0][1]).toContain('Your text and images are in the new chat.');
    expect(mockActive.store.local('chat-one').draft).toBe('Fix this screen');
    expect(readImageDrafts('chat-one')).toEqual([expect.objectContaining({ name: 'cat.jpg', status: 'ready',
      attachment: { name: 'cat.jpg', mimeType: 'image/jpeg', dataBase64: 'AAAA' } })]);
    expect(readImageDrafts('new:prompt')).toEqual([]);
  });

  it('keeps the text and images on the page when the session has no chat to take them', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    mockActive.api.workbenches.create.mockResolvedValueOnce(session({ id: 'session-new', chats: [] }));
    jest.spyOn(jest.requireActual('@talyn/client/native').workbenches, 'createChat').mockRejectedValueOnce(new Error('No chat.'));
    pickLibrary();
    await render(<NewWorkScreen />);
    await fireEvent.changeText(await screen.findByLabelText('Task'), 'Fix this screen');
    await attach();
    await waitFor(() => expect(startButton()).toBeEnabled());
    await fireEvent.press(startButton());
    await waitFor(() => expect(alert).toHaveBeenCalled());
    expect(alert.mock.calls[0][1]).toContain('Your text and images are still on this page.');
    expect(mockActive.store.local('new:prompt').draft).toBe('Fix this screen');
    expect(readImageDrafts('new:prompt')).toHaveLength(1);
  });
});
