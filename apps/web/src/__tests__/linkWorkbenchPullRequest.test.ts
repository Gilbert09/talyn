import { describe, it, expect, vi } from 'vitest';
import type { Workbench } from '@talyn/shared';
import { linkSessionPullRequest, parsePullRequestNumber } from '../lib/linkWorkbenchPullRequest';

const wb = { id: 'wb1', runtime: 'sandbox', branch: 'old', repoFullName: 'acme/app' } as Workbench;

function setup() {
  return {
    linkPullRequest: vi.fn().mockResolvedValue({ workbench: { ...wb, pullRequestId: 'pr1' } }),
    unlinkPullRequest: vi.fn().mockResolvedValue(wb),
  };
}

describe('linkSessionPullRequest', () => {
  it('links a sandbox session and returns the backend row', async () => {
    const api = setup();
    await expect(linkSessionPullRequest(api, wb, 7)).resolves.toEqual({ ...wb, pullRequestId: 'pr1' });
    expect(api.linkPullRequest).toHaveBeenCalledWith('wb1', 7);
    expect(api.unlinkPullRequest).not.toHaveBeenCalled();
  });

  it.each(['merged', 'closed'] as const)('links a %s PR', async (state) => {
    const api = setup();
    const linked = { ...wb, pullRequestId: 'pr1', pr: { number: 7, state } } as Workbench;
    api.linkPullRequest.mockResolvedValue({ workbench: linked });
    await expect(linkSessionPullRequest(api, wb, 7)).resolves.toBe(linked);
  });

  it('removes the link again when the backend asks for a local checkout', async () => {
    const api = setup();
    const local = { ...wb, runtime: 'local', localPath: '/tmp/worktree' } as Workbench;
    api.linkPullRequest.mockResolvedValue({
      workbench: { ...local, pullRequestId: 'pr1' },
      needsCheckout: { branch: 'feature', remoteRef: 'refs/heads/feature' },
    });
    await expect(linkSessionPullRequest(api, local, 7)).rejects.toThrow(/desktop app/);
    expect(api.unlinkPullRequest).toHaveBeenCalledWith('wb1');
  });

  it('passes a backend refusal through without unlinking', async () => {
    const api = setup();
    api.linkPullRequest.mockRejectedValue(new Error('Not found'));
    await expect(linkSessionPullRequest(api, wb, 7)).rejects.toThrow('Not found');
    expect(api.unlinkPullRequest).not.toHaveBeenCalled();
  });
});

describe('parsePullRequestNumber', () => {
  it.each([
    ['7', 7],
    [' #7 ', 7],
    ['https://github.com/acme/app/pull/7', 7],
    ['https://github.com/ACME/App/pull/7/', 7],
    ['0', null],
    ['-7', null],
    ['1.2', null],
    ['https://github.com/other/app/pull/7', null],
    ['https://github.com.evil.test/acme/app/pull/7', null],
    ['https://github.com/acme/app/issues/7', null],
    ['9007199254740992', null],
    ['abc', null],
  ])('parses %s', (input, expected) => {
    expect(parsePullRequestNumber(input, 'acme/app')).toBe(expected);
  });
});
