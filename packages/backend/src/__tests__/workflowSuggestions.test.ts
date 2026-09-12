import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetWorkflowSuggestions,
  workflowSuggestions,
} from '../services/workflows/suggestions.js';
import { githubService } from '../services/github.js';
import { githubRateGate } from '../services/githubRateGate.js';
import { prMonitorService } from '../services/prMonitor.js';

/**
 * The editor's autocomplete data.
 *
 * The promise worth testing is not "it returns labels" — it is that EVERYTHING
 * DEGRADES. A picker with no suggestions is still a working text field, because
 * GitHub only has to know the label; a failed request is an editor that will not
 * open. So every part is fetched independently and a failure yields an empty list
 * for that part alone.
 *
 * Teams are the case this exists for: listing them needs `members: read`, which
 * Talyn's App does not request, so a 403 there is the EXPECTED path and must not
 * cost the user their label suggestions.
 */

/** Three repos in one org — the shape that made the per-repo fetching expensive. */
const REPOS = [
  { id: 'r1', workspaceId: 'ws', owner: 'acme', repo: 'widget', fullName: 'acme/widget', defaultBranch: 'main' },
  { id: 'r2', workspaceId: 'ws', owner: 'acme', repo: 'gadget', fullName: 'acme/gadget', defaultBranch: 'master' },
  { id: 'r3', workspaceId: 'ws', owner: 'acme', repo: 'doodad', fullName: 'acme/doodad', defaultBranch: 'main' },
];

