// MCP tool servers — the vocabulary, the validator and the catalog.
//
// A workspace connects the tool servers it wants and every Talyn Fleet run
// wakes up with their tools wired in. The fleet takes them INLINE on sandbox
// create, and the guest is configured with a plain `http://` address on its own
// gateway carrying no token at all: the host attaches the credential per
// request. An agent that reads a hostile repository and decides to exfiltrate
// the Linear key has nothing to find.
//
// The validator here deliberately MIRRORS the fleet's own refusals. Every rule
// below is enforced again on dispatch, by a different implementation, in Go —
// so the point of restating them is not safety, it is that somebody hears
// "an MCP url needs a path" while they are typing it rather than as a task that
// failed an hour later with a message nobody can act on.

/** How the credential is attached, host-side. The fleet's own vocabulary
 *  rather than a second one, because it is passed straight through. */
export type McpAuthKind = 'none' | 'bearer' | 'header' | 'basic' | 'query';

export const MCP_AUTH_KINDS: readonly McpAuthKind[] = [
  'none',
  'bearer',
  'header',
  'basic',
  'query',
] as const;

/** The details `authKind` needs. Empty for `none` and `bearer`, which is what
 *  nearly every remote MCP server in the wild wants. */
export interface McpInjection {
  /** `header`: the header name. */
  header?: string;
  /** `header`: what goes in front of the secret, e.g. `Token `. */
  prefix?: string;
  /** `basic`: the username; the secret is the password. */
  user?: string;
  /** `query`: the parameter name. Avoid — a secret in a URL lands in logs. */
  param?: string;
  /** Fixed headers carrying NO secret — a vendor's required API-version header.
   *  Set before the credential, so a bad entry cannot displace it. */
  extra?: Record<string, string>;
}

/** The grant behind an OAuth-connected server. Never the tokens themselves —
 *  those are encrypted at rest and this is the shape that reaches a client. */
export interface McpOAuthGrant {
  status: 'pending' | 'connected' | 'needs_reauth';
  /** The last refusal IN THE VENDOR'S WORDS. "the refresh token has been
   *  revoked" and "this client is no longer registered" are the same status and
   *  different problems. */
  detail?: string;
  issuer?: string;
  /** What was GRANTED, which is narrower than what was asked whenever somebody
   *  unticked a box. */
  scopes?: string[];
  /** Reported because it travels in an authorize URL a browser visits and is
   *  therefore already public. The client SECRET never appears anywhere. */
  clientId?: string;
  /** `cimd` for a hosted client-metadata document, `dcr` for a dynamically
   *  registered client, `byo` for one somebody entered themselves. */
  clientSource?: 'cimd' | 'dcr' | 'byo';
  /** When the ACCESS token dies and a refresh is due. */
  expiresAt?: string;
  checkedAt?: string;
}

/** What an `initialize` + `tools/list` probe found. Never a credential —
 *  several vendors put the submitted key in an error envelope, so only the
 *  server's own name, its protocol version and a refusal's text are kept. */
export interface McpProbeResult {
  ok: boolean;
  at: string;
  status?: number;
  serverName?: string;
  protocolVersion?: string;
  /** Names only. Descriptions are the agent's business, not the picker's. */
  toolNames?: string[];
  detail?: string;
}

/** A server as it is stored and served. There is no `secret` field and there
 *  will not be one: a type with somewhere to put a credential is a place for
 *  somebody to put one. */
export interface McpServerDefinition {
  id: string;
  workspaceId: string;
  name: string;
  displayName?: string | null;
  url: string;
  description?: string | null;
  catalogHandle?: string | null;
  authKind: McpAuthKind;
  inject?: McpInjection | null;
  /** Whether a credential is stored. Never what it is. */
  hasSecret: boolean;
  oauth?: McpOAuthGrant | null;
  /** null = every tool the server advertises, [] = none, [...] = exactly these.
   *  The three are distinct and nothing may collapse them. */
  tools?: string[] | null;
  enabled: boolean;
  lastProbe?: McpProbeResult | null;
  createdAt: string;
  updatedAt: string;
}

