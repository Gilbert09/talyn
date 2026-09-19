import { describe, expect, it, vi } from 'vitest';
import { lookupPublicAddress } from '../services/mcpServers/http.js';
const lookup = vi.hoisted(() => vi.fn());
vi.mock('node:dns', () => ({ lookup }));

describe('MCP connection DNS lookup', () => {
  it.each([
    [{ address: '127.0.0.1', family: 4 }],
    [
      { address: '8.8.8.8', family: 4 },
      { address: '10.0.0.1', family: 4 },
    ],
    [{ address: '::ffff:169.254.169.254', family: 6 }],
    [],
  ])('rejects private or empty DNS results: %j', (...addresses) => {
    lookup.mockImplementation((_hostname, _options, callback) => callback(null, addresses));
    const callback = vi.fn();
    lookupPublicAddress('public.example.com', { all: true }, callback);
    expect(callback).toHaveBeenCalledWith(expect.any(Error), '', 4);
  });
  it.each([true, false])('uses the checked addresses when all=%s', (all) => {
    const addresses = [{ address: '8.8.8.8', family: 4 }];
    lookup.mockImplementation((_hostname, _options, callback) => callback(null, addresses));
    const callback = vi.fn();
    lookupPublicAddress('public.example.com', { all }, callback);
    if (all) expect(callback).toHaveBeenCalledWith(null, addresses);
    else expect(callback).toHaveBeenCalledWith(null, '8.8.8.8', 4);
  });
});
