/**
 * A fake of PostHog's signals reports API for the PostHog Inbox tests: the
 * list, the single read, the artefacts and the claim
 * (`POST .../signals/reports/:id/claim/`). It records every request and
 * every claim body, and can refuse reads or claims with a status.
 *
 * A read shows the active claim as `assignee`, like PostHog. The list keeps
 * the `status` it is asked for (`ready` by default). With `filterList`, it
 * also applies the backlog's filters (actionability, priority, source
 * product, scout, search, `created_after`).
 */

export interface FakeReport {
  id: string;
  title: string;
  summary: string;
  status: string;
  priority: string | null;
  actionability: string | null;
  already_addressed: boolean | null;
  suppression_source: string | null;
  signal_count: number;
  source_products: string[];
  scout_name: string | null;
  repo_slug: string | null;
  updated_at: string;
  created_at?: string;
  /** Set to override the assignee the active claim gives. */
  assignee?: { claim_id?: string | null; kind?: string | null } | null;
  implementation_pr_url?: string | null;
  implementation_pr_state?: string | null;
}

/** One claim on a report, as PostHog keeps it. */
export interface FakeClaim {
  claimId: string;
  /** `talyn` for the caller, anything else for another person or agent. */
  holder: string;
  pullRequests: string[];
  released: boolean;
}

export interface ClaimCall {
  reportId: string;
  body: { claim_id?: string; pull_requests?: string[]; release?: boolean };
}

export class FakePostHog {
  reports = new Map<string, FakeReport>();
  reviewers = new Map<string, string[]>();
  /** The active claim of each report. A released claim is kept with `released`. */
  claims = new Map<string, FakeClaim>();
  requests: string[] = [];
  claimCalls: ClaimCall[] = [];
  /** Refuse every request with this status. */
  status = 200;
  /** Refuse claim calls with these statuses, one per call, then answer normally. */
  claimFailures: number[] = [];
  /** `Retry-After` seconds on a refused claim. */
  claimRetryAfter: number | null = null;
  /** Answer a claim with no `assignee.claim_id`. */
  omitClaimId = false;
  /** Show the active claim as `assignee` on reads and list rows. */
  exposeClaims = true;
  /** Apply the backlog's list filters, not only `status`. */
  filterList = false;
  /** Keep `repo_slug` on list rows (a newer PostHog). */
  listRepoSlug = false;
  /** Refuse single reads of these report ids with a status. */
  readFailures = new Map<string, number>();
  private nextClaim = 1;

  put(id: string, overrides: Partial<FakeReport> = {}): FakeReport {
    const report: FakeReport = {
      id,
      title: `Report ${id}`,
      summary: `Something breaks in ${id}.`,
      status: 'ready',
      priority: 'P1',
      actionability: 'immediately_actionable',
      already_addressed: false,
      suppression_source: null,
      signal_count: 3,
      source_products: ['error_tracking'],
      scout_name: null,
      repo_slug: 'acme/web-app',
      updated_at: '2026-11-14T00:00:00.000001Z',
      ...overrides,
    };
    this.reports.set(id, report);
    return report;
  }

  /** Somebody else claims the report. */
  claimByOther(reportId: string, holder = 'someone-else'): FakeClaim {
    const claim: FakeClaim = { claimId: `other-${this.nextClaim++}`, holder, pullRequests: [], released: false };
    this.claims.set(reportId, claim);
    return claim;
  }

  /** The active claim's id, or null. */
  activeClaim(reportId: string): FakeClaim | null {
    const claim = this.claims.get(reportId);
    return claim && !claim.released ? claim : null;
  }

