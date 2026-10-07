/**
 * Whether GitHub itself is working, as the backend sees it.
 *
 * Two signals feed it: the share of Talyn's own GitHub calls that end in a
 * server failure, and GitHub's public status page. It holds no tenant data.
 * See `services/githubHealth.ts` in the backend for how each state is decided.
 */
export type GithubHealthState = 'operational' | 'degraded' | 'down' | 'unknown';

/** Which signal reported a problem. `both` is the strongest claim. */
export type GithubHealthSource = 'traffic' | 'status_page' | 'both';

/** One GitHub API's calls in the rolling window. */
export interface GithubApiTraffic {
  requests: number;
  /** HTTP 500/502/503/504 and transport failures. Never a 4xx or a rate limit. */
  serverFailures: number;
  state: GithubHealthState;
}

export interface GithubTrafficHealth {
  rest: GithubApiTraffic;
  graphql: GithubApiTraffic;
  /** The worse of the two APIs. */
  state: GithubHealthState;
  /** Length of the rolling window the counts cover. */
  windowMs: number;
}

export interface GithubStatusComponent {
  name: string;
  /** Statuspage's own value, for example `operational` or `partial_outage`. */
  status: string;
}

export interface GithubStatusIncident {
  name: string;
  /** The incident's page on the status site. Not validated: see {@link githubStatusLink}. */
  url: string | null;
  impact: string | null;
  startedAt: string | null;
  /** The incident touches a GitHub component Talyn depends on. */
  relevant: boolean;
}

export interface GithubStatusPageHealth {
  /** Statuspage's overall indicator: `none`, `minor`, `major` or `critical`. */
  indicator: string | null;
  /** Only the components Talyn depends on. */
  components: GithubStatusComponent[];
  /** Every unresolved incident, including those that do not touch Talyn. */
  incidents: GithubStatusIncident[];
  /** When the backend last read the page successfully. */
  fetchedAt: string;
  /** What the page says for Talyn. `unknown` when the last good read is too old. */
  state: GithubHealthState;
}

export interface GithubHealth {
  state: GithubHealthState;
  /** Null when no signal reports a problem. */
  source: GithubHealthSource | null;
  traffic: GithubTrafficHealth;
  /** Null until the first successful read of the status page. */
  statusPage: GithubStatusPageHealth | null;
  /** ISO time the current `degraded` or `down` state began. Null in other states. */
  since: string | null;
  updatedAt: string;
}

export const GITHUB_STATUS_SITE_URL = 'https://www.githubstatus.com';

/**
 * The link a client may open for an incident.
 *
 * The URL comes from a page Talyn does not control, so only the status site
 * and its short-link host pass. Anything else becomes the status site's home.
 */
export function githubStatusLink(url: string | null | undefined): string {
  if (typeof url !== 'string') return GITHUB_STATUS_SITE_URL;
  if (url.startsWith('https://www.githubstatus.com/') || url.startsWith('https://stspg.io/')) {
    return url;
  }
  return GITHUB_STATUS_SITE_URL;
}

/**
 * The incident a banner names: the first one that touches Talyn, and only
 * while the status page itself reports a problem for Talyn.
 */
export function githubHealthIncident(health: GithubHealth | null): GithubStatusIncident | null {
  const page = health?.statusPage;
  if (!page || (page.state !== 'degraded' && page.state !== 'down')) return null;
  return page.incidents.find((incident) => incident.relevant) ?? null;
}
