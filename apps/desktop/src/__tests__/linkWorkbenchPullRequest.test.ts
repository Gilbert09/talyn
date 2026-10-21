import type { Workbench } from '@talyn/shared';
import { linkSessionPullRequest, parsePullRequestNumber } from '../renderer/lib/linkWorkbenchPullRequest';

const wb = {
  id: 'wb1',
  runtime: 'local',
  branch: 'old',
  localPath: '/tmp/worktree',
  repoFullName: 'acme/app',
} as Workbench;
const clean = { exitCode: 0, stdout: '', stderr: '' };

function setup(remoteRef = 'refs/heads/feature') {
  const exec = jest.fn().mockResolvedValue(clean);
  const api = {
    linkPullRequest: jest
      .fn()
      .mockResolvedValue({
        workbench: { ...wb, pullRequestId: 'pr1' },
        needsCheckout: { branch: 'feature', remoteRef },
      }),
    unlinkPullRequest: jest.fn().mockResolvedValue(wb),
    update: jest.fn().mockResolvedValue({ ...wb, branch: 'feature', pullRequestId: 'pr1' }),
  };
  return { exec, api };
}

describe('linkSessionPullRequest', () => {
  it.each([
    ['refs/heads/feature', 'feature'],
    ['refs/pull/7/head', 'pr-7'],
  ])('checks out %s and reports the branch', async (remoteRef, remoteBranch) => {
    const { exec, api } = setup(remoteRef);
    const result = await linkSessionPullRequest(api, { exec }, wb, 7);
    expect(exec.mock.calls[0]).toEqual(['/tmp/worktree', [{ argv: ['git', 'status', '--porcelain'] }]]);
    const refspec = `+${remoteRef}:refs/remotes/origin/${remoteBranch}`;
    expect(exec.mock.calls[1]).toEqual([
      '/tmp/worktree',
      [
        { argv: ['git', 'fetch', 'origin', refspec], env: { GIT_TERMINAL_PROMPT: '0' } },
        { argv: ['git', 'config', '--fixed-value', '--replace-all', 'remote.origin.fetch', refspec, refspec] },
        { argv: ['git', 'checkout', '-B', 'feature', `origin/${remoteBranch}`] },
        { argv: ['git', 'branch', '--set-upstream-to', `origin/${remoteBranch}`, 'feature'] },
      ],
    ]);
    expect(api.update).toHaveBeenCalledWith('wb1', { branch: 'feature' });
    expect(api.update.mock.invocationCallOrder[0]).toBeGreaterThan(exec.mock.invocationCallOrder[1]);
    expect(result.branch).toBe('feature');
  });

  it.each([' M file.ts\n', '?? new.ts\n'])('refuses dirty work and removes the link: %s', async (stdout) => {
    const { exec, api } = setup();
    exec.mockResolvedValue({ ...clean, stdout });
    await expect(linkSessionPullRequest(api, { exec }, wb, 7)).rejects.toThrow(
      'Commit or discard the changes in this session first.'
    );
    expect(exec).toHaveBeenCalledTimes(1);
    expect(api.unlinkPullRequest).toHaveBeenCalledWith('wb1');
    expect(api.update).not.toHaveBeenCalled();
  });

  it('removes the link when checkout fails', async () => {
    const { exec, api } = setup();
    exec.mockResolvedValueOnce(clean).mockResolvedValueOnce({ ...clean, exitCode: 1 });
    await expect(linkSessionPullRequest(api, { exec }, wb, 7)).rejects.toThrow('Could not check out');
    expect(api.unlinkPullRequest).toHaveBeenCalledWith('wb1');
    expect(api.update).not.toHaveBeenCalled();
  });

  it('does no git work when the branch is already correct', async () => {
    const { exec, api } = setup();
    api.linkPullRequest.mockResolvedValue({ workbench: wb });
    await linkSessionPullRequest(api, { exec }, wb, 7);
    expect(exec).not.toHaveBeenCalled();
    expect(api.update).not.toHaveBeenCalled();
  });

  it('links sandbox sessions without a local bridge', async () => {
    const { api } = setup();
    api.linkPullRequest.mockResolvedValue({ workbench: wb });
    await linkSessionPullRequest(api, null, { ...wb, runtime: 'sandbox' }, 7);
    expect(api.linkPullRequest).toHaveBeenCalledWith('wb1', 7);
  });

  it('refuses a local session without its bridge', async () => {
    const { api } = setup();
    await expect(linkSessionPullRequest(api, null, wb, 7)).rejects.toThrow('no local worktree');
    expect(api.linkPullRequest).not.toHaveBeenCalled();
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
