import '@testing-library/jest-dom';
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { WorkbenchInstructionCandidate, WorkbenchInstructionFile } from '@talyn/shared';
import { InstructionFilesSection } from '../renderer/components/settings/InstructionFilesSection';
import { mergeInstructionRows } from '../renderer/lib/instructionFiles';

const mockList = jest.fn();
const mockPut = jest.fn();
const mockRemove = jest.fn();
jest.mock('../renderer/lib/api', () => ({
  api: {
    workbenches: {
      instructions: {
        list: (...args: unknown[]) => mockList(...args),
        put: (...args: unknown[]) => mockPut(...args),
        remove: (...args: unknown[]) => mockRemove(...args),
      },
    },
  },
}));
const mockToastError = jest.fn();
jest.mock('../renderer/stores/toast', () => ({
  toast: { success: jest.fn(), error: (...args: unknown[]) => mockToastError(...args), info: jest.fn() },
}));
jest.mock('../renderer/stores/workspace', () => ({
  useWorkspaceStore: (selector: (s: unknown) => unknown) => selector({ currentWorkspaceId: 'ws1' }),
}));
let mockBridge: { instructionFiles?: () => Promise<WorkbenchInstructionCandidate[]> } | null = null;
jest.mock('../renderer/lib/workbenchBridge', () => ({
  getWorkbenchBridge: () => mockBridge,
}));

const candidate = (over: Partial<WorkbenchInstructionCandidate> = {}): WorkbenchInstructionCandidate => ({
  key: 'claude-user',
  agent: 'claude',
  target: 'user',
  displayPath: '~/.claude/CLAUDE.md',
  bytes: 2048,
  content: 'be terse',
  hash: 'hash-local',
  imports: [],
  missingImports: [],
  ...over,
});

const stored = (over: Partial<WorkbenchInstructionFile> = {}): WorkbenchInstructionFile => ({
  key: 'claude-user',
  agent: 'claude',
  target: 'user',
  repoFullName: null,
  sourcePath: '~/.claude/CLAUDE.md',
  bytes: 2048,
  contentHash: 'hash-local',
  enabled: true,
  updatedAt: '2026-10-18T00:00:00.000Z',
  ...over,
});

function withLocal(files: WorkbenchInstructionCandidate[]) {
  mockBridge = { instructionFiles: jest.fn().mockResolvedValue(files) };
}

beforeEach(() => {
  mockList.mockResolvedValue([]);
  mockPut.mockImplementation(async ({ file }: { file: { key: string; enabled: boolean } }) =>
    stored({ key: file.key, enabled: file.enabled, contentHash: file.enabled ? 'hash-local' : '' }),
  );
  mockRemove.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  jest.clearAllMocks();
  mockBridge = null;
});

