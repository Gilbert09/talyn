import type { Task } from '@talyn/shared';
import { McpApiError, callApi, type PrSummary, type PublicPr } from '../api.js';
import {
  str,
  requireId,
  trim,
  resolveWorkspace,
  prLine,
  needsAttention,
  BUCKET_TO_RELATIONSHIP,
  bool,
  booleanSchema,
  defineTool,
  prSchema,
  workspaceSchema,
  textSchema,
} from './helpers.js';
import type { McpToolDefinition } from './index.js';

export const PULLREQUESTS: McpToolDefinition[] = [
  {
    name: 'talyn_list_pull_requests',
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    description:
      'List pull requests in a workspace by bucket: "mine" (you authored), "review_requested" (awaiting your review), "needs_attention" (your PRs failing checks / conflicting / with change-requests or unresolved threads), "watching", or "all". Returns one compact line per PR including its Talyn id (needed for the other PR tools).',
    inputSchema: {
      type: 'object',
      properties: {
        workspace_id: { type: 'string', description: 'Defaults to your only workspace.' },
        bucket: {
          type: 'string',
          enum: ['mine', 'review_requested', 'needs_attention', 'watching', 'all'],
          description: 'Which set of PRs. Default: all.',
        },
        state: {
          type: 'string',
          enum: ['open', 'closed', 'merged', 'all'],
          description: 'PR state filter. Default: open.',
        },
        repo: { type: 'string', description: 'Filter by Talyn repository id.' },
        task_only: { type: 'boolean', description: 'Only PRs with a linked task.' },
        search: { type: 'string', description: 'Substring match on title or owner/repo.' },
      },
    },
    handler: async (ownerId, args) => {
      const ws = await resolveWorkspace(ownerId, args);
      const bucket = str(args.bucket) ?? 'all';
      const relationship = BUCKET_TO_RELATIONSHIP[bucket] ?? 'all';
      const params = new URLSearchParams({ workspaceId: ws, relationship });
      params.set('state', str(args.state) ?? 'open');
      if (str(args.repo)) params.set('repo', str(args.repo)!);
      if (str(args.search)) params.set('search', str(args.search)!);
      if (args.task_only === true) params.set('taskOnly', 'true');
      let prs = await callApi<PublicPr[]>(ownerId, 'GET', `/pull-requests?${params.toString()}`);
      if (bucket === 'needs_attention') prs = prs.filter(needsAttention);
      if (prs.length === 0) return `No pull requests (bucket: ${bucket}).`;
      return prs.map(prLine).join('\n');
    },
  },
  {
    name: 'talyn_get_pull_request',
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    description:
      "Get a single PR's status and context: title, author, branches, mergeable state, review decision, blocking reason, checks breakdown, unresolved review threads, and merge-queue / auto-keep flags. Does not include the diff (use talyn_get_pull_request_diff) or full review threads (use talyn_get_pull_request_reviews).",
    inputSchema: {
      type: 'object',
      properties: { pull_request_id: { type: 'string', description: 'Talyn PR id.' } },
      required: ['pull_request_id'],
    },
    handler: async (ownerId, args) => {
      const id = requireId(args, 'pull_request_id');
      const { row } = await callApi<{ row: PublicPr }>(ownerId, 'GET', `/pull-requests/${id}`);
      const s: PrSummary = row.summary;
      const c = s.checks;
      const lines = [
        `${row.id}  ${row.owner}/${row.repo}#${row.number}  [${row.state}]  "${s.title}" by ${s.author}`,
        `branches: ${s.headBranch} → ${s.baseBranch}`,
        `mergeable: ${s.mergeable} (${s.blockingReason})   review: ${s.effectiveReviewDecision ?? s.reviewDecision ?? 'none'}`,
        `checks: ${c.passed} passed / ${c.failed} failed / ${c.inProgress} in-progress / ${c.skipped} skipped / ${c.total} total`,
        `unresolved review threads: ${s.unresolvedReviewThreads}`,
        `auto-keep-mergeable: ${row.autoKeepMergeable}   merge-queued: ${row.mergeQueued}${row.mergeQueue ? ` (${row.mergeQueue.status}, position ${row.mergeQueue.position}${row.mergeQueue.reason ? `, ${row.mergeQueue.reason}` : ''})` : ''}   merge-method: ${row.mergeMethod}`,
        row.taskId ? `linked task: ${row.taskId}` : 'no linked task',
        s.url,
      ];
      if (s.ciStatus) lines.push(`CI: ${s.ciStatus}`);
      for (const gate of s.humanGates ?? [])
        lines.push(
          `human gate: ${gate.id} ${gate.label} — ${gate.name}${gate.url ? ` ${gate.url}` : ''}`
        );
      if (row.mergeQueue?.blockedCode) lines.push(`queue blocker: ${row.mergeQueue.blockedCode}`);
      if (row.mergeQueue?.external)
        lines.push(`external queue: ${row.mergeQueue.external.state ?? 'submitted'}`);
      return lines.join('\n');
    },
  },
  {
    name: 'talyn_get_pull_request_diff',
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    description:
      'List the changed files in a PR with per-file +/- stats. By default returns only the file list; set include_patch to also return the unified diff (optionally scoped to a single path).',
    inputSchema: {
      type: 'object',
      properties: {
        pull_request_id: { type: 'string' },
        include_patch: {
          type: 'boolean',
          description: 'Include the unified-diff patch text. Default false.',
        },
        path: { type: 'string', description: 'Limit the patch to this file path.' },
      },
      required: ['pull_request_id'],
    },
    handler: async (ownerId, args) => {
      const id = requireId(args, 'pull_request_id');
      const includePatch = args.include_patch === true;
      const only = str(args.path);
      type FileEntry = {
        filename: string;
        status: string;
        additions: number;
        deletions: number;
        patch?: string;
      };
      let files = await callApi<FileEntry[]>(ownerId, 'GET', `/pull-requests/${id}/files`);
      if (only) files = files.filter((f) => f.filename === only);
      if (files.length === 0) return only ? `No file matching ${only}.` : 'No changed files.';
      return files
        .map((f) => {
          const head = `${f.filename}  ${f.status}  +${f.additions}/-${f.deletions}`;
          if (includePatch && f.patch) return `${head}\n${f.patch}`;
          return head;
        })
        .join('\n');
    },
  },
  {
    name: 'talyn_get_pull_request_reviews',
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    description:
      'Get the review context an agent needs to respond: submitted reviews (with verdict + body), inline review threads grouped by file/line (with the comment body), and top-level conversation comments. Defaults to unresolved threads only.',
    inputSchema: {
      type: 'object',
      properties: {
        pull_request_id: { type: 'string' },
        unresolved_only: {
          type: 'boolean',
          description: 'Only unresolved inline threads. Default true.',
        },
      },
      required: ['pull_request_id'],
    },
    handler: async (ownerId, args) => {
      const id = requireId(args, 'pull_request_id');
      const unresolvedOnly = args.unresolved_only !== false;
      type Review = { author: string; state: string; body: string };
      type ThreadComment = { author: string; body: string };
      type Thread = {
        isResolved: boolean;
        path: string | null;
        line: number | null;
        comments: ThreadComment[];
      };
      type Conv = { author: string; body: string };
      const detail = await callApi<{ reviews: Review[]; threads: Thread[]; comments: Conv[] }>(
        ownerId,
        'GET',
        `/pull-requests/${id}/reviews`
      );
      const out: string[] = [];

      const reviews = detail.reviews.filter((r) => r.body || r.state !== 'COMMENTED');
      if (reviews.length) {
        out.push('## Reviews');
        for (const r of reviews)
          out.push(`- ${r.author} ${r.state}${r.body ? `: ${trim(r.body)}` : ''}`);
      }

      const threads = detail.threads.filter((t) => (unresolvedOnly ? !t.isResolved : true));
      if (threads.length) {
        out.push('## Inline threads');
        for (const t of threads) {
          const loc = t.path ? `${t.path}${t.line != null ? `:${t.line}` : ''}` : '(general)';
          const first = t.comments[0];
          out.push(
            `- ${loc}${t.isResolved ? ' (resolved)' : ''} — ${first ? `${first.author}: ${trim(first.body)}` : ''}`
          );
          for (const c of t.comments.slice(1)) out.push(`    ↳ ${c.author}: ${trim(c.body)}`);
        }
      }

      if (detail.comments.length) {
        out.push('## Comments');
        for (const c of detail.comments) out.push(`- ${c.author}: ${trim(c.body)}`);
      }

      return out.length ? out.join('\n') : 'No reviews, threads, or comments.';
    },
  },
  {
    name: 'talyn_refresh_pull_request',
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    description:
      'Force a fresh fetch of a PR from GitHub (bypassing the cache) and return its updated summary line.',
    inputSchema: {
      type: 'object',
      properties: { pull_request_id: { type: 'string' } },
      required: ['pull_request_id'],
    },
    handler: async (ownerId, args) => {
      const id = requireId(args, 'pull_request_id');
      const pr = await callApi<PublicPr>(ownerId, 'POST', `/pull-requests/${id}/refresh`);
      return prLine(pr);
    },
  },
  {
    name: 'talyn_set_auto_keep_mergeable',
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    description:
      'Enable or disable "auto keep mergeable" on a PR. When enabled, Talyn repeatedly fires a cloud fix run whenever the PR develops a blocker (conflicts, failing checks) so it stays mergeable.',
    inputSchema: {
      type: 'object',
      properties: {
        pull_request_id: { type: 'string' },
        enabled: { type: 'boolean' },
      },
      required: ['pull_request_id', 'enabled'],
    },
    handler: async (ownerId, args) => {
      const id = requireId(args, 'pull_request_id');
      const enabled = args.enabled === true;
      await callApi<null>(ownerId, 'POST', `/pull-requests/${id}/auto-keep-mergeable`, { enabled });
      return `Auto-keep-mergeable ${enabled ? 'enabled' : 'disabled'} for PR ${id}.`;
    },
  },
  {
    name: 'talyn_set_merge_queue',
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    description:
      'Add a PR to (or remove it from) the Talyn merge queue. Queued PRs are merged automatically — serialized per base branch — as soon as they are clean, with cloud fix runs fired on conflict/behind/blocked.',
    inputSchema: {
      type: 'object',
      properties: {
        pull_request_id: { type: 'string' },
        enabled: { type: 'boolean' },
        method: {
          type: 'string',
          enum: ['merge', 'squash', 'rebase'],
          description: 'Merge method when its turn comes. Default keeps the current.',
        },
      },
      required: ['pull_request_id', 'enabled'],
    },
    handler: async (ownerId, args) => {
      const id = requireId(args, 'pull_request_id');
      const enabled = args.enabled === true;
      const method = str(args.method);
      await callApi<null>(ownerId, 'POST', `/pull-requests/${id}/merge-queue`, {
        enabled,
        ...(method ? { method } : {}),
      });
      return `Merge queue ${enabled ? 'enabled' : 'disabled'}${method ? ` (method: ${method})` : ''} for PR ${id}.`;
    },
  },
  {
    name: 'talyn_merge_pull_request',
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    description:
      'Merge a PR now (merge | squash | rebase). Fails if GitHub reports the PR is not mergeable.',
    inputSchema: {
      type: 'object',
      properties: {
        pull_request_id: { type: 'string' },
        method: {
          type: 'string',
          enum: ['merge', 'squash', 'rebase'],
          description: 'Default squash.',
        },
      },
      required: ['pull_request_id'],
    },
    handler: async (ownerId, args) => {
      const id = requireId(args, 'pull_request_id');
      const method = str(args.method);
      const result = await callApi<{ merged: boolean; submitted?: boolean; message?: string }>(
        ownerId,
        'POST',
        `/pull-requests/${id}/merge`,
        method ? { method } : {}
      );
      if (result.submitted)
        return `Submitted PR ${id} to the repository's merge queue; it merges when the queue lands it.`;
      return result.merged
        ? `Merged PR ${id}.`
        : `Not merged: ${result.message ?? 'unknown reason'}`;
    },
  },
  {
    name: 'talyn_fix_pull_request',
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    description:
      "Start the standard Talyn \"get this PR mergeable\" cloud run — the exact action behind the app's fix button. Using Talyn's standard prompt and the workspace's configured provider, the agent resolves reviewer comments, gets CI green, and cleanly merges the base branch, then opens/updates the PR. Takes only the PR id — no instructions needed (use talyn_create_task for freeform work).",
    inputSchema: {
      type: 'object',
      properties: {
        pull_request_id: { type: 'string' },
        model: { type: 'string', description: 'Optional model id override (provider-specific).' },
      },
      required: ['pull_request_id'],
    },
    handler: async (ownerId, args) => {
      const id = requireId(args, 'pull_request_id');
      const model = str(args.model);
      const task = await callApi<Task>(
        ownerId,
        'POST',
        `/pull-requests/${id}/fix`,
        model ? { model } : {}
      );
      return `Started "${task.title}" — task ${task.id} (${task.status}).`;
    },
  },
];

