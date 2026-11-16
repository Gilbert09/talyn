/**
 * A fake of PostHog's signals reports API for the PostHog Inbox tests: the
 * list, the single read, the artefacts and the claim
 * (`POST .../signals/reports/:id/claim/`). It records every request and
 * every claim body, and can refuse reads or claims with a status.
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
      const report = this.reports.get(id);
      return report ? Response.json(report) : new Response('{}', { status: 404 });
    }
    // The list: newest change first, without `repo_slug`, like PostHog's.
    const offset = Number(url.searchParams.get('offset') ?? 0);
    const limit = Number(url.searchParams.get('limit') ?? 100);
    const unclaimed = url.searchParams.get('unclaimed') === 'true';
    const rows = [...this.reports.values()]
      .filter((r) => r.status === 'ready')
      .filter((r) => !unclaimed || !this.activeClaim(r.id))
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .map(({ repo_slug: _repo, ...rest }) => rest);
    return Response.json({ count: rows.length, results: rows.slice(offset, offset + limit) });
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
