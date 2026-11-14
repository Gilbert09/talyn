import { PostHogCodeClient } from '../posthogCode/client.js';

/**
 * The PostHog Inbox (self-driving signals) REST API, read-only.
 *
 * The same transport as PostHog Code (`PostHogCodeClient`): one bearer token
 * per request, a forced refresh and one retry on a 401, and a
 * `PostHogCodeApiError` with the status for anything else. Paths are under
 * `/api/projects/:project_id/signals/reports/` (confirmed against PostHog's
 * OpenAPI schema, `signals_reports_list` / `_retrieve` /
 * `signals_report_artefacts_list`, which need `inbox:read`).
 */

/** One report as PostHog serves it. Only the fields Talyn reads. */
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
}
