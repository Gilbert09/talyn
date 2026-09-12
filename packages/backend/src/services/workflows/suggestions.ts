import type { WorkflowSuggestions } from '@talyn/shared';
import { githubService } from '../github.js';
import { githubRateGate } from '../githubRateGate.js';
import { prMonitorService } from '../prMonitor.js';

/**
 * The autocomplete options the workflow editor offers.
 *
 * # Nothing is fetched until somebody asks for it
 *
 * Opening the editor costs ZERO GitHub requests. The repository list and the
 * branch list come off our own `repositories` rows, which is everything the
 * first two fields need — and the fields that do need GitHub (labels, people,
 * teams) only ask when the user opens one of them.
 *
 * That ordering matters because of what it replaced. The first version fetched
 * labels, branches, collaborators and teams for EVERY watched repo the moment
 * the editor opened: on the workspace that watches 80 PostHog repos, 320
 * requests minimum and up to 1,000 with pagination, spent before the user had
 * clicked anything. Opening the editor was itself a meaningful contributor to
 * the rate limiting it then reported.
 *
 * # And only for the repositories in scope
 *
 * Labels are per-repository, and a workflow almost always names the repositories
 * it applies to. So the caller passes those, and only those are read — one
 * request for the ordinary "this rule is about posthog/posthog" case, whatever
 * else the workspace watches.
 *
 * A workflow with no repository condition applies to all of them, and there is
 * no honest way to offer "the labels" of eighty repositories in a dropdown. That
 * case reads the workspace's repositories up to {@link UNSCOPED_REPO_LIMIT} and
 * says so with `partial`, which the editor turns into "add a repository
 * condition to see its labels". Typed values work throughout.
 *
 * # Everything degrades
 *
 * Each part is fetched independently and a failure yields an EMPTY list for that
 * part rather than an error for the whole response. A picker with no suggestions
 * is still a working text field — GitHub only has to know the label, not us —
 * whereas a failed request is an editor that will not open. Teams in particular
 * are expected to come back empty: they need `members: read`, which Talyn's App
 * does not request.
 */

/**
 * How long a repository's labels are served from memory.
 *
 * Long, because this is reference data that changes on a human timescale — a new
 * label is a weekly event, not a per-minute one — and because the alternative is
 * spending REST budget every time somebody opens a label field.
 */
const TTL_MS = 10 * 60_000;

/**
 * How many repositories an UNSCOPED request will read labels from.
 *
 * Not a round number picked for looks: a suggestion list is only useful while it
 * is fast, and these are serialised per account (concurrent reads are what
 * GitHub's secondary limit punishes). At roughly 150ms a repo, ten is the most
 * that fits inside the time somebody will wait with a dropdown open. Beyond it
 * the answer is not "wait longer", it is "name the repository you mean" — which
 * is also a better workflow.
 *
 * Scoped requests are NOT subject to this: naming twelve repositories is an
 * explicit instruction, and the editor is not guessing on the user's behalf.
 */
export const UNSCOPED_REPO_LIMIT = 10;

interface CacheEntry<T> {
  at: number;
  value: T;
}

/** Per-repo: labels. */
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

/** Read through a cache, recording a miss's failure rather than throwing. */
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

export interface SuggestionScope {
  /**
   * `owner/repo` full names the answer should cover — the repositories the
   * workflow names. Absent or empty means the workflow is unscoped, which reads
   * the workspace's repositories up to {@link UNSCOPED_REPO_LIMIT}.
   */
  repos?: string[];
  /**
   * Whether to read anything from GitHub at all. `false` (the default) answers
   * from local rows only, which is what the editor wants when it opens.
   */
  includeGithub?: boolean;
}

/**
 * Suggestions for the editor.
 *
 * With no scope this is a pure database read: the workspace's repositories and
 * their default branches. With `includeGithub` it also reads labels for the
 * repositories in scope, and the collaborators and teams of their owners.
 */
export async function workflowSuggestions(
  workspaceId: string,
  scope: SuggestionScope = {}
): Promise<WorkflowSuggestions> {
  const watched = await prMonitorService.getWatchedRepos(workspaceId).catch(() => []);
  const out: WorkflowSuggestions = {
    repos: watched.map((r) => r.fullName),
    // Straight off the `repositories` rows — no GitHub call, and no failure mode.
    // A base-branch condition is overwhelmingly "the default branch", and listing
    // every branch of every watched repo to also offer `release/2` was wildly out
    // of proportion to that.
    branches: [...new Set(watched.map((r) => r.defaultBranch).filter(Boolean))].sort(),
    labels: [],
    people: [],
    teams: [],
    partial: false,
  };
  if (!scope.includeGithub || watched.length === 0) return out;

  // Never queue behind a backoff for reference data. The editor is interactive,
  // and a picker that takes 300 seconds to populate is worse than one that
  // populates empty and lets the user type — which is exactly what `partial`
  // tells it to say.
  if (githubRateGate.isBlocked(githubService.accountKeyFor(workspaceId), 'rest')) {
    out.partial = true;
    return out;
  }

  // Resolve the scope against what the workspace actually watches: a workflow can
  // name a repository that has since been removed, and we have no token for one
  // that was never added.
  const wanted = new Set((scope.repos ?? []).map((r) => r.trim().toLowerCase()).filter(Boolean));
  const scoped = wanted.size > 0;
  let inScope = scoped
    ? watched.filter((r) => wanted.has(r.fullName.toLowerCase()))
    : watched;

  if (!scoped && inScope.length > UNSCOPED_REPO_LIMIT) {
    inScope = inScope.slice(0, UNSCOPED_REPO_LIMIT);
    // Say it rather than silently answering for a tenth of the repositories —
    // "this label does not exist" and "we did not look" must not read the same.
    out.partial = true;
  }
  if (inScope.length === 0) return out;

  const now = Date.now();
  const fail = () => {
    out.partial = true;
  };

  // ---- Per owner: teams, and one repo's collaborators ---------------------
  // Teams belong to the ORG, and an org's repositories share almost all their
  // collaborators — this is a suggestion list, not an authorisation check, so
  // one sample per owner is the right scope. Somebody with access to a single
  // repository is missing from the list and can still be typed in.
  const owners = new Map<string, { owner: string; repo: string }>();
  for (const r of inScope) if (!owners.has(r.owner)) owners.set(r.owner, r);

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
  for (const repo of inScope) {
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
