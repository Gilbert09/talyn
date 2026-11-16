import type { PostHogInboxFactField, PostHogInboxFacts } from '@talyn/shared';
import { MAX_ISSUE_FACT_TEXT } from '@talyn/shared';
import type { PostHogInboxArtefact, PostHogInboxReport } from './api.js';

/** What the facts need to know about the PostHog connection. */
export interface PostHogInboxConnectionRef {
  /** The `integrations` row id. */
  id: string;
  workspaceId: string;
  projectId: string;
  /** Normalised host, like `https://us.posthog.com`. */
  host: string;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : [];
}

function cut(text: string): string {
  return text.length > MAX_ISSUE_FACT_TEXT ? text.slice(0, MAX_ISSUE_FACT_TEXT) : text;
}

/** The report in the PostHog app. */
export function reportUrl(connection: Pick<PostHogInboxConnectionRef, 'host' | 'projectId'>, reportId: string): string {
  return `${connection.host}/project/${encodeURIComponent(connection.projectId)}/inbox/${encodeURIComponent(reportId)}`;
}

/** `owner/repo`, lowercase-insensitive, or null when it is not one. */
export function repositorySlug(raw: unknown): string | null {
  const value = str(raw).trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '').replace(/\/+$/, '');
  return /^[^/\s]+\/[^/\s]+$/.test(value) ? value : null;
}

/**
 * PURE: the facts of one report, as PostHog served it. Suggested reviewers
 * are not on the report: they start unknown, and the adapter reads them from
 * the artefacts when a rule asks for them.
 */
export function reportToFacts(report: PostHogInboxReport, connection: PostHogInboxConnectionRef): PostHogInboxFacts | null {
  const reportId = str(report.id).trim();
  const updatedAt = str(report.updated_at).trim();
  if (!reportId || !updatedAt) return null;
  const unknownFields: PostHogInboxFactField[] = ['suggestedReviewers'];
  if (report.source_metadata_available === false) unknownFields.push('sourceProducts', 'scout');
  const signalCount = typeof report.signal_count === 'number' && Number.isFinite(report.signal_count) ? report.signal_count : 0;
  return {
    integration: 'posthog_inbox',
    event: 'report_ready',
    connectionId: connection.id,
    projectId: connection.projectId,
    reportId,
    updatedAt,
    title: str(report.title).trim(),
    summary: cut(str(report.summary)),
    url: reportUrl(connection, reportId),
    status: str(report.status),
    priority: str(report.priority).trim() || null,
    actionability: str(report.actionability).trim() || null,
    alreadyAddressed: typeof report.already_addressed === 'boolean' ? report.already_addressed : null,
    suppressionSource: str(report.suppression_source).trim() || null,
    sourceProducts: strings(report.source_products),
    scout: str(report.scout_name).trim() || null,
    repository: repositorySlug(report.repo_slug),
    suggestedReviewers: [],
    signalCount,
    unknownFields,
  };
}

/**
 * The GitHub logins of the newest `suggested_reviewers` artefact. Null when
 * the report has none, so the caller can tell "nobody" from "not judged yet".
 */
export function suggestedReviewersFromArtefacts(artefacts: PostHogInboxArtefact[]): string[] | null {
  const latest = artefacts.find((a) => a.type === 'suggested_reviewers');
  if (!latest) return null;
  const content = Array.isArray(latest.content) ? latest.content : [];
  const logins = content
    .map((entry) => str((entry as { github_login?: unknown } | null)?.github_login).trim())
    .filter(Boolean);
  return [...new Set(logins)];
}

/**
 * PostHog's timestamp as microseconds since the epoch, for ordering. PostHog
 * writes six fractional digits, which a JS Date would cut to three. NaN when
 * it is not a timestamp.
 */
export function timestampMicros(iso: string): number {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})?$/.exec(iso.trim());
  if (!m) return NaN;
  const [, base, fraction = '', zone = 'Z'] = m;
  const seconds = Date.parse(`${base}${zone}`);
  if (Number.isNaN(seconds)) return NaN;
  const micros = Number((fraction + '000000').slice(0, 6));
  return seconds * 1000 + micros;
}
