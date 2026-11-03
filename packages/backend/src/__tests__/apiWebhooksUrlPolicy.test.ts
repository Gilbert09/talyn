import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertWebhookUrlAllowed,
  expandIpv6,
  isBlockedAddress,
  parseWebhookUrl,
  resolveAllowedAddresses,
  setWebhookDnsResolverForTests,
  WebhookUrlError,
  type WebhookUrlPolicy,
} from '../services/apiWebhooks/urlPolicy.js';
import { postWebhook } from '../services/apiWebhooks/worker.js';

const STRICT: WebhookUrlPolicy = { allowLoopback: false };
const DEV: WebhookUrlPolicy = { allowLoopback: true };

afterEach(() => setWebhookDnsResolverForTests(null));

describe('webhook URL policy: addresses', () => {
  it.each([
    // IPv4 that must never be reached
    ['0.0.0.0', true],
    ['10.1.2.3', true],
    ['100.64.0.1', true], // CGNAT
    ['100.127.255.255', true],
    ['127.0.0.1', true],
    ['127.255.255.254', true],
    ['169.254.169.254', true], // cloud metadata
    ['172.16.0.1', true],
    ['172.31.255.255', true],
    ['192.0.0.170', true],
    ['192.0.2.1', true],
    ['192.168.1.1', true],
    ['198.18.0.1', true],
    ['224.0.0.1', true],
    ['255.255.255.255', true],
    // IPv4 on the internet
    ['8.8.8.8', false],
    ['1.1.1.1', false],
    ['100.63.255.255', false], // just below CGNAT
    ['100.128.0.0', false], // just above CGNAT
    ['172.15.255.255', false],
    ['172.32.0.0', false],
    ['192.169.0.1', false],
    // IPv6 that must never be reached
    ['::', true],
    ['::1', true],
    ['::ffff:127.0.0.1', true], // IPv4-mapped loopback
    ['::ffff:a9fe:a9fe', true], // IPv4-mapped 169.254.169.254, hex form
    ['::ffff:10.0.0.1', true],
    ['::127.0.0.1', true], // deprecated IPv4-compatible
    ['64:ff9b::a9fe:a9fe', true], // NAT64 of the metadata address
    ['2002:a9fe:a9fe::1', true], // 6to4 of the metadata address
    ['fc00::1', true],
    ['fd00:ec2::254', true], // AWS IPv6 metadata
    ['fe80::1', true],
    ['fe80::1%eth0', true],
    ['fec0::1', true],
    ['ff02::1', true],
    ['2001:db8::1', true],
    ['2001::1', true], // Teredo
    ['100::1', true],
    // IPv6 on the internet
    ['2606:4700:4700::1111', false],
    ['2001:4860:4860::8888', false],
    ['::ffff:8.8.8.8', false],
    ['64:ff9b::808:808', false], // NAT64 of 8.8.8.8
    ['2002:808:808::1', false], // 6to4 of 8.8.8.8
    // Not an address at all
    ['example.com', true],
    ['', true],
  ])('%s blocked: %s', (address, blocked) => {
    expect(isBlockedAddress(address)).toBe(blocked);
  });

  it.each([
    ['::', [0, 0, 0, 0, 0, 0, 0, 0]],
    ['::1', [0, 0, 0, 0, 0, 0, 0, 1]],
    ['1::', [1, 0, 0, 0, 0, 0, 0, 0]],
    ['::ffff:1.2.3.4', [0, 0, 0, 0, 0, 0xffff, 0x0102, 0x0304]],
    ['2001:db8:0:0:0:0:2:1', [0x2001, 0xdb8, 0, 0, 0, 0, 2, 1]],
  ])('expands %s', (ip, groups) => {
    expect(expandIpv6(ip)).toEqual(groups);
  });

  it.each(['1:2:3:4:5:6:7:8:9', '1::2::3', 'g::1', '::1.2.3'])('refuses the malformed IPv6 %s', (ip) => {
    expect(expandIpv6(ip)).toBeNull();
  });
});

