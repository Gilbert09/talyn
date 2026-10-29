import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { RepoSandboxSize } from '../components/widgets/RepoSandboxSize';

const { get, set } = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn() }));
vi.mock('../lib/api', () => ({ api: { repositories: { sandboxSize: { get, set } } } }));
vi.mock('../stores/toast', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));

const auto = { setting: 'auto', effective: 'large', detected: { size: 'large', reason: 'compose.yml runs kafka.', sha: 's', at: 't' } };

describe('RepoSandboxSize', () => {
  beforeEach(() => { get.mockReset(); set.mockReset(); });
  afterEach(cleanup);

  it('shows the three choices and the detected answer for Auto', async () => {
    get.mockResolvedValue(auto);
    render(<RepoSandboxSize repositoryId="r1" />);
    expect(await screen.findByLabelText('Sandbox size')).toHaveValue('auto');
    expect(screen.getByRole('option', { name: 'Auto' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Standard (4 GB)' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Large (12 GB)' })).toBeTruthy();
    expect(screen.getByText(/Auto picks Large \(12 GB\): compose.yml runs kafka\./)).toBeTruthy();
  });

  it('saves a choice and drops the Auto hint', async () => {
    get.mockResolvedValue(auto);
    set.mockResolvedValue({ ...auto, setting: 'standard', effective: 'standard' });
    render(<RepoSandboxSize repositoryId="r1" />);
    fireEvent.change(await screen.findByLabelText('Sandbox size'), { target: { value: 'standard' } });
    await waitFor(() => expect(set).toHaveBeenCalledWith('r1', 'standard'));
    await waitFor(() => expect(screen.getByLabelText('Sandbox size')).toHaveValue('standard'));
    expect(screen.queryByText(/Auto picks/)).toBeNull();
  });

  it('renders nothing when the account has no sessions', async () => {
    get.mockRejectedValue(new Error('403'));
    const { container } = render(<RepoSandboxSize repositoryId="r1" />);
    await waitFor(() => expect(get).toHaveBeenCalled());
    expect(container.innerHTML).toBe('');
  });
});