/** The write shape. `secret` is write-only and appears in no response. */
export interface McpServerInput {
  name: string;
  displayName?: string;
  url: string;
  description?: string;
  catalogHandle?: string;
  authKind: McpAuthKind;
  inject?: McpInjection;
  /** Omit on an edit to keep the stored credential; send an empty string to
   *  clear it. The same rule the fleet's own PUT follows. */
  secret?: string;
  tools?: string[] | null;
  enabled: boolean;
}

/** Normalised and ready to store. */
export interface NormalizedMcpServer {
  name: string;
  displayName: string | null;
  url: string;
  description: string | null;
  catalogHandle: string | null;
  authKind: McpAuthKind;
  inject: McpInjection | null;
  secret: string | undefined;
  tools: string[] | null;
  enabled: boolean;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** The name becomes the first label of a hostname inside the sandbox, so it
 *  carries the fleet's integration-name charset. One rule, learned once. */
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** The charset the fleet's runner enforces on a tool name. Restated so an
 *  allow-list entry that could never match anything is refused while somebody
 *  is looking at it. */
const TOOL_NAME_RE = /^[A-Za-z0-9_-]+$/;

/** `github` is the box's own GitHub REST API. Taking that name would silently
 *  remove it, and nothing downstream would say so. */
const RESERVED_NAMES = new Set(['github']);

/**
 * An HTTP field name, per RFC 7230's `token` production.
 *
 * Wider than letters-digits-hyphen on purpose: underscores are legal and real
 * vendors use them — Context7 documents its key header as `CONTEXT7_API_KEY`,
 * and a stricter rule made its own catalog entry unsaveable.
 */
const HEADER_NAME_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

/** Hosts the fleet refuses as an upstream. A sandbox has no routed egress, so
 *  one of these is not "restricted", it is unreachable — and 169.254.169.254 is
 *  a cloud metadata endpoint, which is the reason the rule exists at all. */
function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true;
  if (h === '::1' || h === '0:0:0:0:0:0:0:1') return true;
  // Unique-local and link-local IPv6.
  if (/^f[cd][0-9a-f]{2}:/.test(h) || /^fe[89ab][0-9a-f]:/.test(h)) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!v4) return false;
  const [a, b] = [Number(v4[1]), Number(v4[2])];
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

