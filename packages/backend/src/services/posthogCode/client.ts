import type { PostHogCodeRuntimeAdapter } from '@fastowl/shared';
import type { AcpLogEntry } from './acpConverter.js';
import { debugBus } from '../debugBus.js';

/**
 * Default model for PostHog Code runs. The API requires a model on every
 * cloud run (the `run/` endpoint 400s with `model is required when selecting
 * a cloud runtime` otherwise), so this is the fallback whenever the task /
 * env / UI didn't pin one. Kept current with the latest Opus.
 */
export const DEFAULT_POSTHOG_CODE_MODEL = 'claude-opus-4-8';

/**
 * Thin typed wrapper over the PostHog Code (tasks) REST API.
 *
 * Auth is a personal API key sent as `Authorization: Bearer …`. Every
 * call is scoped to a project (team) id and a host (us/eu cloud or a
 * self-hosted instance). See https://posthog.com/docs/api/tasks and
 * .../task-runs for the underlying endpoints.
 *
 * This client is intentionally stateless — credentials are passed in by
 * the caller (resolved per-workspace) rather than held on a singleton.
 */
export class PostHogCodeClient {
  constructor(
    private readonly apiKey: string,
    private readonly projectId: string,
    private readonly host: string,
  ) {}

  /** Create a task. Returns the new task's id. */
  async createTask(input: {
    title: string;
    description: string;
    repository: string;
  }): Promise<PostHogTask> {
    return this.request<PostHogTask>('POST', `/tasks/`, {
      title: input.title,
      description: input.description,
      origin_product: 'user_created',
      repository: input.repository,
    });
  }

  /**
   * Kick off a background run for a task. The endpoint returns the parent
   * *task* (not the run) — the new run is on `task.latest_run`, and its
   * `latest_run.id` is the run id used by the logs/stream endpoints.
   */
  async startRun(
    taskId: string,
    input: { runtimeAdapter: PostHogCodeRuntimeAdapter; model: string },
  ): Promise<PostHogTask> {
    // `model` is required by the API for a cloud runtime — always send it.
    return this.request<PostHogTask>('POST', `/tasks/${taskId}/run/`, {
      mode: 'background',
      runtime_adapter: input.runtimeAdapter,
      model: input.model,
    });
  }

  /** Fetch a task, including its `latest_run` (status, branch, output, …). */
  async getTask(taskId: string): Promise<PostHogTask> {
    return this.request<PostHogTask>('GET', `/tasks/${taskId}/`);
  }

  /** Fetch a single run by id. */
  async getRun(taskId: string, runId: string): Promise<PostHogRun> {
    return this.request<PostHogRun>('GET', `/tasks/${taskId}/runs/${runId}/`);
  }

  /** Fetch a run's log text. Best-effort — shape varies, returned raw. */
  async getRunLogs(taskId: string, runId: string): Promise<unknown> {
    return this.request<unknown>('GET', `/tasks/${taskId}/runs/${runId}/logs/`);
  }

  /**
   * Cancel a run. PostHog has no dedicated cancel action — a PATCH to
   * `status: cancelled` is the cancellation path (it signals the Temporal
   * workflow and marks the run completed_at server-side).
   */
  async cancelRun(taskId: string, runId: string): Promise<PostHogRun> {
    return this.request<PostHogRun>('PATCH', `/tasks/${taskId}/runs/${runId}/`, {
      status: 'cancelled',
    });
  }

  /**
   * Fetch a run's parsed JSONL log entries from durable storage (S3).
   * Used as the backfill source for tasks whose live Redis stream is gone
   * (completed runs reopened later, or runs that finished while the
   * backend was down). `after` is an ISO timestamp to fetch only newer
   * entries. Returns the entries in order.
   */
  async getSessionLogs(
    taskId: string,
    runId: string,
    opts: { after?: string; limit?: number } = {},
  ): Promise<AcpLogEntry[]> {
    const qs = new URLSearchParams();
    if (opts.after) qs.set('after', opts.after);
    if (opts.limit) qs.set('limit', String(opts.limit));
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    const data = await this.request<unknown>(
      'GET',
      `/tasks/${taskId}/runs/${runId}/session_logs/${suffix}`,
    );
    return Array.isArray(data) ? (data as AcpLogEntry[]) : [];
  }

  /**
   * Open the live SSE stream for a run. Returns the raw `fetch` Response
   * whose body is the `text/event-stream`; the caller parses frames.
   * `lastEventId` resumes from a prior position (Redis stream id); omit
   * it to replay the run from the beginning, then tail live.
   */
  async openRunStream(
    taskId: string,
    runId: string,
    opts: { lastEventId?: string; signal?: AbortSignal } = {},
  ): Promise<Response> {
    const url = `${this.baseUrl}/tasks/${taskId}/runs/${runId}/stream/`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: 'text/event-stream',
    };
    if (opts.lastEventId) headers['Last-Event-ID'] = opts.lastEventId;
    const res = await fetch(url, { method: 'GET', headers, signal: opts.signal });
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      throw new Error(
        `PostHog Code stream open failed (${res.status}): ${text.slice(0, 300)}`,
      );
    }
    return res;
  }

  /** Cheap auth/connectivity probe. Throws on bad creds / unreachable host. */
  async ping(): Promise<void> {
    await this.request<unknown>('GET', `/tasks/?limit=1`);
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const startedAt = Date.now();
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      debugBus.recordHttp({
        service: 'posthog_code',
        method,
        url,
        durationMs: Date.now() - startedAt,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
    const text = await res.text();
    debugBus.recordHttp({
      service: 'posthog_code',
      method,
      url,
      status: res.status,
      durationMs: Date.now() - startedAt,
      ok: res.ok,
      bytes: text.length,
      ...(res.ok ? {} : { error: text.slice(0, 500) }),
    });
    if (!res.ok) {
      throw new Error(
        `PostHog Code ${method} ${path} failed (${res.status}): ${text.slice(0, 500)}`,
      );
    }
    return (text ? JSON.parse(text) : undefined) as T;
  }

  private get baseUrl(): string {
    const host = this.host.replace(/\/+$/, '');
    return `${host}/api/projects/${this.projectId}`;
  }
}

/**
 * Partial PostHog task shape — only the fields we read. The API returns
 * more; we stay permissive and ignore the rest.
 */
export interface PostHogTask {
  id: string;
  title?: string;
  repository?: string | null;
  latest_run?: PostHogRun | null;
  [k: string]: unknown;
}

export type PostHogRunStatus =
  | 'not_started'
  | 'queued'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface PostHogRun {
  id: string;
  status?: PostHogRunStatus;
  branch?: string | null;
  /** Free-form output the agent left behind (may contain the PR URL). */
  output?: unknown;
  state?: unknown;
  error_message?: string | null;
  log_url?: string | null;
  runtime_adapter?: string;
  model?: string;
  /** Bumps on real run-state progress; goes stale when the agent is idle. */
  updated_at?: string | null;
  completed_at?: string | null;
  [k: string]: unknown;
}