describe('workflowSuggestions', () => {
  beforeEach(() => {
    _resetWorkflowSuggestions();
    vi.spyOn(githubService, 'accountKeyFor').mockReturnValue('acme');
    vi.spyOn(githubRateGate, 'isBlocked').mockReturnValue(false);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(prMonitorService, 'getWatchedRepos').mockResolvedValue(REPOS as any);
    vi.spyOn(githubService, 'listRepoLabelNames').mockResolvedValue(['bug', 'enhancement']);
    vi.spyOn(githubService, 'listBranches').mockResolvedValue([
      { name: 'main', protected: true },
      { name: 'release/2', protected: false },
    ]);
    vi.spyOn(githubService, 'listRepoCollaborators').mockResolvedValue([
      { login: 'dependabot[bot]', isBot: true },
      { login: 'alice', isBot: false },
    ]);
    vi.spyOn(githubService, 'listOrgTeamSlugs').mockResolvedValue(['frontend']);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    _resetWorkflowSuggestions();
  });

  it('merges everything the workspace watches', async () => {
    const out = await workflowSuggestions('ws');
    expect(out.repos).toEqual(['acme/widget', 'acme/gadget', 'acme/doodad']);
    expect(out.labels).toEqual(['bug', 'enhancement']);
    expect(out.teams).toEqual(['frontend']);
    expect(out.partial).toBe(false);
  });

  describe('it fetches each thing at its true scope', () => {
    // The first version fetched all four PER REPO. On the workspace that watches
    // 80 PostHog repos that was 320 requests minimum, 80 of them byte-identical
    // `/orgs/PostHog/teams` calls — opening the editor was a meaningful part of
    // the rate limiting it then reported.

    it('asks for teams ONCE per owner, not once per repo', async () => {
      const teams = vi.spyOn(githubService, 'listOrgTeamSlugs');
      await workflowSuggestions('ws');
      expect(teams).toHaveBeenCalledTimes(1);
      expect(teams).toHaveBeenCalledWith('ws', 'acme');
    });

    it('samples collaborators from ONE repo per owner', async () => {
      // An org's repos share almost all their collaborators, and this is a
      // suggestion list rather than an authorisation check.
      const people = vi.spyOn(githubService, 'listRepoCollaborators');
      await workflowSuggestions('ws');
      expect(people).toHaveBeenCalledTimes(1);
    });

    it('asks for labels once per repo, because labels really are per-repo', async () => {
      const labels = vi.spyOn(githubService, 'listRepoLabelNames');
      await workflowSuggestions('ws');
      expect(labels).toHaveBeenCalledTimes(3);
    });

    it('never asks GitHub for branches — the default branch is already local', async () => {
      const branches = vi.spyOn(githubService, 'listBranches');
      const out = await workflowSuggestions('ws');
      expect(branches).not.toHaveBeenCalled();
      // Straight off the `repositories` rows, de-duplicated.
      expect(out.branches).toEqual(['main', 'master']);
    });

    it('spends a bounded number of requests for three repos in one org', async () => {
      const calls = [
        vi.spyOn(githubService, 'listRepoLabelNames'),
        vi.spyOn(githubService, 'listRepoCollaborators'),
        vi.spyOn(githubService, 'listOrgTeamSlugs'),
        vi.spyOn(githubService, 'listBranches'),
      ];
      await workflowSuggestions('ws');
      const total = calls.reduce((n, spy) => n + spy.mock.calls.length, 0);
      // 3 label reads + 1 collaborators + 1 teams. The old shape was 3 x 4 = 12,
      // and grew linearly in repos on all four.
      expect(total).toBe(5);
    });
  });

  it('sorts people before bots', async () => {
    // A reviewer picker is nearly always after a person, and Dependabot sorting
    // above a colleague is a small daily annoyance.
    const out = await workflowSuggestions('ws');
    expect(out.people.map((p) => p.login)).toEqual(['alice', 'dependabot[bot]']);
  });

  it('keeps the labels when TEAMS fail — the expected case', async () => {
    vi.spyOn(githubService, 'listOrgTeamSlugs').mockRejectedValue(new Error('403'));
    const out = await workflowSuggestions('ws');
    expect(out.teams).toEqual([]);
    expect(out.labels).toEqual(['bug', 'enhancement']);
    expect(out.people).toHaveLength(2);
  });

  it.each([
    ['listRepoLabelNames', 'labels'],
    ['listRepoCollaborators', 'people'],
  ] as const)('keeps the rest when %s fails', async (method, emptied) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(githubService, method as any).mockRejectedValue(new Error('boom'));
    const out = await workflowSuggestions('ws');
    expect(out[emptied]).toEqual([]);
    // The repo list comes from our own DB, so it survives any GitHub failure —
    // which is what keeps the repo condition usable even when nothing else loads.
    expect(out.repos).toHaveLength(3);
    // Branches survive anything: they never involve GitHub.
    expect(out.branches.length).toBeGreaterThan(0);
    const others = (['labels', 'people'] as const).filter((k) => k !== emptied);
    for (const key of others) expect(out[key].length).toBeGreaterThan(0);
  });

  it('does not queue behind a rate-limit backoff', async () => {
    // The editor is interactive. A picker that takes 300 seconds to populate is
    // worse than one that populates empty and lets the user type — which is
    // exactly what `partial` tells it to say.
    vi.spyOn(githubRateGate, 'isBlocked').mockReturnValue(true);
    const labels = vi.spyOn(githubService, 'listRepoLabelNames');
    const out = await workflowSuggestions('ws');
    expect(labels).not.toHaveBeenCalled();
    expect(out.partial).toBe(true);
    // The two things that need no network still answer.
    expect(out.repos).toHaveLength(3);
    expect(out.branches).toEqual(['main', 'master']);
  });

  it('answers with no repos rather than failing for a workspace with none', async () => {
    vi.spyOn(prMonitorService, 'getWatchedRepos').mockResolvedValue([]);
    const out = await workflowSuggestions('ws');
    expect(out).toMatchObject({ repos: [], labels: [], people: [], partial: false });
  });

  it('survives a workspace whose repo list cannot be read', async () => {
    vi.spyOn(prMonitorService, 'getWatchedRepos').mockRejectedValue(new Error('db down'));
    await expect(workflowSuggestions('ws')).resolves.toMatchObject({ repos: [] });
  });

  it('serves a second call from cache — opening the editor twice is free', async () => {
    const labels = vi.spyOn(githubService, 'listRepoLabelNames');
    await workflowSuggestions('ws');
    await workflowSuggestions('ws');
    // Every GitHub read here spends the account's single shared budget, which the
    // PR poller and the merge queue draw on too.
    expect(labels).toHaveBeenCalledTimes(3);
  });
});
