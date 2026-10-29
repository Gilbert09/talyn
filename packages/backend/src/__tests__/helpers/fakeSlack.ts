/**
 * A stand-in for the Slack Web API: replaces `globalThis.fetch` for
 * `https://slack.com/api/*`, records every call, and answers from per-method
 * handlers. Anything else goes to the real fetch.
 */

export interface SlackCall {
  method: string;
  form: Record<string, string>;
  token: string | null;
}

export type SlackHandler = (form: Record<string, string>) => Record<string, unknown> | Promise<Record<string, unknown>>;

export class FakeSlack {
  calls: SlackCall[] = [];
  handlers: Record<string, SlackHandler> = {};
  private realFetch: typeof fetch | null = null;

  install(): this {
    this.realFetch = globalThis.fetch;
    const real = this.realFetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (!url.startsWith('https://slack.com/api/')) return real(input, init);
      const method = url.slice('https://slack.com/api/'.length);
      const form = Object.fromEntries(new URLSearchParams(String(init?.body ?? '')));
      const auth = new Headers(init?.headers).get('authorization');
      this.calls.push({ method, form, token: auth ? auth.replace(/^Bearer /, '') : null });
      const handler = this.handlers[method];
      const body = handler ? await handler(form) : { ok: true };
      return Response.json(body);
    }) as typeof fetch;
    return this;
  }

  uninstall(): void {
    if (this.realFetch) globalThis.fetch = this.realFetch;
    this.realFetch = null;
  }

  /** Calls to one method, in order. */
  of(method: string): SlackCall[] {
    return this.calls.filter((c) => c.method === method);
  }

  /** `reactions.add:eyes`, `reactions.remove:eyes`, … in order. */
  reactionLog(): string[] {
    return this.calls
      .filter((c) => c.method === 'reactions.add' || c.method === 'reactions.remove')
      .map((c) => `${c.method.slice('reactions.'.length)}:${c.form.name}@${c.form.timestamp}`);
  }
}