function fail(message: string): never {
  throw new Error(message);
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * Validate and normalise one server, throwing a message a person can act on.
 *
 * Hand-rolled rather than zod, matching `validateLoop` and `validateWorkflow`:
 * the thrown string is what the route returns as its 400 and what the editor
 * shows under the field, so it has to read like a sentence somebody wrote.
 */
export function validateMcpServer(raw: unknown): NormalizedMcpServer {
  if (typeof raw !== 'object' || raw === null) fail('an MCP server needs a body');
  const o = raw as Record<string, unknown>;

  // Lower-cased rather than refused. The name is a DNS label, so lowercase is
  // the only legal form and "Linear" has exactly one sensible reading; the
  // human spelling survives on `displayName`, which is what the UI shows.
  const name = str(o.name).toLowerCase();
  if (!name) fail('a tool server needs a name');
  if (!NAME_RE.test(name)) {
    fail(
      `"${name}" cannot be a tool server name: it becomes a hostname inside the sandbox, so it ` +
        'may use only lowercase letters, digits and hyphens, and must start with a letter or digit',
    );
  }
  if (name.endsWith('-')) fail(`"${name}" cannot end with a hyphen`);
  if (RESERVED_NAMES.has(name)) {
    fail(`"${name}" is reserved: that name is the sandbox's own GitHub API, and taking it would remove it`);
  }

  const rawUrl = str(o.url);
  if (!rawUrl) fail('a tool server needs a URL');
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    fail(`"${rawUrl}" is not a URL`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    fail(`"${rawUrl}" must be an https:// address`);
  }
  if (url.username || url.password) {
    fail('put the credential in the key field rather than in the URL');
  }
  if (url.hash) fail('a tool server URL may not carry a #fragment');
  if (isPrivateHost(url.hostname)) {
    fail(
      `a sandbox cannot reach ${url.hostname}: it has no route to your machine or to a private ` +
        'network, only to the servers it is given through the credential proxy',
    );
  }
  // The query string is refused because the fleet splits the URL into an
  // upstream and a path and stores neither with a query. Said plainly, because
  // several vendors document a `?read_only=true` form and somebody will paste
  // one.
  if (url.search) {
    fail(
      `"${rawUrl}" may not carry a query string. If the vendor offers options that way, they are ` +
        'not supported yet — use the path-based variant if there is one',
    );
  }

  const authKind = (str(o.authKind) || 'none') as McpAuthKind;
  if (!MCP_AUTH_KINDS.includes(authKind)) {
    fail(`"${authKind}" is not a way of attaching a credential`);
  }

  const secretRaw = o.secret;
  if (secretRaw !== undefined && typeof secretRaw !== 'string') {
    fail('the key must be text');
  }
  const secret = secretRaw === undefined ? undefined : (secretRaw as string);

  const inject = normaliseInjection(o.inject, authKind);

  let tools: string[] | null = null;
  if (o.tools !== undefined && o.tools !== null) {
    if (!Array.isArray(o.tools)) fail('the allowed tools must be a list');
    const seen = new Set<string>();
    tools = [];
    for (const t of o.tools) {
      const name2 = str(t);
      if (!name2 || !TOOL_NAME_RE.test(name2)) {
        fail(`"${String(t)}" is not a tool name: they use letters, digits, underscores and hyphens`);
      }
      if (seen.has(name2)) continue;
      seen.add(name2);
      tools.push(name2);
    }
  }

  return {
    name,
    displayName: str(o.displayName).slice(0, 120) || null,
    // NORMALISED, not echoed, and the trailing slash is load-bearing.
    //
    // The fleet refuses a URL with no path at all — a paste that lost its
    // /mcp — but accepts an explicit root, because some servers really do
    // answer there (Stripe's is `https://mcp.stripe.com/`; every /mcp spelling
    // 404s). Go can tell `https://host` from `https://host/`; the WHATWG parser
    // used here normalises both to "/" and cannot. So we send the form the
    // fleet accepts and let the Test button be what says whether anything
    // answers — a two-second answer beats a guess about what somebody meant.
    url: url.pathname === '/' && !rawUrl.endsWith('/') ? `${rawUrl}/` : rawUrl,
    description: str(o.description).slice(0, 200) || null,
    catalogHandle: str(o.catalogHandle) || null,
    authKind,
    inject,
    secret,
    tools,
    enabled: o.enabled === undefined ? true : o.enabled === true,
  };
}

function normaliseInjection(raw: unknown, kind: McpAuthKind): McpInjection | null {
  const o = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const out: McpInjection = {};
  if (kind === 'header') {
    out.header = str(o.header);
    if (!out.header) fail('a header credential needs the header name');
    if (!HEADER_NAME_RE.test(out.header)) fail(`"${out.header}" is not a header name`);
    const prefix = str(o.prefix);
    if (prefix) out.prefix = prefix;
  }
  if (kind === 'basic') {
    out.user = str(o.user);
    if (!out.user) fail('a username-and-password credential needs the username');
  }
  if (kind === 'query') {
    out.param = str(o.param);
    if (!out.param) fail('a query-parameter credential needs the parameter name');
  }
  const extra = typeof o.extra === 'object' && o.extra !== null ? (o.extra as Record<string, unknown>) : null;
  if (extra) {
    const pairs: Record<string, string> = {};
    for (const [k, v] of Object.entries(extra)) {
      if (!HEADER_NAME_RE.test(k)) fail(`"${k}" is not a header name`);
      pairs[k] = String(v);
    }
    if (Object.keys(pairs).length > 0) out.extra = pairs;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * The same validation, as a message or null, for a Save button.
 *
 * Runs the real validator rather than a second approximation of it, so a
 * disabled button and a server 400 cannot disagree — the mistake `loopInputProblem`
 * exists to avoid.
 */
export function mcpServerInputProblem(input: McpServerInput): string | null {
  try {
    validateMcpServer(input);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : 'this tool server is not valid';
  }
}

// ---------------------------------------------------------------------------
// The catalog
// ---------------------------------------------------------------------------

/**
 * One vendor in the one-click catalog.
 *
 * Data, not a switch — the same shape `LOOP_SCHEDULE_PRESETS` has. The fleet
 * deliberately has no catalog of its own ("an MCP endpoint is one URL, and a
 * table of vendors would be a second thing to keep current"), which is exactly
 * right for it and leaves the job here, where somebody is choosing.
 *
 * `notes` is the valuable part. Each one costs an afternoon to discover and ten
 * seconds to read.
 */
export interface McpCatalogEntry {
  handle: string;
  /**
   * The server name to create, when it cannot just be the handle.
   *
   * It becomes a hostname label in the sandbox and the `mcp_<name>_<tool>`
   * prefix on every tool, and the fleet reserves `github` for the sandbox's own
   * GitHub REST API — so the GitHub entry needs a name its handle cannot be.
   */
  name?: string;
  title: string;
  summary: string;
  url: string;
  authKind: McpAuthKind;
  /** What the user has to paste, in the vendor's own words. Absent when the
   *  server needs no credential at all. */
  credentialLabel?: string;
  /** True when the server authenticates by signing in rather than by a pasted
   *  key. Until the OAuth broker ships these are shown and refused, rather than
   *  hidden — somebody looking for Linear should find out why it is not there
   *  yet, not conclude Talyn has never heard of it. */
  oauth?: boolean;
  inject?: McpInjection;
  notes?: string;
}

export const MCP_CATALOG: readonly McpCatalogEntry[] = [
  {
    handle: 'context7',
    title: 'Context7',
    summary: 'Up-to-date library and framework documentation.',
    url: 'https://mcp.context7.com/mcp',
    authKind: 'header',
    credentialLabel: 'Context7 API key',
    inject: { header: 'CONTEXT7_API_KEY' },
    notes:
      'Works with no key at a lower rate limit, so it is the cheapest way to check that tool ' +
      'servers are reaching the sandbox at all. Read-only.',
  },
  {
    handle: 'github',
    // Not "github": the sandbox already reaches its own GitHub REST API under
    // that name, and taking it would silently remove a capability the agent's
    // briefing promises.
    name: 'github-mcp',
    title: 'GitHub',
    summary: 'Issues, pull requests and code search across your repositories.',
    url: 'https://api.githubcopilot.com/mcp/',
    authKind: 'bearer',
    credentialLabel: 'GitHub personal access token',
    notes:
      'Connected as "github-mcp", because "github" is the sandbox\'s own GitHub API. GitHub also ' +
      'serves read-only and per-toolset variants at /mcp/readonly and /mcp/x/{toolset}, which ' +
      'cost fewer tokens than filtering tools here does.',
  },
  {
    handle: 'supabase',
    title: 'Supabase',
    summary: 'Query your database, inspect schemas and read logs.',
    url: 'https://mcp.supabase.com/mcp',
    authKind: 'bearer',
    credentialLabel: 'Supabase personal access token',
    notes:
      'The project and read-only options are query parameters, which a tool server URL may not ' +
      'carry here. Use a token scoped to the project you mean.',
  },
  {
    handle: 'stripe',
    title: 'Stripe',
    summary: 'Customers, payments, subscriptions and the Stripe docs.',
    url: 'https://mcp.stripe.com/',
    authKind: 'bearer',
    credentialLabel: 'Stripe restricted key (rk_…)',
    notes:
      'Use a RESTRICTED key, not a secret one. Sensitive writes still need a human to confirm ' +
      'them through a Stripe URL, which an agent in a sandbox cannot do.',
  },
  {
    handle: 'posthog',
    title: 'PostHog',
    summary: 'Insights, feature flags, error tracking and HogQL.',
    url: 'https://mcp.posthog.com/mcp',
    authKind: 'bearer',
    credentialLabel: 'PostHog personal API key',
    notes: 'Routes to your region automatically.',
  },
  {
    handle: 'huggingface',
    title: 'Hugging Face',
    summary: 'Models, datasets, papers and Spaces.',
    url: 'https://huggingface.co/mcp',
    authKind: 'bearer',
    credentialLabel: 'Hugging Face access token',
    notes: 'Which tools it offers is configured on your Hugging Face settings page, not here.',
  },
  {
    handle: 'exa',
    title: 'Exa',
    summary: 'Neural web search built for agents.',
    url: 'https://mcp.exa.ai/mcp',
    authKind: 'bearer',
    credentialLabel: 'Exa API key',
    notes: 'Read-only. Exa also documents a ?exaApiKey= form — avoid it; a key in a URL lands in logs.',
  },
  {
    handle: 'firecrawl',
    title: 'Firecrawl',
    summary: 'Scrape and crawl web pages into clean markdown.',
    url: 'https://mcp.firecrawl.dev/v2/mcp',
    authKind: 'bearer',
    credentialLabel: 'Firecrawl API key',
  },
  // OAuth servers. Listed and refused rather than hidden — see McpCatalogEntry.
  {
    handle: 'linear',
    title: 'Linear',
    summary: 'Issues, projects and cycles.',
    url: 'https://mcp.linear.app/mcp',
    authKind: 'bearer',
    oauth: true,
    credentialLabel: 'Linear API key',
    notes: 'Also accepts a personal API key, which works today without signing in.',
  },
  {
    handle: 'sentry',
    title: 'Sentry',
    summary: 'Issues, events and release health.',
    url: 'https://mcp.sentry.dev/mcp',
    authKind: 'bearer',
    oauth: true,
  },
  {
    handle: 'notion',
    title: 'Notion',
    summary: 'Pages, databases and search.',
    url: 'https://mcp.notion.com/mcp',
    authKind: 'bearer',
    oauth: true,
    notes: 'Sign-in only — Notion offers no key you can paste.',
  },
  {
    handle: 'atlassian',
    title: 'Jira and Confluence',
    summary: "Atlassian's Rovo server: issues, pages and search.",
    url: 'https://mcp.atlassian.com/v2/mcp',
    authKind: 'bearer',
    oauth: true,
  },
  {
    handle: 'asana',
    title: 'Asana',
    summary: 'Tasks, projects and portfolios.',
    url: 'https://mcp.asana.com/v2/mcp',
    authKind: 'bearer',
    oauth: true,
  },
  {
    handle: 'vercel',
    title: 'Vercel',
    summary: 'Projects, deployments and logs.',
    url: 'https://mcp.vercel.com',
    authKind: 'bearer',
    oauth: true,
    notes: 'Vercel approves clients individually, so this may be refused until Talyn is on that list.',
  },
  {
    handle: 'neon',
    title: 'Neon',
    summary: 'Postgres branches, queries and migrations.',
    url: 'https://mcp.neon.tech/mcp',
    authKind: 'bearer',
    oauth: true,
    credentialLabel: 'Neon API key',
  },
  {
    handle: 'cloudflare-docs',
    title: 'Cloudflare docs',
    summary: "Search Cloudflare's documentation. No account needed.",
    url: 'https://docs.mcp.cloudflare.com/mcp',
    authKind: 'none',
    notes: 'Needs no credential at all, so it is a good second smoke test after Context7.',
  },
] as const;

export function mcpCatalogEntry(handle: string): McpCatalogEntry | undefined {
  return MCP_CATALOG.find((e) => e.handle === handle);
}

// ---------------------------------------------------------------------------
// Editor helpers
// ---------------------------------------------------------------------------

/**
 * Whether to DRAW the tool-servers surface.
 *
 * Three-state, like `loopsOffered`: null means the features call has not
 * answered yet, and drawing nothing is right — a nav item that appears and then
 * vanishes is worse than one that arrives a moment late.
 */
export function mcpServersOffered(features: { mcpServers?: boolean } | null): boolean {
  return features?.mcpServers === true;
}

export function emptyMcpServerInput(): McpServerInput {
  return { name: '', url: '', authKind: 'bearer', enabled: true, tools: null };
}

export function mcpServerToInput(s: McpServerDefinition): McpServerInput {
  return {
    name: s.name,
    displayName: s.displayName ?? undefined,
    url: s.url,
    description: s.description ?? undefined,
    catalogHandle: s.catalogHandle ?? undefined,
    authKind: s.authKind,
    inject: s.inject ?? undefined,
    // Deliberately absent: the stored credential is kept unless the user types
    // a new one, and prefilling a masked placeholder would make "clear it" and
    // "leave it alone" the same gesture.
    tools: s.tools ?? null,
    enabled: s.enabled,
  };
}

export function mcpServerFromCatalog(entry: McpCatalogEntry): McpServerInput {
  return {
    name: entry.name ?? entry.handle,
    displayName: entry.title,
    url: entry.url,
    description: entry.summary,
    catalogHandle: entry.handle,
    authKind: entry.authKind,
    inject: entry.inject,
    tools: null,
    enabled: true,
  };
}
