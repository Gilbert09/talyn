import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MAX_SPACE_IMAGE_LENGTH, SPACE_IMAGE_MAX_DIMENSION, type Space, type SpacesTeam, type Workspace } from '@talyn/shared';
import { railEntries } from '../lib/contextRail';
import { SpaceDot, SpaceTile } from '../components/spaces/SpaceAvatars';
import { CreateSpaceDialog, SpaceImagePicker } from '../components/spaces/SpaceDialogs';

vi.mock('../lib/supabase', () => ({ isSupabaseConfigured: () => false, supabase: null }));
vi.mock('../lib/analytics', () => ({ trackEvent: vi.fn(), captureAnalyticsException: vi.fn() }));

const mockDownscale = vi.fn();
vi.mock('../lib/imageDownscale', () => ({ downscaleImage: (...args: unknown[]) => mockDownscale(...args) }));

const mockCreateSpace = vi.fn();
vi.mock('../lib/api', () => ({
  ApiError: class ApiError extends Error {},
  api: {
    teams: { createSpace: (...args: unknown[]) => mockCreateSpace(...args) },
    spaces: {},
    workspaces: {},
  },
}));

vi.mock('../lib/spaces', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/spaces')>()),
  switchContext: vi.fn(),
}));

const PNG = 'data:image/png;base64,iVBORw0KGgo=';

const space = (over: Partial<Space> = {}): Space => ({
  id: 's1',
  teamId: 't1',
  name: 'Web App',
  color: '#10b981',
  image: null,
  createdByUserId: null,
  archivedAt: null,
  createdAt: '',
  updatedAt: '',
  ...over,
});

const file = () => new File(['x'], 'logo.png', { type: 'image/png' });
const fileInput = () => screen.getByLabelText('Space image') as HTMLInputElement;

beforeEach(() => {
  mockDownscale.mockReset();
  mockCreateSpace.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('railEntries', () => {
  it.each([
    ['an image', PNG, PNG],
    ['no image', null, null],
  ])('carries %s to the space tile', (_label, image, expected) => {
    const team: SpacesTeam = { id: 't1', name: 'Acme', role: 'member', homeWorkspaceId: null, createdAt: '', spaces: [space({ image })] };
    const entries = railEntries([{ id: 'ws1', name: 'Mine', repos: [] } as unknown as Workspace], [team], true);
    expect(entries[1]).toMatchObject({ kind: 'space', id: 's1', image: expected });
  });
});

describe('SpaceTile', () => {
  it('shows the image in place of the initials', () => {
    const { container } = render(<SpaceTile name="Web App" color="#10b981" image={PNG} size={36} />);
    const img = container.querySelector('img');
    expect(img).toHaveAttribute('src', PNG);
    expect(img).toHaveStyle({ width: '36px', height: '36px' });
    expect(screen.queryByText('WA')).not.toBeInTheDocument();
  });

  it.each([
    ['a colour', '#10b981'],
    ['no colour', null],
  ])('shows the initials on %s with no image', (_label, color) => {
    const { container } = render(<SpaceTile name="Web App" color={color} image={null} size={36} />);
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('WA')).toBeInTheDocument();
  });
});

describe('SpaceDot', () => {
  it('shows the image when the space has one', () => {
    const { container } = render(<SpaceDot color="#10b981" image={PNG} />);
    expect(container.querySelector('img')).toHaveAttribute('src', PNG);
  });

  it.each([undefined, null])('shows the colour dot when the image is %s', (image) => {
    const { container } = render(<SpaceDot color="#10b981" image={image} />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('span')).toHaveStyle({ backgroundColor: '#10b981' });
  });
});

describe('SpaceImagePicker', () => {
  it('downscales an upload and hands back the data URL', async () => {
    mockDownscale.mockResolvedValue(PNG);
    const onChange = vi.fn();
    render(<SpaceImagePicker name="Web" color="#10b981" value={null} onChange={onChange} />);
    expect(screen.getByRole('button', { name: /Upload image/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Remove/ })).not.toBeInTheDocument();

    const picked = file();
    fireEvent.change(fileInput(), { target: { files: [picked] } });
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(PNG));
    expect(mockDownscale).toHaveBeenCalledWith(picked, SPACE_IMAGE_MAX_DIMENSION);
  });

  it.each([
    ['too detailed', () => mockDownscale.mockResolvedValue(`data:image/png;base64,${'A'.repeat(MAX_SPACE_IMAGE_LENGTH)}`), /too detailed/],
    ['unreadable', () => mockDownscale.mockRejectedValue(new Error('could not load image')), /Could not read that image/],
  ])('refuses an image that is %s', async (_label, arrange, message) => {
    arrange();
    const onChange = vi.fn();
    render(<SpaceImagePicker name="Web" color={null} value={null} onChange={onChange} />);
    fireEvent.change(fileInput(), { target: { files: [file()] } });
    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('ignores an empty file selection', () => {
    const onChange = vi.fn();
    render(<SpaceImagePicker name="Web" color={null} value={null} onChange={onChange} />);
    fireEvent.change(fileInput(), { target: { files: [] } });
    expect(mockDownscale).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('removes the current image', () => {
    const onChange = vi.fn();
    render(<SpaceImagePicker name="Web" color={null} value={PNG} onChange={onChange} />);
    expect(screen.getByRole('button', { name: /Change image/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Remove/ }));
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('disables its buttons while the parent is busy', () => {
    render(<SpaceImagePicker name="Web" color={null} value={PNG} onChange={vi.fn()} disabled />);
    expect(screen.getByRole('button', { name: /Change image/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Remove/ })).toBeDisabled();
  });
});

describe('CreateSpaceDialog', () => {
  function submit(name: string) {
    fireEvent.change(screen.getByRole('textbox'), { target: { value: name } });
    fireEvent.click(screen.getByRole('button', { name: 'Create space' }));
  }

  it('sends the uploaded image with the new space', async () => {
    mockDownscale.mockResolvedValue(PNG);
    mockCreateSpace.mockResolvedValue(space({ image: PNG }));
    render(<CreateSpaceDialog teamId="t1" onOpenChange={vi.fn()} />);
    fireEvent.change(fileInput(), { target: { files: [file()] } });
    await screen.findByRole('button', { name: /Change image/ });
    submit('Web');
    await waitFor(() => expect(mockCreateSpace).toHaveBeenCalledTimes(1));
    expect(mockCreateSpace).toHaveBeenCalledWith('t1', expect.objectContaining({ name: 'Web', image: PNG }));
  });

  it('sends no image when none was uploaded', async () => {
    mockCreateSpace.mockResolvedValue(space());
    render(<CreateSpaceDialog teamId="t1" onOpenChange={vi.fn()} />);
    submit('Web');
    await waitFor(() => expect(mockCreateSpace).toHaveBeenCalledTimes(1));
    expect(mockCreateSpace.mock.calls[0]![1]).not.toHaveProperty('image');
  });
});
