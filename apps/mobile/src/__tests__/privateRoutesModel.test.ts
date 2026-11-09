import type { PrivateConnector, PrivatePeer } from '@talyn/shared';

import { addRoute, isDuplicateRoute, isPolling, mergeConnector, peerHosts, peerMatches, removeRoute, routeProblem } from '../features/privateRoutes/model';

const peer = (patch: Partial<PrivatePeer> = {}): PrivatePeer => ({ name: 'db', dnsName: 'db.tail.ts.net', addresses: ['100.1.1.1', '100.1.1.1'], os: 'linux', online: true, subnetRoutes: ['10.0.0.0/24'], ...patch });

describe('routeProblem', () => {
  it.each([
    ['', '5432', 'Enter one hostname or IP address.'],
    ['   ', '5432', 'Enter one hostname or IP address.'],
    ['a b', '5432', 'Enter one exact hostname or IP address.'],
    ['*.corp', '5432', 'Enter one exact hostname or IP address.'],
    ['a/b', '5432', 'Enter one exact hostname or IP address.'],
    ['http://x', '80', 'Enter one exact hostname or IP address.'],
    ['db.corp', '', 'Enter a port from 1 to 65535.'],
    ['db.corp', '0', 'Enter a port from 1 to 65535.'],
    ['db.corp', '65536', 'Enter a port from 1 to 65535.'],
    ['db.corp', '5.5', 'Enter a port from 1 to 65535.'],
    ['db.corp', 'abc', 'Enter a port from 1 to 65535.'],
    ['db.corp', '5432', null],
    [' 10.0.0.8 ', '65535', null],
    ['db.corp', '1', null],
  ])('%s:%s', (host, port, expected) => { expect(routeProblem(host, port)).toBe(expected); });
});

describe('addRoute and removeRoute', () => {
  const routes = [{ host: 'db.corp', port: 5432 }];
  it.each([
    ['', '1', 'Enter one hostname or IP address.'],
    ['DB.corp', '5432', 'That destination is already allowed.'],
    ['db.corp', '99999', 'Enter a port from 1 to 65535.'],
  ])('refuses %s:%s', (host, port, error) => { expect(addRoute(routes, host, port)).toEqual({ error }); });
  it('adds a trimmed destination to the whole list', () => {
    expect(addRoute(routes, ' 10.0.0.8 ', '22')).toEqual({ routes: [...routes, { host: '10.0.0.8', port: 22 }] });
    expect(addRoute(routes, 'db.corp', '5433')).toEqual({ routes: [...routes, { host: 'db.corp', port: 5433 }] });
  });
  it('detects duplicates by lower-case host and port', () => {
    expect(isDuplicateRoute(routes, { host: 'DB.CORP', port: 5432 })).toBe(true);
    expect(isDuplicateRoute(routes, { host: 'db.corp', port: 1 })).toBe(false);
  });
  it('removes by identity', () => { expect(removeRoute(routes, routes[0])).toEqual([]); });
});

describe('peers', () => {
  it('lists distinct hosts, DNS name first', () => { expect(peerHosts(peer())).toEqual(['db.tail.ts.net', '100.1.1.1']); });
  it('skips an empty DNS name', () => { expect(peerHosts(peer({ dnsName: '' }))).toEqual(['100.1.1.1']); });
  it.each([['', true], ['DB', true], ['linux 100.1', true], ['10.0.0', true], ['mac', false], ['db mac', false]])('matches "%s"', (query, expected) => {
    expect(peerMatches(peer(), query)).toBe(expected);
  });
});

describe('connector state', () => {
  const base: PrivateConnector = { id: 'c', workspaceId: 'w', createdAt: '', routes: [], status: 'connected' };
  it.each([
    [null, false], [{ ...base, status: 'needs_login' as const }, true], [{ ...base, status: 'connecting' as const }, true],
    [{ ...base, status: 'awaiting_approval' as const }, false], [base, false], [{ ...base, status: undefined }, false],
  ])('polling %#', (connector, expected) => { expect(isPolling(connector)).toBe(expected); });
  it('keeps the old status when an update has none', () => {
    expect(mergeConnector(base, { ...base, status: undefined, routes: [{ host: 'a', port: 1 }] })).toMatchObject({ status: 'connected', routes: [{ host: 'a', port: 1 }] });
    expect(mergeConnector(null, base)).toBe(base);
  });
});
