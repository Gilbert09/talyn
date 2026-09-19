import { lookup } from 'node:dns';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { Agent } from 'undici';

const blocked = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  blocked.addSubnet(address, prefix, 'ipv4');
blocked.addSubnet('2001::', 23, 'ipv6');
blocked.addSubnet('2001:db8::', 32, 'ipv6');

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, 'ipv4');
  return family === 6 && /^[23]/.test(address) && !blocked.check(address, 'ipv6');
}

// Check the addresses used by the connection to prevent DNS rebinding.
export const lookupPublicAddress: LookupFunction = (hostname, options, callback) => {
  lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
    if (error) return callback(error, '', 4);
    if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
      return callback(new Error('The server address must be public.'), '', 4);
    }
    if (options.all) callback(null, addresses);
    else callback(null, addresses[0].address, addresses[0].family);
  });
};

const dispatcher = new Agent({ connect: { lookup: lookupPublicAddress } });

export function publicHttpsUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) return null;
    if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local'))
      return null;
    if (isIP(hostname) && !isPublicAddress(hostname)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export async function mcpFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const safe = publicHttpsUrl(url);
  if (!safe) throw new Error('Use a public HTTPS server address.');
  // Do not follow redirects to unchecked hosts or send credentials to another endpoint.
  return fetch(safe, { ...init, redirect: 'error', dispatcher } as RequestInit);
}

export async function readMcpBody(
  response: Response,
  limit: number,
  complete?: (text: string) => boolean
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      bytes += value.byteLength;
      if (bytes > limit) throw new Error('The server response is too large.');
      text += decoder.decode(value, { stream: true });
      if (complete?.(text)) return text;
    }
  } finally {
    await reader.cancel();
  }
}
