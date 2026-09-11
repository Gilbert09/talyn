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
 * editor. `refresh` is the escape hatch for the case where somebody has just
 * created the label they are trying to select.
 */
const TTL_MS = 10 * 60_000;

interface CacheEntry {
  at: number;
  value: RepoSuggestions;
}

interface RepoSuggestions {
  labels: string[];
  branches: string[];
  people: Array<{ login: string; isBot: boolean }>;
  teams: string[];
}

const cache = new Map<string, CacheEntry>();

/** Test hook. */
export function _resetWorkflowSuggestions(): void {
  cache.clear();
}

function emptyRepo(): RepoSuggestions {
  return { labels: [], branches: [], people: [], teams: [] };
}

/**
 * One repository's reference data.
 *
 * Every fetch is settled independently — `Promise.allSettled` rather than
 * `Promise.all` — so a repo whose teams 403 still contributes its labels.
 */
async function fetchRepo(
  workspaceId: string,
  owner: string,
  repo: string
): Promise<RepoSuggestions> {
  const [labels, branches, people, teams] = await Promise.allSettled([
    githubService.listRepoLabelNames(workspaceId, owner, repo),
    githubService.listBranches(workspaceId, owner, repo, { per_page: 100 }),
    githubService.listRepoCollaborators(workspaceId, owner, repo),
    githubService.listOrgTeamSlugs(workspaceId, owner),
  ]);

  return {
    labels: labels.status === 'fulfilled' ? labels.value : [],
    branches:
      branches.status === 'fulfilled'
        ? branches.value.map((b) => b.name).filter(Boolean)
        : [],
    people: people.status === 'fulfilled' ? people.value : [],
    teams: teams.status === 'fulfilled' ? teams.value : [],
  };
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
    branches: [],
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

  const labels = new Set<string>();
  const branches = new Set<string>();
  const teams = new Set<string>();
  const people = new Map<string, boolean>();
  const now = Date.now();

  for (const repo of repos) {
    const key = `${workspaceId}:${repo.id}`;
    const hit = cache.get(key);
    let value: RepoSuggestions;
    if (hit && now - hit.at < TTL_MS) {
      value = hit.value;
    } else {
      value = await fetchRepo(workspaceId, repo.owner, repo.repo).catch(() => {
        out.partial = true;
        return emptyRepo();
      });
      cache.set(key, { at: now, value });
    }
    for (const l of value.labels) labels.add(l);
    for (const b of value.branches) branches.add(b);
    for (const t of value.teams) teams.add(t);
    for (const p of value.people) people.set(p.login, p.isBot);
  }

  const byName = (a: string, b: string) => a.localeCompare(b);
  out.labels = [...labels].sort(byName);
  out.branches = [...branches].sort(byName);
  out.teams = [...teams].sort(byName);
  // People first, bots after: a reviewer picker is nearly always after a person,
  // and Dependabot sorting above a colleague is a small daily annoyance.
  out.people = [...people.entries()]
    .map(([login, isBot]) => ({ login, isBot }))
    .sort((a, b) => Number(a.isBot) - Number(b.isBot) || byName(a.login, b.login));
  return out;
}
