/**
 * Preview host names, with no I/O: `<id>-<port>.<PREVIEW_BASE_DOMAIN>`. The id
 * is 128 random bits in hex. `originPolicy.ts` reads this too, so it must stay
 * free of database imports.
 */

const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const DOMAIN_PATTERN = new RegExp(`^(?:${LABEL}\\.)+${LABEL}(?::\\d{1,5})?$`);
const HOST_LABEL_PATTERN = /^([0-9a-f]{32})-(\d{4,5})$/;

let warnedDomain: string | undefined;

/**
 * The preview domain, or null when hosted previews are off. A host name with
 * an optional port (`preview.localhost:4747` for local work).
 */
export function previewBaseDomain(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.PREVIEW_BASE_DOMAIN?.trim().toLowerCase();
  if (!raw) return null;
  if (!DOMAIN_PATTERN.test(raw)) {
    if (warnedDomain !== raw) console.error(`[preview] PREVIEW_BASE_DOMAIN "${raw}" is not a host name; hosted previews are off.`);
    warnedDomain = raw;
    return null;
  }
  return raw;
}

export function previewLinksConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return previewBaseDomain(env) !== null;
}

/** http only for a `localhost` domain, which browsers treat as secure for cookies. */
export function previewOrigin(host: string): string {
  const hostname = host.replace(/:\d+$/, '');
  const local = hostname === 'localhost' || hostname.endsWith('.localhost');
  return `${local ? 'http' : 'https'}://${host}`;
}

export interface PreviewHostMatch { id: string; port: number; host: string }

/**
 * Which preview host a request's Host header names. Null means "not a preview
 * host": the request goes to the API as before. 'invalid' means it is under the
 * preview domain but names no host, and must not reach the API either. The
 * suffix match is exact: `x.preview.talyn.dev.evil.com` and
 * `evilpreview.talyn.dev` are not preview hosts.
 */
export function matchPreviewHost(hostHeader: string | undefined, domain: string | null): PreviewHostMatch | 'invalid' | null {
  if (!domain || !hostHeader) return null;
  let host = hostHeader.toLowerCase();
  // `x.preview.talyn.dev.` is the same name. Refuse it rather than serve the API there.
  const undotted = host.replace(/\.(:\d+)?$/, '$1');
  if (undotted !== host) return matchPreviewHost(undotted, domain) === null ? null : 'invalid';
  // Compare without a port when the domain has none, so a stray port cannot route a preview host to the API.
  if (!/:\d+$/.test(domain)) {
    const bare = host.replace(/:\d+$/, '');
    if (bare !== host && (bare === domain || bare.endsWith(`.${domain}`))) return 'invalid';
    host = bare;
  }
  if (host === domain) return 'invalid';
  const suffix = `.${domain}`;
  if (!host.endsWith(suffix)) return null;
  const match = HOST_LABEL_PATTERN.exec(host.slice(0, -suffix.length));
  if (!match) return 'invalid';
  const port = Number(match[2]);
  if (port < 1024 || port > 65535) return 'invalid';
  return { id: match[1], port, host };
}