describe('InstructionFilesSection', () => {
  it('says it needs the desktop app without a bridge', () => {
    render(<InstructionFilesSection />);
    expect(screen.getByText('This needs the Talyn desktop app.')).toBeInTheDocument();
    expect(mockList).not.toHaveBeenCalled();
  });

  it('uploads the content when a file is switched on', async () => {
    withLocal([candidate({ imports: ['~/.claude/RTK.md'] })]);
    render(<InstructionFilesSection />);
    const toggle = await screen.findByRole('switch', { name: 'Use ~/.claude/CLAUDE.md in sandboxes' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText('Includes RTK.md')).toBeInTheDocument();
    expect(screen.getByText('Claude')).toBeInTheDocument();

    fireEvent.click(toggle);
    await waitFor(() =>
      expect(mockPut).toHaveBeenCalledWith({
        workspaceId: 'ws1',
        file: {
          key: 'claude-user',
          agent: 'claude',
          target: 'user',
          repoFullName: null,
          sourcePath: '~/.claude/CLAUDE.md',
          content: 'be terse',
          enabled: true,
        },
      }),
    );
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'));
    expect(screen.getByText(/Synced/)).toBeInTheDocument();
  });

  it('switches a file off without sending its content', async () => {
    withLocal([candidate()]);
    mockList.mockResolvedValue([stored()]);
    render(<InstructionFilesSection />);
    const toggle = await screen.findByRole('switch');
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'));
    fireEvent.click(toggle);
    await waitFor(() => expect(mockPut).toHaveBeenCalled());
    expect(mockPut.mock.calls[0][0].file).toEqual(expect.objectContaining({ enabled: false }));
    expect(mockPut.mock.calls[0][0].file).not.toHaveProperty('content');
  });

  it('shows "Changed on this Mac" until the changed file is uploaded again', async () => {
    withLocal([candidate({ hash: 'hash-new', content: 'new text' })]);
    mockList.mockResolvedValue([stored({ contentHash: 'hash-old' })]);
    let finish: (v: WorkbenchInstructionFile) => void = () => undefined;
    mockPut.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    render(<InstructionFilesSection />);
    expect(await screen.findByText(/Changed on this Mac/)).toBeInTheDocument();
    await waitFor(() => expect(mockPut).toHaveBeenCalledTimes(1));
    expect(mockPut.mock.calls[0][0].file).toEqual(expect.objectContaining({ content: 'new text', enabled: true }));
    finish(stored({ contentHash: 'hash-new' }));
    expect(await screen.findByText(/Synced/)).toBeInTheDocument();
  });

  it('toasts once when the re-upload fails', async () => {
    withLocal([candidate({ hash: 'hash-new' }), candidate({ key: 'codex-user', agent: 'codex', displayPath: '~/.codex/AGENTS.md', hash: 'x2' })]);
    mockList.mockResolvedValue([stored({ contentHash: 'old' }), stored({ key: 'codex-user', agent: 'codex', contentHash: 'old' })]);
    mockPut.mockRejectedValue(new Error('offline'));
    render(<InstructionFilesSection />);
    await waitFor(() => expect(mockToastError).toHaveBeenCalledTimes(1));
    expect(screen.getAllByText(/Changed on this Mac/)).toHaveLength(2);
  });

  it('warns about a missing import', async () => {
    withLocal([candidate({ missingImports: ['~/.claude/gone.md'] })]);
    render(<InstructionFilesSection />);
    expect(await screen.findByText('Could not find ~/.claude/gone.md. The import stays as text.')).toBeInTheDocument();
  });

  it('offers Remove for a stored file that is not on this Mac', async () => {
    withLocal([]);
    mockList.mockResolvedValue([stored({ key: 'claude-rule:old.md', sourcePath: '~/.claude/rules/old.md' })]);
    render(<InstructionFilesSection />);
    expect(await screen.findByText(/Not on this Mac/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(mockRemove).toHaveBeenCalledWith('ws1', 'claude-rule:old.md'));
    await waitFor(() => expect(screen.queryByText(/Not on this Mac/)).not.toBeInTheDocument());
  });

  it('refuses to switch on a file over 256 KB and says why', async () => {
    withLocal([candidate({ bytes: 300 * 1024 })]);
    render(<InstructionFilesSection />);
    expect(
      await screen.findByText('Instruction files load into every turn; this one is 300 KB. Trim it below 256 KB.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('switch')).toBeDisabled();
  });

  it('says where it looked when there is nothing', async () => {
    withLocal([]);
    render(<InstructionFilesSection />);
    expect(await screen.findByText(/No instruction files on this Mac/)).toBeInTheDocument();
  });
});

describe('mergeInstructionRows', () => {
  it.each([
    ['off', [candidate()], [], 'off'],
    ['synced', [candidate()], [stored()], 'synced'],
    ['changed', [candidate({ hash: 'b' })], [stored({ contentHash: 'a' })], 'changed'],
    ['switched off but stored', [candidate()], [stored({ enabled: false, contentHash: '' })], 'off'],
    ['missing', [], [stored()], 'missing'],
  ])('%s', (_name, local, server, status) => {
    expect(mergeInstructionRows(local, server).map((r) => r.status)).toEqual([status]);
  });
});
