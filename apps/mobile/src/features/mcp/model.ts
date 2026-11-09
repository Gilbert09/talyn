import {
  MCP_AUTH_KINDS,
  MCP_CATALOG,
  emptyMcpServerInput,
  mcpServerFromAddress,
  mcpServerInputProblem,
  mcpServerToInput,
  type McpAuthDiscovery,
  type McpAuthMethod,
  type McpCatalogEntry,
  type McpProbeResult,
  type McpServerDefinition,
  type McpServerInput,
  type PrivateRoute,
} from '@talyn/shared';

import type { Tone } from '../../components/UI';

/** The method names web shows, word for word. */
export const AUTH_LABELS: Record<McpAuthMethod, string> = {
  oauth: 'Sign in with OAuth',
  none: 'No key needed',
  bearer: 'API key (Bearer)',
  header: 'API key in a header',
  basic: 'Username and password',
  query: 'API key in the URL',
};

/** Every method, in web's order, for manual setup. */
export const MANUAL_METHODS: readonly McpAuthMethod[] = ['oauth', ...MCP_AUTH_KINDS];

export const SLACK_ORIGIN = 'https://mcp.slack.com';
/** Web waits this long after the last keystroke before it asks the server how to sign in. */
export const DISCOVERY_DELAY_MS = 450;
/** Web's sign-in poll: every 2 seconds, for at most 10 minutes. */
export const SIGN_IN_POLL_MS = 2000;
export const SIGN_IN_MAX_MS = 10 * 60 * 1000;

export function parsesAsUrl(value: string): boolean {
  try {
    new URL(value.trim());
    return true;
  } catch {
    return false;
  }
}

/** The host of an address, or `invalid`. Never the whole URL. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return 'invalid';
  }
}

/** Why the address alone cannot connect, from the shared validator, or null. */
export function addressProblem(url: string, routes: readonly PrivateRoute[] = []): string | null {
  return mcpServerInputProblem({ name: 'discovery', url, authKind: 'none', enabled: true }, routes);
}

/** The reason shown under the address. Quiet until the text parses as a URL, so "htt" is not an error. */
export function addressHint(url: string, routes: readonly PrivateRoute[] = []): string | null {
  const problem = addressProblem(url, routes);
  return problem && parsesAsUrl(url) ? problem : null;
}

export function isSlackAddress(url: string): boolean {
  try {
    return new URL(url).origin === SLACK_ORIGIN;
  } catch {
    return false;
  }
}

/** The identifier as the person types it: lowercase, and spaces or underscores become hyphens. */
export function identifierFromTyping(text: string): string {
  return text.toLowerCase().replace(/[\s_]+/g, '-');
}

/** The editor's first input: the saved server, the catalog prefill, or an empty one. */
export function initialEditorInput(
  editing: McpServerDefinition | null,
  initial: McpServerInput | undefined,
  existingNames: readonly string[],
): McpServerInput {
  if (editing) return mcpServerToInput(editing);
  const next = initial ?? emptyMcpServerInput();
  return next.url && existingNames.includes(next.name)
    ? { ...next, name: mcpServerFromAddress(next.url, existingNames).name }
    : next;
}

/** What a change of address resets: a new name from the host, no secret, and the default method. */
export function addressEdit(url: string, existingNames: readonly string[]): Partial<McpServerInput> {
  let defaults: Partial<McpServerInput> = { name: '', displayName: undefined, description: undefined, catalogHandle: undefined };
  try {
    defaults = mcpServerFromAddress(url, existingNames);
  } catch {
    // An incomplete address stays editable.
  }
  return { ...defaults, url, secret: '', inject: defaults.inject, authKind: defaults.authKind ?? 'bearer' };
}

/** The input change for a chosen method. OAuth stores as `bearer` until the grant replaces it. */
export function methodEdit(next: McpAuthMethod, discovery: McpAuthDiscovery | null): Partial<McpServerInput> {
  return { authKind: next === 'oauth' ? 'bearer' : next, secret: '', inject: next === 'header' ? discovery?.inject : undefined };
}

