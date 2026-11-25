import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Workbench } from '@talyn/shared';
import type { WorkbenchOps } from '../lib/workbenchOps';
import { FilesTab } from '../components/workbench/FilesTab';

vi.mock('../components/workbench/CodeViewer', () => ({
  default: ({ path, content }: { path: string; content: string }) => <pre data-testid="code-viewer" data-path={path}>{content}</pre>,
}));

const b64 = (bytes: number[]) => Buffer.from(bytes).toString('base64');
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
const PNG = b64([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG = b64([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
const GIF = b64(ascii('GIF89a\x01\x00\x01\x00'));
const WEBP = b64([...ascii('RIFF'), 1, 0, 0, 0, ...ascii('WEBPVP8 ')]);
const ZIP = b64([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0, 0, 0, 0, 0]);

function renderTab(file: { content: string; binary: boolean }, name: string) {
  const ops = {
    unavailable: null,
    files: vi.fn(async () => ({ paths: [name] })),
    readFile: vi.fn(async () => file),
  } as unknown as WorkbenchOps;
  return render(<FilesTab workbench={{ id: 'wb1' } as Workbench} ops={ops} visible />);
}

async function openFile(name: string) {
  const row = await screen.findByText(name);
  await act(async () => {
    fireEvent.click(row);
  });
}

afterEach(cleanup);

describe('FilesTab image preview', () => {
  it.each([
    ['PNG', 'shot.png', PNG, 'image/png'],
    ['JPEG', 'photo.jpg', JPEG, 'image/jpeg'],
    ['GIF', 'anim.gif', GIF, 'image/gif'],
    ['WebP', 'pic.webp', WEBP, 'image/webp'],
    ['PNG with a wrong extension', 'shot.dat', PNG, 'image/png'],
  ])('shows a %s binary file as an image', async (_label, name, content, mime) => {
    renderTab({ content, binary: true }, name);
    await openFile(name);

    const img = await screen.findByRole('img');
    expect(img).toHaveAttribute('src', `data:${mime};base64,${content}`);
    expect(screen.queryByText(`${name} is a binary file.`)).not.toBeInTheDocument();
    expect(screen.queryByTestId('code-viewer')).not.toBeInTheDocument();
  });

  it.each([
    ['a zip file', 'a.zip', ZIP],
    ['a truncated PNG header', 'logo.png', 'iVBOR'],
    ['RIFF that is not WebP', 'a.wav', b64([...ascii('RIFF'), 1, 0, 0, 0, ...ascii('WAVEfmt ')])],
    ['invalid base64', 'bad.bin', '!!!!'],
  ])('keeps the binary message for %s', async (_label, name, content) => {
    renderTab({ content, binary: true }, name);
    await openFile(name);

    expect(await screen.findByText(`${name} is a binary file.`)).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('opens a text file in the code viewer even when its content looks like base64', async () => {
    renderTab({ content: PNG, binary: false }, 'notes.txt');
    await openFile('notes.txt');

    expect(await screen.findByTestId('code-viewer')).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });
});