  handle(url: URL, init?: RequestInit): Response {
    const method = (init?.method ?? 'GET').toUpperCase();
    this.requests.push(`${method === 'GET' ? '' : `${method} `}${url.pathname}${url.search}`);
    if (this.status !== 200) return new Response('{}', { status: this.status });
    const claimMatch = /^\/api\/projects\/2\/signals\/reports\/([^/]+)\/claim\/$/.exec(url.pathname);
    if (claimMatch && method === 'POST') return this.claim(claimMatch[1], init);
    const m = /^\/api\/projects\/2\/signals\/reports\/(?:([^/]+)\/(artefacts\/)?)?$/.exec(url.pathname);
    if (!m) return new Response('{}', { status: 404 });
    const [, id, artefacts] = m;
    if (id && artefacts) {
      const logins = this.reviewers.get(id);
      return Response.json({
        results: logins ? [{ id: 'a1', type: 'suggested_reviewers', content: logins.map((github_login) => ({ github_login })) }] : [],
      });
    }
    if (id) {
      const failure = this.readFailures.get(id);
      if (failure) return new Response('{}', { status: failure });
      const report = this.reports.get(id);
      return report ? Response.json(this.served(report)) : new Response('{}', { status: 404 });
    }
    // The list: newest change first (or newest created with `-created_at`),
    // without `repo_slug` unless `listRepoSlug`.
    const q = url.searchParams;
    const offset = Number(q.get('offset') ?? 0);
    const limit = Number(q.get('limit') ?? 100);
    const unclaimed = q.get('unclaimed') === 'true';
    const statuses = (q.get('status') ?? 'ready').split(',');
    const anyOf = (param: string): string[] | null => {
      const raw = q.get(param);
      return raw ? raw.split(',').map((v) => v.toLowerCase()) : null;
    };
    const keep = (r: FakeReport): boolean => {
      if (!this.filterList) return true;
      const actionability = anyOf('actionability');
      if (actionability && !actionability.includes((r.actionability ?? '').toLowerCase())) return false;
      const priority = anyOf('priority');
      if (priority && !priority.includes((r.priority ?? '').toLowerCase())) return false;
      const products = anyOf('source_product');
      if (products && !r.source_products.some((p) => products.includes(p.toLowerCase()))) return false;
      const scouts = anyOf('scout');
      if (scouts && !scouts.includes((r.scout_name ?? '').toLowerCase())) return false;
      const search = (q.get('search') ?? '').toLowerCase();
      if (search && !`${r.title}\n${r.summary}`.toLowerCase().includes(search)) return false;
      const after = q.get('created_after');
      if (after && r.created_at && Date.parse(r.created_at) < Date.parse(after)) return false;
      return true;
    };
    const byCreated = q.get('ordering') === '-created_at';
    const rows = [...this.reports.values()]
      .filter((r) => statuses.includes(r.status))
      .filter((r) => !unclaimed || !this.activeClaim(r.id))
      .filter(keep)
      .sort((a, b) =>
        byCreated ? (b.created_at ?? '').localeCompare(a.created_at ?? '') : b.updated_at.localeCompare(a.updated_at)
      )
      .map((r) => this.served(r))
      .map((r) => {
        if (this.listRepoSlug) return r;
        const { repo_slug: _repo, ...rest } = r;
        return rest;
      });
    const page = rows.slice(offset, offset + limit);
    const next = offset + limit < rows.length ? `${url.origin}${url.pathname}?offset=${offset + limit}` : null;
    return Response.json({ count: rows.length, next, results: page });
  }

  /** The report as PostHog serves it: the active claim as its assignee. */
  private served(report: FakeReport): FakeReport {
    if (!this.exposeClaims || report.assignee !== undefined) return report;
    const claim = this.activeClaim(report.id);
    return {
      ...report,
      assignee: claim ? { claim_id: claim.claimId, kind: claim.holder === 'talyn' ? 'agent' : 'user' } : null,
      implementation_pr_url: report.implementation_pr_url ?? claim?.pullRequests[0] ?? null,
    };
  }

  /** PostHog's claim semantics, as its OpenAPI describes them. */
  private claim(reportId: string, init?: RequestInit): Response {
    const body = (init?.body ? JSON.parse(String(init.body)) : {}) as ClaimCall['body'];
    this.claimCalls.push({ reportId, body });
    const failure = this.claimFailures.shift();
    if (failure) {
      const headers = this.claimRetryAfter !== null ? { 'retry-after': String(this.claimRetryAfter) } : undefined;
      return new Response(JSON.stringify({ detail: `refused (${failure})` }), { status: failure, headers });
    }
    const report = this.reports.get(reportId);
    if (!report) return new Response('{}', { status: 404 });
    const active = this.activeClaim(reportId);
    const conflict = (detail: string) => new Response(JSON.stringify({ detail }), { status: 409 });

    if (body.claim_id) {
      // Resume, attach or release: only the active claim, and only its holder's.
      if (!active || active.claimId !== body.claim_id) return conflict('Stale claim.');
    } else if (active && active.holder !== 'talyn') {
      return conflict('Another actor holds this report.');
    }
    let claim = active;
    if (!claim) {
      claim = { claimId: `claim-${this.nextClaim++}`, holder: 'talyn', pullRequests: [], released: false };
      this.claims.set(reportId, claim);
    }
    for (const pr of body.pull_requests ?? []) if (!claim.pullRequests.includes(pr)) claim.pullRequests.push(pr);
    if (body.release) claim.released = true;
    return Response.json({
      id: reportId,
      assignee: claim.released || this.omitClaimId ? null : { claim_id: claim.claimId, kind: 'agent' },
      implementation_pr_url: claim.pullRequests[0] ?? null,
    });
  }
}
