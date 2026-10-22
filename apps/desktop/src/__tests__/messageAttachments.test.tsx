import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MessageAttachments } from '../renderer/components/workbench/MessageAttachments';
import { WorkbenchTranscript } from '../renderer/components/workbench/WorkbenchTranscript';
import { rememberAttachmentBlob, rememberAttachmentPreview } from '../renderer/lib/attachmentPreviews';
import type { WorkbenchChat, WorkbenchEvent } from '@talyn/shared';
import type { WorkbenchOps } from '../renderer/lib/workbenchOps';

jest.mock('../renderer/lib/supabase', () => ({ isSupabaseConfigured: () => false, supabase: null }));

const path = '.context/attachments/preview.png';
const attachment = { name: 'preview.png', mimeType: 'image/png', path };
const attachmentBlob = jest.fn<Promise<Blob>, [string, string]>();
const ops = { attachmentBlob } as unknown as WorkbenchOps;

beforeAll(() => {
  URL.createObjectURL = jest.fn(() => 'blob:preview');
  URL.revokeObjectURL = jest.fn();
});
beforeEach(() => attachmentBlob.mockReset());

test('shows a cached thumbnail without a fetch and opens a lightbox', () => {
  rememberAttachmentPreview(path, 'data:image/png;base64,aGVsbG8=');
  render(<MessageAttachments attachments={[attachment]} ops={ops} />);
  expect(screen.getByAltText('preview.png')).toHaveAttribute('src', 'data:image/png;base64,aGVsbG8=');
  expect(attachmentBlob).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Open preview.png' }));
  expect(screen.getAllByAltText('preview.png')).toHaveLength(2);
  fireEvent.keyDown(window, { key: 'Escape' });
  expect(screen.getAllByAltText('preview.png')).toHaveLength(1);
});

test('shows the attachment inside a user message bubble', () => {
  const bubblePath = '.context/attachments/bubble.png';
  rememberAttachmentPreview(bubblePath, 'data:image/png;base64,YQ==');
  const events = [{
    chatId: 'chat-1', seq: 1, turn: 1,
    event: { seq: 1, type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Here is the image' }] },
      talyn: { kind: 'user_message', attachments: [{ ...attachment, path: bubblePath }] } },
  }] as WorkbenchEvent[];
  const chat = { id: 'chat-1', status: 'idle' } as WorkbenchChat;
  render(<WorkbenchTranscript chat={chat} events={events} loading={false} error={null} ops={ops} />);
  expect(screen.getByText('Here is the image')).toBeInTheDocument();
  expect(screen.getByAltText('preview.png')).toHaveAttribute('src', 'data:image/png;base64,YQ==');
  expect(attachmentBlob).not.toHaveBeenCalled();
});

test('loads a sandbox image blob', async () => {
  attachmentBlob.mockResolvedValue(new Blob(['image'], { type: 'image/png' }));
  render(<MessageAttachments attachments={[{ ...attachment, path: '.context/attachments/other.png' }]} ops={ops} />);
  expect(screen.getByLabelText('Loading preview.png')).toBeInTheDocument();
  await waitFor(() => expect(screen.getByAltText('preview.png')).toHaveAttribute('src', 'blob:preview'));
  expect(attachmentBlob).toHaveBeenCalledWith('.context/attachments/other.png', 'image/png');
});

test('shows an unavailable chip after a failed image read', async () => {
  attachmentBlob.mockRejectedValue(new Error('unavailable'));
  render(<MessageAttachments attachments={[{ ...attachment, path: '.context/attachments/missing.png' }]} ops={ops} />);
  expect(await screen.findByText(/Image unavailable/)).toBeInTheDocument();
});

test('shows a file chip for a non-image attachment', () => {
  render(<MessageAttachments attachments={[{ name: 'notes.txt', mimeType: 'text/plain', path: '.context/attachments/notes.txt' }]} ops={ops} />);
  expect(screen.getByText('notes.txt')).toBeInTheDocument();
  expect(attachmentBlob).not.toHaveBeenCalled();
});

test('revokes an object URL when the preview cache evicts it', () => {
  jest.mocked(URL.createObjectURL).mockImplementationOnce(() => 'blob:first');
  rememberAttachmentBlob('.context/attachments/first.png', new Blob(['a']));
  for (let index = 0; index < 50; index++) {
    rememberAttachmentPreview(`.context/attachments/cache-${index}.png`, 'data:image/png;base64,YQ==');
  }
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:first');
});