/**
 * The method after discovery answers. A saved server at the same address
 * keeps its own method, so a stored key is never swapped for OAuth.
 */
export function discoveredMethod(
  result: McpAuthDiscovery,
  existing: McpServerDefinition | null,
  url: string,
): { method: McpAuthMethod; patch?: Partial<McpServerInput> } | null {
  const keep = existing?.url === url && Boolean(existing.hasSecret || existing.oauth);
  const next = keep && existing ? (existing.oauth ? 'oauth' : existing.authKind) : result.methods[0];
  if (!next) return null;
  if (keep) return { method: next };
  return { method: next, patch: { authKind: next === 'oauth' ? 'bearer' : next, inject: next === 'header' ? result.inject : undefined } };
}

/** True when a key is stored for this address and method, and the person has not cleared it. */
export function credentialStored(editing: McpServerDefinition | null, input: McpServerInput): boolean {
  return Boolean(editing && editing.url === input.url && editing.authKind === input.authKind && editing.hasSecret && input.secret !== '');
}

export function availableMethods(method: McpAuthMethod, discovery: McpAuthDiscovery | null): McpAuthMethod[] {
  return Array.from(new Set([method, ...(discovery?.methods ?? [])]));
}

// ---------------------------------------------------------------------------
// Allow-lists. null = all, [] = none, a list = exactly those. Never collapse them.
// ---------------------------------------------------------------------------

export type AccessScope = 'all' | 'none' | 'subset';

export function accessScope(list: readonly string[] | null | undefined): AccessScope {
  if (list === null || list === undefined) return 'all';
  return list.length === 0 ? 'none' : 'subset';
}

/** "Only selected repositories" starts with every repository ticked, like web. */
export function onlySelectedRepositories(repositories: ReadonlyArray<{ id: string }>): string[] {
  return repositories.map((repository) => repository.id);
}

/** Tick or untick one id. The result is always a list, even when it is empty. */
export function toggleId(list: readonly string[], id: string): string[] {
  return list.includes(id) ? list.filter((item) => item !== id) : [...list, id];
}

/** The tools to draw: what the server offers plus any allowed name it no longer offers, sorted. */
export function toolNames(offered: readonly string[], allowed: readonly string[] | null | undefined): string[] {
  return Array.from(new Set([...offered, ...(allowed ?? [])])).sort();
}

/** The tools that are on. "All" shows every offered tool as on. */
export function selectedTools(allowed: readonly string[] | null | undefined, offered: readonly string[]): string[] {
  return [...(allowed ?? offered)];
}

/** Turn one tool on or off. Leaving "All" gives an exact list without that tool. */
export function toggleTool(allowed: readonly string[] | null | undefined, offered: readonly string[], name: string): string[] {
  const selected = selectedTools(allowed, offered);
  return selected.includes(name) ? selected.filter((item) => item !== name) : [...selected, name];
}

/** The "All tools" switch. Off ticks every tool offered now, so nothing changes until a tool is unticked. */
export function allToolsChange(checked: boolean, offered: readonly string[]): string[] | null {
  return checked ? null : [...offered];
}