describe('webhook URL policy: URLs', () => {
  it.each([
    ['https://example.com/hook', STRICT],
    ['https://example.com:8443/hook?x=1', STRICT],
    ['https://8.8.8.8/hook', STRICT],
    ['https://[2606:4700:4700::1111]/hook', STRICT],
    ['http://localhost:3000/hook', DEV],
    ['http://127.0.0.1:3000/hook', DEV],
    ['http://[::1]:3000/hook', DEV],
    ['https://localhost/hook', DEV],
  ])('accepts %s', (url, policy) => {
    expect(parseWebhookUrl(url, policy)).toBeInstanceOf(URL);
  });

  it.each([
    ['not a url', STRICT, 'not valid'],
    ['http://example.com/hook', STRICT, 'https'],
    ['ftp://example.com/hook', STRICT, 'https'],
    ['http://localhost:3000/hook', STRICT, 'https'],
    ['https://localhost/hook', STRICT, 'localhost'],
    ['https://api.localhost/hook', STRICT, 'localhost'],
    ['https://127.0.0.1/hook', STRICT, 'private'],
    ['https://0x7f.1/hook', STRICT, 'private'], // the URL parser normalises it to 127.0.0.1
    ['https://2130706433/hook', STRICT, 'private'], // decimal 127.0.0.1
    ['https://10.0.0.5/hook', STRICT, 'private'],
    ['https://169.254.169.254/latest/meta-data', STRICT, 'private'],
    ['https://[::1]/hook', STRICT, 'private'],
    ['https://[::ffff:169.254.169.254]/hook', STRICT, 'private'],
    ['https://[fd00:ec2::254]/hook', STRICT, 'private'],
    ['https://user:pass@example.com/hook', STRICT, 'user name'],
    ['https://example.com/hook#frag', STRICT, 'fragment'],
    ['http://10.0.0.5/hook', DEV, 'https'],
    [`https://example.com/${'a'.repeat(2048)}`, STRICT, 'longer'],
  ])('refuses %s', (url, policy, message) => {
    expect(() => parseWebhookUrl(url, policy)).toThrow(WebhookUrlError);
    expect(() => parseWebhookUrl(url, policy)).toThrow(new RegExp(message));
  });

  it.each([
    ['a public answer', [{ address: '93.184.216.34', family: 4 }], null],
    ['a private answer', [{ address: '10.0.0.1', family: 4 }], 'private'],
    ['one public and one private answer', [{ address: '93.184.216.34', family: 4 }, { address: '192.168.0.1', family: 4 }], 'private'],
    ['the metadata address', [{ address: '169.254.169.254', family: 4 }], 'private'],
    ['an IPv4-mapped loopback', [{ address: '::ffff:127.0.0.1', family: 6 }], 'private'],
    ['no answer', [], 'does not resolve'],
  ])('checks DNS at create time: %s', async (_name, answer, message) => {
    setWebhookDnsResolverForTests(async () => answer);
    const check = assertWebhookUrlAllowed('https://hooks.example.com/x', STRICT);
    if (message) await expect(check).rejects.toThrow(new RegExp(message));
    else await expect(check).resolves.toBeInstanceOf(URL);
  });

  it('refuses a name that does not resolve', async () => {
    setWebhookDnsResolverForTests(async () => {
      throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
    });
    await expect(assertWebhookUrlAllowed('https://nope.invalid/x', STRICT)).rejects.toThrow(/does not resolve/);
  });

  it('lets localhost resolve to loopback only when loopback is allowed', async () => {
    setWebhookDnsResolverForTests(async () => [{ address: '127.0.0.1', family: 4 }]);
    await expect(resolveAllowedAddresses('localhost', DEV)).resolves.toHaveLength(1);
    setWebhookDnsResolverForTests(async () => [{ address: '10.0.0.1', family: 4 }]);
    await expect(resolveAllowedAddresses('localhost', DEV)).rejects.toThrow(/private/);
  });
});

describe('webhook URL policy: at delivery time', () => {
  let server: http.Server | null = null;
  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  });

  async function listen(handler: http.RequestListener): Promise<number> {
    server = http.createServer(handler);
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    return (server.address() as AddressInfo).port;
  }

  it('connects only to the address the lookup checked: a name rebound to loopback is refused', async () => {
    let hits = 0;
    const port = await listen((_req, res) => {
      hits += 1;
      res.end('ok');
    });
    // Allowed at create time (public), then the name answers loopback at delivery.
    setWebhookDnsResolverForTests(async () => [{ address: '127.0.0.1', family: 4 }]);
    await expect(
      postWebhook(`https://rebind.example.com:${port}/hook`, '{}', {}, { policy: STRICT, timeoutMs: 2000 }),
    ).rejects.toThrow(/private, loopback or reserved/);
    expect(hits).toBe(0);
  });

  it('connects to a name through the checked lookup when the address is allowed', async () => {
    const port = await listen((_req, res) => res.writeHead(204).end());
    setWebhookDnsResolverForTests(async (host) => (host === 'localhost' ? [{ address: '127.0.0.1', family: 4 }] : []));
    const result = await postWebhook(`http://localhost:${port}/hook`, '{}', {}, { policy: DEV, timeoutMs: 2000 });
    expect(result.status).toBe(204);
  });

  it('refuses an IP-literal private URL before connecting', async () => {
    await expect(postWebhook('https://10.0.0.1/hook', '{}', {}, { policy: STRICT })).rejects.toThrow(WebhookUrlError);
  });

  it('does not follow a redirect', async () => {
    let redirectedHits = 0;
    const port = await listen((req, res) => {
      if (req.url === '/next') {
        redirectedHits += 1;
        res.end('ok');
        return;
      }
      res.writeHead(302, { location: '/next' });
      res.end();
    });
    const result = await postWebhook(`http://127.0.0.1:${port}/hook`, '{}', {}, { policy: DEV });
    expect(result.status).toBe(302);
    expect(redirectedHits).toBe(0);
  });

  it('gives up after the timeout', async () => {
    const port = await listen(() => {
      // Never answers.
    });
    await expect(postWebhook(`http://127.0.0.1:${port}/hook`, '{}', {}, { policy: DEV, timeoutMs: 200 })).rejects.toThrow(
      /No response within/,
    );
    server?.closeAllConnections();
  });
});
