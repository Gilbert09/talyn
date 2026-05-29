import type { PostHogCodeRuntimeAdapter } from '@fastowl/shared';

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

  /** Kick off a background run for a task. Returns the run id. */
  async startRun(
    taskId: string,
    input: { runtimeAdapter: PostHogCodeRuntimeAdapter; model: string },
  ): Promise<PostHogRun> {
    return this.request<PostHogRun>('POST', `/tasks/${taskId}/run/`, {
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
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
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
  completed_at?: string | null;
  [k: string]: unknown;
}