/** Markdown in a tool description, as plain text for one line. */
export function plainText(markdown: string): string {
  return markdown
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|\*|_|`)(.+?)\1/g, '$2')
    .replace(/^#+\s*/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function toolRow(name: string, offered: readonly string[], metadata: McpProbeResult['tools']): { label: string; detail: string } {
  const tool = metadata?.find((item) => item.name === name);
  const description = tool?.description ? plainText(tool.description) : '';
  return {
    label: tool?.title || name,
    detail: description || (offered.includes(name) ? 'No description provided.' : 'Not offered by the server now.'),
  };
}

/** A short count for the closed picker row. */
export function scopeSummary(list: readonly string[] | null | undefined, total: number, noun: string): string {
  const scope = accessScope(list);
  if (scope === 'all') return `All ${noun}`;
  return `${list?.length ?? 0} of ${total}`;
}

/**
 * The request body. `tools` and `repositoryIds` keep their three states:
 * absent or null is sent as null, [] as [], a list as a copy. `secret` is
 * sent only when it is set, because omitting it keeps the stored key.
 */
export function mcpRequest(input: McpServerInput): McpServerInput {
  const body: McpServerInput = {
    name: input.name,
    displayName: input.displayName,
    url: input.url,
    description: input.description,
    catalogHandle: input.catalogHandle,
    authKind: input.authKind,
    inject: input.inject,
    tools: input.tools === undefined || input.tools === null ? null : [...input.tools],
    repositoryIds: input.repositoryIds === undefined || input.repositoryIds === null ? null : [...input.repositoryIds],
    enabled: input.enabled,
  };
  if (input.secret !== undefined) body.secret = input.secret;
  return body;
}

/** Whether two editor inputs would send the same request. */
export function sameRequest(a: McpServerInput, b: McpServerInput): boolean {
  return JSON.stringify(mcpRequest(a)) === JSON.stringify(mcpRequest(b));
}

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

export interface ServerStatus { label: string; tone: Tone; detail?: string }

/** One line of state for a row: the grant first, then the last connection check. */
export function serverStatus(server: Pick<McpServerDefinition, 'oauth' | 'lastProbe'>): ServerStatus | null {
  if (server.oauth?.status === 'needs_reauth') return { label: 'Sign in again', tone: 'warning', detail: server.oauth.detail };
  if (server.oauth?.status === 'pending') return { label: 'Needs sign-in', tone: 'warning' };
  const probe = server.lastProbe;
  if (!probe) return null;
  return probe.ok ? { label: 'Connected', tone: 'success' } : { label: probe.detail ?? 'Could not connect', tone: 'destructive' };
}

/** The connection check's sentence, as web's banner says it. */
export function probeSummary(probe: McpProbeResult): string {
  const head = probe.ok
    ? `Connected to ${probe.serverName ?? 'the server'}${probe.toolNames
      ? `, which offers ${probe.toolNames.length} tool${probe.toolNames.length === 1 ? '' : 's'}` : ''}.`
    : 'Could not connect.';
  return probe.detail ? `${head} ${probe.detail}` : head;
}

export function catalogMatches(query: string, catalog: readonly McpCatalogEntry[] = MCP_CATALOG): McpCatalogEntry[] {
  const search = query.trim().toLowerCase();
  return catalog.filter((entry) => `${entry.title} ${entry.summary} ${entry.handle}`.toLowerCase().includes(search));
}

export function connectedHandles(servers: ReadonlyArray<Pick<McpServerDefinition, 'catalogHandle'>>): Set<string> {
  return new Set(servers.map((server) => server.catalogHandle).filter((handle): handle is string => Boolean(handle)));
}

/** The other servers' names, which a new identifier must not reuse. */
export function otherNames(servers: ReadonlyArray<Pick<McpServerDefinition, 'id' | 'name'>>, id: string | null | undefined): string[] {
  return servers.filter((server) => server.id !== id).map((server) => server.name);
}

/** A server's catalog logo, by handle or by an https host match, like web. */
export function catalogLogo(url: string | null | undefined, handle: string | null | undefined, catalog: readonly McpCatalogEntry[] = MCP_CATALOG): string | null {
  let entry = catalog.find((item) => item.handle === handle);
  if (!entry && url) {
    try {
      const address = new URL(url);
      if (address.protocol === 'https:') entry = catalog.find((item) => new URL(item.url).hostname === address.hostname);
    } catch {
      // An invalid address uses the generic icon.
    }
  }
  return entry?.logo ?? null;
}

export function signedInLine(account: { name?: string; email?: string } | null): string {
  const parts = [account?.name, account?.email].filter(Boolean);
  return parts.length > 0 ? `Signed in as ${parts.join(' · ')}` : 'Signed in.';
}

/** An older backend refuses the app's return link. The flow then runs without it. */
export function isInvalidReturnTo(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { status, code } = error as { status?: unknown; code?: unknown };
  return status === 400 && code === 'invalid_return_to';
}