PULLREQUESTS.push(
  defineTool(
    'get_pull_request_description',
    'Get the cached PR description.',
    prSchema,
    ['pull_request_id'],
    { readOnlyHint: true },
    async (ownerId, args) => {
      const result = await callApi<{ body: string | null }>(
        ownerId,
        'GET',
        `/pull-requests/${requireId(args, 'pull_request_id')}/description`
      );
      return result.body ?? 'Description is not cached. Refresh the PR first.';
    }
  ),
  defineTool(
    'track_pull_request',
    'Track a GitHub PR by URL. Set add_repository to also watch its repository.',
    { ...workspaceSchema, url: textSchema, add_repository: booleanSchema },
    ['url'],
    { openWorldHint: true },
    async (ownerId, args) => {
      const workspaceId = await resolveWorkspace(ownerId, args);
      try {
        return prLine(
          await callApi<PublicPr>(ownerId, 'POST', '/pull-requests/watch', {
            workspaceId,
            url: requireId(args, 'url'),
            confirmAddRepo: bool(args, 'add_repository', false),
          })
        );
      } catch (error) {
        if (
          error instanceof McpApiError &&
          error.status === 409 &&
          error.code === 'repo_not_watched'
        ) {
          return `${error.message}\nCall talyn_track_pull_request again with add_repository: true to add the repository and track this PR.`;
        }
        throw error;
      }
    }
  ),
  defineTool(
    'untrack_pull_request',
    'Stop tracking a PR. Its queue entry and auto-keep setting remain active.',
    prSchema,
    ['pull_request_id'],
    { destructiveHint: true },
    async (ownerId, args) => {
      const id = requireId(args, 'pull_request_id');
      await callApi(ownerId, 'POST', `/pull-requests/${id}/watch`, { enabled: false });
      return `${id} no longer watched.`;
    }
  ),
  defineTool(
    'set_review_hidden',
    'Hide or restore a PR in the review list.',
    { ...prSchema, hidden: booleanSchema },
    ['pull_request_id', 'hidden'],
    { idempotentHint: true },
    async (ownerId, args) => {
      const id = requireId(args, 'pull_request_id');
      await callApi(ownerId, 'POST', `/pull-requests/${id}/review-hidden`, {
        hidden: bool(args, 'hidden'),
      });
      return `${id} review ${args.hidden ? 'hidden' : 'visible'}.`;
    }
  )
);
