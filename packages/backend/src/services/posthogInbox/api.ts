import { PostHogCodeClient } from '../posthogCode/client.js';

/**
 * The PostHog Inbox (self-driving signals) REST API: the report reads, and
 * the one write Talyn makes, the claim.
 *
 * The same transport as PostHog Code (`PostHogCodeClient`): one bearer token
 * per request, a forced refresh and one retry on a 401, and a
 * `PostHogCodeApiError` with the status for anything else. Paths are under
 * `/api/projects/:project_id/signals/reports/` (confirmed against PostHog's
 * OpenAPI schema, `signals_reports_list` / `_retrieve` /
 * `signals_report_artefacts_list`, which need `inbox:read`). The claim is
 * `POST .../signals/reports/:id/claim/` (`signals_reports_claim`, `inbox:write`;
 * adding pull requests also needs `task:write`).
 */

/**
 * One report as PostHog serves it. Only the fields Talyn reads. The list rows
 * (`SignalReportList`) carry the same fields, `repo_slug` included (PostHog's
 * OpenAPI schema, checked 2026-11-16); an older PostHog leaves it out of the list.
 */
export interface PostHogInboxReport {
  id: string;
  title?: string | null;
  summary?: string | null;
  status?: string | null;
  priority?: string | null;
  actionability?: string | null;
  already_addressed?: boolean | null;
  suppression_source?: string | null;
  signal_count?: number | null;
  source_products?: string[] | null;
  scout_name?: string | null;
  /** `owner/repo` from the latest repository selection. On the single-report read only. */
  repo_slug?: string | null;
  work_state?: string | null;
  /** Who holds the report: a user, an internal task or an agent. Null when unclaimed. */
  assignee?: { claim_id?: string | null; kind?: string | null } | null;
  /** The pull request on the claim, and its state (`unknown`, `draft`, `open`, `closed`, `merged`). */
  implementation_pr_url?: string | null;
  implementation_pr_state?: string | null;
  created_at?: string;
  updated_at: string;
  /** False when PostHog could not read `source_products` and `scout_name` in time. */
  source_metadata_available?: boolean;
}

export interface PostHogInboxReportPage {
  count?: number;
  next?: string | null;
  results: PostHogInboxReport[];
  source_metadata_available?: boolean;
}

/** One artefact of a report. `content` depends on `type`. */
export interface PostHogInboxArtefact {
  id: string;
  type: string;
  content: unknown;
}

/** The list filters Talyn uses. Names are PostHog's query parameters. */
export interface PostHogInboxListQuery {
  status?: string;
  actionability?: string;
  priority?: string;
  already_addressed?: boolean;
  unclaimed?: boolean;
  ordering?: string;
  limit?: number;
  offset?: number;
  include_source_metadata?: boolean;
  /** Comma-separated source products; a report with a signal from ANY of them is kept. */
  source_product?: string;
  /** Comma-separated scout skill names; a report with a signal from ANY of them is kept. */
  scout?: string;
  /** Case-insensitive substring of the title OR the summary. */
  search?: string;
  /** ISO 8601: keeps reports created at or after this time. */
  created_after?: string;
}

function queryString(query: PostHogInboxListQuery): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    qs.set(key, String(value));
  }
  const text = qs.toString();
  return text ? `?${text}` : '';
}

export class PostHogInboxClient extends PostHogCodeClient {
  /** One page of reports. */
  listReports(query: PostHogInboxListQuery): Promise<PostHogInboxReportPage> {
    return this.request<PostHogInboxReportPage>('GET', `/signals/reports/${queryString(query)}`);
  }

  /** One report, with `repo_slug`. */
  getReport(reportId: string): Promise<PostHogInboxReport> {
    return this.request<PostHogInboxReport>('GET', `/signals/reports/${encodeURIComponent(reportId)}/`);
  }

  /** A report's artefacts: the work log, the repository selection, the suggested reviewers. */
  async listArtefacts(reportId: string): Promise<PostHogInboxArtefact[]> {
    const page = await this.request<{ results?: PostHogInboxArtefact[] } | PostHogInboxArtefact[]>(
      'GET',
      `/signals/reports/${encodeURIComponent(reportId)}/artefacts/`
    );
    if (Array.isArray(page)) return page;
    return Array.isArray(page?.results) ? page.results : [];
  }

  /** Start, resume, add pull requests to or release Talyn's claim on a report. */
  claimReport(reportId: string, body: PostHogInboxClaimRequest): Promise<PostHogInboxClaimResponse> {
    return this.request<PostHogInboxClaimResponse>('POST', `/signals/reports/${encodeURIComponent(reportId)}/claim/`, body);
  }
}

/**
 * The body of `POST .../signals/reports/:id/claim/` (PostHog's
 * `SignalReportClaim`). Only the fields Talyn sends.
 *
 * - No `claim_id`: start a claim. A report somebody else holds answers 409.
 * - `claim_id`: resume Talyn's own claim. A stale claim answers 409.
 * - `pull_requests`: add GitHub PR URLs. Additive and deduplicated, so a
 *   repeat is harmless.
 * - `release`: end the claim. Attached pull requests stay on the report.
 *   PostHog has no release reason.
 */
export interface PostHogInboxClaimRequest {
  claim_id?: string;
  pull_requests?: string[];
  release?: boolean;
}

/** The report PostHog answers a claim with. Only the fields Talyn reads. */
export interface PostHogInboxClaimResponse {
  id?: string;
  assignee?: { claim_id?: string | null; kind?: string | null } | null;
  implementation_pr_url?: string | null;
  work_state?: string | null;
}
