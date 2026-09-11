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

const REPOS = [
  {
    id: 'r1',
    workspaceId: 'ws',
    owner: 'acme',
    repo: 'widget',
    fullName: 'acme/widget',
    defaultBranch: 'main',
  },
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
    expect(out.repos).toEqual(['acme/widget']);
    expect(out.labels).toEqual(['bug', 'enhancement']);
    expect(out.branches).toEqual(['main', 'release/2']);
    expect(out.teams).toEqual(['frontend']);
    expect(out.partial).toBe(false);
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
    ['listBranches', 'branches'],
    ['listRepoCollaborators', 'people'],
  ] as const)('keeps the rest when %s fails', async (method, emptied) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(githubService, method as any).mockRejectedValue(new Error('boom'));
    const out = await workflowSuggestions('ws');
    expect(out[emptied]).toEqual([]);
    // The repo list comes from our own DB, so it survives any GitHub failure —
    // which is what keeps the repo condition usable even when nothing else loads.
    expect(out.repos).toEqual(['acme/widget']);
    const others = (['labels', 'branches', 'people'] as const).filter((k) => k !== emptied);
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
    expect(out.repos).toEqual(['acme/widget']);
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
    expect(labels).toHaveBeenCalledTimes(1);
  });
});
