import '@testing-library/jest-dom';
import React from 'react';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { RepoSandboxSize } from '../renderer/components/widgets/RepoSandboxSize';

const get = jest.fn();
const set = jest.fn();
jest.mock('../renderer/lib/api', () => ({ api: { repositories: { sandboxSize: { get: (...a: unknown[]) => get(...a), set: (...a: unknown[]) => set(...a) } } } }));
jest.mock('../renderer/stores/toast', () => ({ toast: { error: jest.fn(), success: jest.fn(), info: jest.fn() } }));

const auto = { setting: 'auto', effective: 'large', detected: { size: 'large', reason: 'compose.yml runs kafka.', sha: 's', at: 't' } };

describe('RepoSandboxSize', () => {
  beforeEach(() => { get.mockReset(); set.mockReset(); });
  afterEach(cleanup);

  it('shows all five sizes with hints and the detected answer for Auto', async () => {
    get.mockResolvedValue(auto);
    render(<RepoSandboxSize repositoryId="r1" />);
    expect(await screen.findByLabelText('Sandbox size')).toHaveValue('auto');
    expect(screen.getByRole('option', { name: 'Auto' })).toBeTruthy();
    expect([...screen.getAllByRole('option')].map((option) => [option.getAttribute('value'), option.textContent])).toEqual([
      ['auto', 'Auto'],
      ['small', 'Small · 2 GB — Docs and scripts'],
      ['standard', 'Standard · 4 GB — Most repos'],
      ['medium', 'Medium · 8 GB — Big builds, one database'],
      ['large', 'Large · 12 GB — Full test stacks'],
      ['xlarge', 'X-Large · 16 GB — The heaviest stacks'],
    ]);
    expect(screen.getByText(/Auto picks Large · 12 GB: compose.yml runs kafka\./)).toBeTruthy();
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
