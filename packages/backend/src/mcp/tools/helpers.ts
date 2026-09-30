import type { Task, Workspace } from '@talyn/shared';
import { callApi, type PublicPr } from '../api.js';
import type { McpToolDefinition } from './index.js';

export function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/** Resolve a workspace: explicit arg → the sole workspace → ask the caller. */
export async function resolveWorkspace(
  ownerId: string,
  args: Record<string, unknown>
): Promise<string> {
  const explicit = str(args.workspace_id);
  if (explicit) return explicit;
  const workspaces = await callApi<Workspace[]>(ownerId, 'GET', '/workspaces');
  if (workspaces.length === 1) return workspaces[0].id;
  if (workspaces.length === 0) {
    throw new Error('No workspaces found — create one in the Talyn app first.');
  }
  const list = workspaces.map((w) => `  ${w.id} — ${w.name}`).join('\n');
  throw new Error(`Multiple workspaces — pass workspace_id. Available:\n${list}`);
}

export function flagsOf(pr: PublicPr): string {
  const flags: string[] = [];
  if (pr.summary.draft) flags.push('draft');
  if (pr.autoKeepMergeable) flags.push('auto-keep');
  if (pr.mergeQueued) flags.push(`merge-queued${pr.mergeQueue ? `:${pr.mergeQueue.status}` : ''}`);
  return flags.length ? `  [${flags.join(', ')}]` : '';
}

export function prLine(pr: PublicPr): string {
  const c = pr.summary.checks;
  const checks =
    c.total > 0
      ? `checks ${c.passed}/${c.total}${c.failed ? ` ✗${c.failed}` : ''}${c.inProgress ? ` ⧗${c.inProgress}` : ''}`
      : 'checks —';
  const review = pr.summary.effectiveReviewDecision ?? pr.summary.reviewDecision ?? 'none';
  return (
    [
      pr.id,
      `#${pr.number} ${pr.owner}/${pr.repo}`,
      `[${pr.state}]`,
      `"${pr.summary.title}"`,
      checks,
      `mergeable:${pr.summary.mergeable}`,
      `review:${review}`,
    ].join('  ') +
    flagsOf(pr) +
    `\n    ${pr.summary.url}`
  );
}

export function needsAttention(pr: PublicPr): boolean {
  const s = pr.summary;
  return (
    s.checks.failed > 0 ||
    s.mergeable === 'CONFLICTING' ||
    s.reviewDecision === 'CHANGES_REQUESTED' ||
    s.unresolvedReviewThreads > 0
  );
}

export function taskLine(t: Task): string {
  return `- ${t.id}  [${t.status}]  ${t.type}  "${t.title}"`;
}

export const BUCKET_TO_RELATIONSHIP: Record<string, string> = {
  mine: 'authored',
  review_requested: 'review_requested',
  needs_attention: 'authored',
  all: 'all',
  watching: 'watching',
};

export function requireId(args: Record<string, unknown>, key: string): string {
  const v = str(args[key]);
  if (!v) throw new Error(`${key} is required`);
  return v;
}

export function deriveTitle(prompt: string): string {
  return prompt.split('\n')[0].trim().slice(0, 80) || 'New task';
}

export function trim(s: string, max = 280): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

export function bool(args: Record<string, unknown>, key: string, fallback?: boolean): boolean {
  if (args[key] === undefined && fallback !== undefined) return fallback;
  if (typeof args[key] !== 'boolean') throw new Error(`${key} must be a boolean`);
  return args[key];
}

export function objectArg(args: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = args[key];
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${key} must be an object`);
  return value as Record<string, unknown>;
}

export const textSchema = { type: 'string' };
export const booleanSchema = { type: 'boolean' };
export const workspaceSchema = {
  workspace_id: { type: 'string', description: 'Defaults to your only workspace.' },
};
export const prSchema = { pull_request_id: textSchema };
export const pageSchema = {
  limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
  cursor: {
    type: 'string',
    description: 'The createdAt time of the last run on the previous page.',
  },
};

export function pageLimit(args: Record<string, unknown>, max = 200): number {
  const value = args.limit ?? 50;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > max) {
    throw new Error(`limit must be an integer from 1 to ${max}`);
  }
  return value;
}

export function pageQuery(args: Record<string, unknown>): string {
  const params = new URLSearchParams({ limit: String(pageLimit(args)) });
  if (str(args.cursor)) params.set('cursor', str(args.cursor)!);
  return params.toString();
}

export function pageText<T extends { createdAt: string }>(
  rows: T[],
  args: Record<string, unknown>,
  line: (row: T) => string
): string {
  const lines = rows.map(line);
  if (rows.length === pageLimit(args))
    lines.push(`more: pass cursor=${rows[rows.length - 1].createdAt}`);
  return lines.join('\n') || 'No runs.';
}

export function defineTool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
  annotations: McpToolDefinition['annotations'],
  handler: McpToolDefinition['handler'],
  feature?: McpToolDefinition['feature']
): McpToolDefinition {
  return {
    name: `talyn_${name}`,
    description,
    inputSchema: { type: 'object', properties, required },
    annotations,
    handler,
    ...(feature ? { feature } : {}),
  };
}

export function linesOrNone<T>(rows: T[], line: (row: T) => string): string {
  return rows.map(line).join('\n') || 'None.';
}

export function fieldsText(value: unknown): string {
  if (value === null || value === undefined) return 'none';
  if (Array.isArray(value)) return value.map(fieldsText).join('; ');
  if (typeof value === 'object')
    return Object.entries(value)
      .map(([key, v]) => `${key}: ${fieldsText(v)}`)
      .join('; ');
  return String(value);
}
