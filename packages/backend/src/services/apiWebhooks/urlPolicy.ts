import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP, type LookupFunction } from 'node:net';

/**
 * Where a webhook may be sent. A webhook URL is a request the backend makes
 * on a stranger's behalf, so it must not reach our own network: no private,
 * loopback, link-local, CGNAT or cloud metadata address, in IPv4 or IPv6.
 *
 * Checked twice:
 *  - At create and update time, for a clear 400 (`parseWebhookUrl` and
 *    `assertWebhookUrlAllowed`).
 *  - At DELIVERY time, in the socket's own DNS lookup (`webhookLookup`). A
 *    name that resolved to a public address at create time can resolve to
 *    `169.254.169.254` later (DNS rebinding), so the address that is checked
 *    is the address that is connected to. Redirects are never followed.
 *
 * `http://localhost` is allowed only in development and test, where the
 * receiver is a local process.
 */

export class WebhookUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookUrlError';
  }
}

export interface WebhookUrlPolicy {
  /** Allow `localhost`, `127.0.0.1` and `[::1]`, over http or https. Development and test only. */
  allowLoopback: boolean;
}

export function defaultWebhookUrlPolicy(): WebhookUrlPolicy {
  const env = process.env.NODE_ENV;
  return { allowLoopback: env === 'development' || env === 'test' };
}

/** The longest URL accepted. Browsers and most servers stop at about 8 KB; 2 KB is far above any real receiver. */
export const MAX_WEBHOOK_URL_LENGTH = 2048;

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

/** `[::1]` → `::1`. */
function bareHost(url: URL): string {
  return url.hostname.replace(/^\[(.*)\]$/, '$1').toLowerCase();
}

function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host);
}

/** Syntax and literal-address rules. Throws `WebhookUrlError` with a sentence a person can act on. */
export function parseWebhookUrl(raw: string, policy: WebhookUrlPolicy = defaultWebhookUrlPolicy()): URL {
  if (raw.length > MAX_WEBHOOK_URL_LENGTH) throw new WebhookUrlError(`The URL is longer than ${MAX_WEBHOOK_URL_LENGTH} characters.`);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new WebhookUrlError('The URL is not valid.');
  }
  const host = bareHost(url);
  const loopbackOk = policy.allowLoopback && isLoopbackHost(host);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopbackOk)) {
    throw new WebhookUrlError('The URL must use https.');
  }
  if (url.username || url.password) throw new WebhookUrlError('The URL must not contain a user name or password.');
  if (url.hash) throw new WebhookUrlError('The URL must not contain a fragment (#).');
  if (!host) throw new WebhookUrlError('The URL has no host.');
  if (loopbackOk) return url;
  if (host === 'localhost' || host.endsWith('.localhost')) throw new WebhookUrlError('The URL must not point to localhost.');
  if (isIP(host) && isBlockedAddress(host)) {
    throw new WebhookUrlError('The URL points to a private, loopback or reserved address.');
  }
  return url;
}

export type DnsResolver = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

const systemResolver: DnsResolver = (hostname) => dnsLookup(hostname, { all: true, verbatim: true });
let resolver: DnsResolver = systemResolver;

/** Tests resolve names without the network. Null restores the system resolver. */
export function setWebhookDnsResolverForTests(fn: DnsResolver | null): void {
  resolver = fn ?? systemResolver;
}

/**
 * Resolve a host and refuse it when ANY address is blocked. One public and
 * one private answer is refused too: the connection could take either.
 */
export async function resolveAllowedAddresses(
  host: string,
  policy: WebhookUrlPolicy = defaultWebhookUrlPolicy(),
): Promise<Array<{ address: string; family: number }>> {
  const bare = host.replace(/^\[(.*)\]$/, '$1').toLowerCase();
  if (isIP(bare)) {
    if (isBlockedAddress(bare) && !(policy.allowLoopback && isLoopbackHost(bare))) {
      throw new WebhookUrlError('The URL points to a private, loopback or reserved address.');
    }
    return [{ address: bare, family: isIP(bare) }];
  }
  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await resolver(bare);
  } catch {
    throw new WebhookUrlError(`The host ${bare} does not resolve.`);
  }
  if (addresses.length === 0) throw new WebhookUrlError(`The host ${bare} does not resolve.`);
  const loopbackName = policy.allowLoopback && bare === 'localhost';
  for (const a of addresses) {
    if (!isBlockedAddress(a.address)) continue;
    if (loopbackName && isLoopbackAddress(a.address)) continue;
    throw new WebhookUrlError(`The host ${bare} resolves to a private, loopback or reserved address.`);
  }
  return addresses;
}

/** The full check at create and update time: syntax, then DNS. */
export async function assertWebhookUrlAllowed(raw: string, policy: WebhookUrlPolicy = defaultWebhookUrlPolicy()): Promise<URL> {
  const url = parseWebhookUrl(raw, policy);
  await resolveAllowedAddresses(url.hostname, policy);
  return url;
}

