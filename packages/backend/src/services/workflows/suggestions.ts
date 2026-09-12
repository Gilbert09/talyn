import type { WorkflowSuggestions } from '@talyn/shared';
import { githubService } from '../github.js';
import { githubRateGate } from '../githubRateGate.js';
import { prMonitorService } from '../prMonitor.js';

/**
 * The autocomplete options the workflow editor offers: labels, branches, people
 * and teams, for the repositories a workspace watches.
 *
 * # Why this is one call and not four
 *
 * The editor asks once when it opens and then filters in memory. Four endpoints
 * would mean four round-trips per repo per field, and every one of them spends
 * the account's single shared GitHub budget — the same budget the PR poller, the
 * merge queue and every webhook refresh draw on. One answer, cached, keeps the
 * cost of opening the editor bounded whatever the user clicks.
 *
 * # What each thing costs, and why it is fetched at the scope it is
 *
 * The first version of this fetched all four PER REPO, which on the workspace
 * that watches 80 PostHog repos meant 320 requests minimum — 80 of them
 * byte-identical calls to `/orgs/PostHog/teams`, and up to 800 more from
 * paginating collaborators on every one. On an account already inside a GitHub
 * backoff, opening the editor was a meaningful part of the problem it then
 * reported. So each thing is now fetched at its true scope:
 *
 *  - **labels** are genuinely per-repo, and are the suggestion list that matters
 *    most. One request per repo (paginated only where a repo has >100 labels).
 *  - **teams** belong to the ORG, not the repo. Fetched once per distinct owner.
 *  - **people** are nominally per-repo, but an org's repos share almost all their
 *    collaborators, and this is a suggestion list rather than an authorisation
 *    check. Sampled from ONE repo per owner. Somebody with access to a single
 *    repo is missing from the list and can still be typed in.
 *  - **branches** are not fetched from GitHub at all. The base-branch condition
 *    is overwhelmingly "the default branch", which we already store on the
 *    `repositories` row — and listing every branch of 80 repos to offer
 *    `release/2` as well is wildly out of proportion to that. Typed values work.
 *
 * # Everything degrades
 *
 * Each part is independent and a failure yields an EMPTY list for that part
 * rather than an error for the whole response. A picker with no suggestions is
 * still a working text field — the user types the label and it saves — whereas a
 * failed request is an editor that will not open. Teams in particular are
 * expected to come back empty: they need `members: read`, which Talyn's App does
 * not request.
 */

/**
 * How long a repository's suggestions are served from memory.
 *
 * Long, because this is reference data that changes on a human timescale — a new
 * label or a new collaborator is a weekly event, not a per-minute one — and
 * because the alternative is spending REST budget every time somebody opens the
 * editor.
 */
const TTL_MS = 10 * 60_000;

interface CacheEntry<T> {
  at: number;
  value: T;
}

/** Per-repo: labels only. */
const labelCache = new Map<string, CacheEntry<string[]>>();
/** Per-owner: the things that belong to an account rather than a repository. */
const ownerCache = new Map<
  string,
  CacheEntry<{ people: Array<{ login: string; isBot: boolean }>; teams: string[] }>
>();

/** Test hook. */
export function _resetWorkflowSuggestions(): void {
  labelCache.clear();
  ownerCache.clear();
}

/** Read through a cache, recording a miss's failure as `partial` rather than throwing. */
async function cached<T>(
  store: Map<string, CacheEntry<T>>,
  key: string,
  now: number,
  empty: T,
  fetch: () => Promise<T>,
  onFailure: () => void
): Promise<T> {
  const hit = store.get(key);
  if (hit && now - hit.at < TTL_MS) return hit.value;
  const value = await fetch().catch(() => {
    onFailure();
    return empty;
  });
  store.set(key, { at: now, value });
  return value;
}

/**
 * Suggestions across every repository the workspace watches, merged.
 *
 * Merged rather than per-repo because the editor's fields are workflow-wide: a
 * workflow can name three repositories and a label, and the label has to be
 * offered if ANY of them has it. Per-repo scoping would mean the label list
 * changing as the user edits the repo condition, which reads as the field
 * breaking.
 *
 * Returns whatever it could get. A workspace with no GitHub connection, or one
 * inside a rate-limit backoff, gets empty lists and a `partial` flag so the
 * editor can say "type it in" instead of implying the label does not exist.
 */
export async function workflowSuggestions(workspaceId: string): Promise<WorkflowSuggestions> {
  const repos = await prMonitorService.getWatchedRepos(workspaceId).catch(() => []);
  const out: WorkflowSuggestions = {
    repos: repos.map((r) => r.fullName),
    labels: [],
    // Straight off the `repositories` rows — no GitHub call, and no failure mode.
    branches: [...new Set(repos.map((r) => r.defaultBranch).filter(Boolean))].sort(),
    people: [],
    teams: [],
    partial: false,
  };
  if (repos.length === 0) return out;

  // Never queue behind a backoff for reference data. The editor is interactive,
  // and a picker that takes 300 seconds to populate is worse than one that
  // populates empty and lets the user type — which is exactly what `partial`
  // tells it to say.
  if (githubRateGate.isBlocked(githubService.accountKeyFor(workspaceId), 'rest')) {
    out.partial = true;
    return out;
  }

  const now = Date.now();
  const fail = () => {
    out.partial = true;
  };

  // ---- Per owner: teams, and one repo's collaborators ---------------------
  const owners = new Map<string, { owner: string; repo: string }>();
  for (const r of repos) if (!owners.has(r.owner)) owners.set(r.owner, { owner: r.owner, repo: r.repo });

  const people = new Map<string, boolean>();
  const teams = new Set<string>();
  for (const { owner, repo } of owners.values()) {
    const value = await cached(
      ownerCache,
      `${workspaceId}:${owner}`,
      now,
      { people: [], teams: [] },
      async () => {
        const [collaborators, orgTeams] = await Promise.allSettled([
          githubService.listRepoCollaborators(workspaceId, owner, repo),
          githubService.listOrgTeamSlugs(workspaceId, owner),
        ]);
        return {
          people: collaborators.status === 'fulfilled' ? collaborators.value : [],
          teams: orgTeams.status === 'fulfilled' ? orgTeams.value : [],
        };
      },
      fail
    );
    for (const p of value.people) people.set(p.login, p.isBot);
    for (const t of value.teams) teams.add(t);
  }

  // ---- Per repo: labels ---------------------------------------------------
  const labels = new Set<string>();
  for (const repo of repos) {
    const value = await cached(
      labelCache,
      `${workspaceId}:${repo.id}`,
      now,
      [] as string[],
      () => githubService.listRepoLabelNames(workspaceId, repo.owner, repo.repo),
      fail
    );
    for (const l of value) labels.add(l);
  }

  const byName = (a: string, b: string) => a.localeCompare(b);
  out.labels = [...labels].sort(byName);
  out.teams = [...teams].sort(byName);
  // People first, bots after: a reviewer picker is nearly always after a person,
  // and Dependabot sorting above a colleague is a small daily annoyance.
  out.people = [...people.entries()]
    .map(([login, isBot]) => ({ login, isBot }))
    .sort((a, b) => Number(a.isBot) - Number(b.isBot) || byName(a.login, b.login));
  return out;
}