/**
 * The `lookup` for `http.request`: the delivery connects only to an address
 * this function has checked. Node skips `lookup` for an IP-literal host, so
 * the caller checks those with `parseWebhookUrl` first.
 */
export function webhookLookup(policy: WebhookUrlPolicy = defaultWebhookUrlPolicy()): LookupFunction {
  return (hostname, options, callback) => {
    resolveAllowedAddresses(hostname, policy).then(
      (addresses) => {
        const family = typeof options === 'object' && options ? options.family : undefined;
        const wanted = family === 4 || family === 6 ? addresses.filter((a) => a.family === family) : addresses;
        if (wanted.length === 0) {
          callback(Object.assign(new Error(`No IPv${family} address for ${hostname}.`), { code: 'ENOTFOUND' }), '', 0);
          return;
        }
        if (typeof options === 'object' && options?.all) {
          (callback as unknown as (err: null, addrs: Array<{ address: string; family: number }>) => void)(null, wanted);
        } else {
          callback(null, wanted[0].address, wanted[0].family);
        }
      },
      (err: Error) => callback(Object.assign(err, { code: 'EWEBHOOKBLOCKED' }), '', 0),
    );
  };
}

// ---------------------------------------------------------------------------
// Address classification
// ---------------------------------------------------------------------------

/** IPv4 ranges that are not the public internet. [base, prefix length]. */
const BLOCKED_V4: Array<[string, number]> = [
  ['0.0.0.0', 8], // "this" network
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, incl. 169.254.169.254 cloud metadata
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.88.99.0', 24], // 6to4 relay anycast
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, incl. 255.255.255.255
];

function v4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

function v4Blocked(n: number): boolean {
  for (const [base, bits] of BLOCKED_V4) {
    const b = v4ToInt(base) as number;
    const size = 2 ** (32 - bits);
    if (n >= b && n < b + size) return true;
  }
  return false;
}

/** Eight 16-bit groups, or null when it is not an IPv6 address. Accepts `::`, a zone id and a dotted IPv4 tail. */
export function expandIpv6(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  // A dotted IPv4 tail becomes two hex groups.
  const lastColon = s.lastIndexOf(':');
  if (s.slice(lastColon + 1).includes('.')) {
    const v4 = v4ToInt(s.slice(lastColon + 1));
    if (v4 === null) return null;
    s = `${s.slice(0, lastColon + 1)}${Math.floor(v4 / 65536).toString(16)}:${(v4 % 65536).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string) => (part === '' ? [] : part.split(':'));
  const head = parse(halves[0]);
  const rest = halves.length === 2 ? parse(halves[1]) : [];
  const groups = [...head, ...rest];
  for (const g of groups) if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
  if (halves.length === 1 && groups.length !== 8) return null;
  if (halves.length === 2 && groups.length > 7) return null;
  const zeros = halves.length === 2 ? 8 - groups.length : 0;
  return [...head.map((g) => parseInt(g, 16)), ...new Array<number>(zeros).fill(0), ...rest.map((g) => parseInt(g, 16))];
}

function embeddedV4(g: number[], at: number): number {
  return g[at] * 65536 + g[at + 1];
}

function v6Blocked(g: number[]): boolean {
  const zeroUntil = (n: number) => g.slice(0, n).every((x) => x === 0);
  // ::/96 holds ::, ::1 and the deprecated IPv4-compatible addresses.
  if (zeroUntil(6)) return true;
  // ::ffff:0:0/96, IPv4-mapped: the IPv4 rules decide.
  if (zeroUntil(5) && g[5] === 0xffff) return v4Blocked(embeddedV4(g, 6));
  // 64:ff9b::/96 (NAT64) and 64:ff9b:1::/48: the embedded IPv4 decides.
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return v4Blocked(embeddedV4(g, 6));
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1) return true;
  // 2002::/16 (6to4): the IPv4 in groups 1-2 decides.
  if (g[0] === 0x2002) return v4Blocked(embeddedV4(g, 1));
  if (g[0] === 0x0100 && g.slice(1, 4).every((x) => x === 0)) return true; // 100::/64 discard
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation
  if (g[0] === 0x2001 && g[1] < 0x0200) return true; // 2001::/23 IETF protocol assignments, incl. Teredo
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local, incl. fd00:ec2::254 metadata
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g[0] & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local
  if ((g[0] & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  return false;
}

/** True for every address a webhook must not reach. Not an IP at all is blocked too. */
export function isBlockedAddress(address: string): boolean {
  const bare = address.replace(/^\[(.*)\]$/, '$1');
  const family = isIP(bare.split('%')[0]);
  if (family === 4) return v4Blocked(v4ToInt(bare) as number);
  if (family === 6) {
    const groups = expandIpv6(bare);
    return groups ? v6Blocked(groups) : true;
  }
  return true;
}

function isLoopbackAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return address.startsWith('127.');
  if (family === 6) {
    const g = expandIpv6(address);
    if (!g) return false;
    if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true;
    return g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff && g[6] >> 8 === 127;
  }
  return false;
}
