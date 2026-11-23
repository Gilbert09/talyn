import { mcpCatalogEntry, mcpServerFromCatalog, type McpServerDefinition, type McpServerInput } from '@talyn/shared';

import {
  accessScope, addressEdit, addressHint, addressProblem, allToolsChange, availableMethods, catalogLogo, catalogMatches, connectedHandles,
  credentialStored, discoveredMethod, hostOf, identifierFromTyping, initialEditorInput, isInvalidReturnTo, isSlackAddress, mcpRequest,
  methodEdit, onlySelectedRepositories, otherNames, parsesAsUrl, plainText, probeSummary, sameRequest, scopeSummary, selectedTools,
  serverStatus, signedInLine, toggleId, toggleTool, toolNames, toolRow, SIGN_IN_MAX_MS, SIGN_IN_POLL_MS,
} from '../features/mcp/model';
import { runMcpSignIn, type SignInDeps, type SignInStatus } from '../features/mcp/signIn';

const server: McpServerDefinition = {
  id: 'srv-1', workspaceId: 'ws-1', name: 'example', url: 'https://mcp.example.com/mcp', authKind: 'bearer', inject: null,
  hasSecret: false, oauth: null, enabled: true, tools: null, repositoryIds: null, catalogHandle: null, displayName: null,
  description: null, lastProbe: null, createdAt: '', updatedAt: '',
};
const base: McpServerInput = { name: 'example', url: 'https://mcp.example.com/mcp', authKind: 'bearer', enabled: true };

describe('address validation', () => {
  it.each(['', 'htt', 'mcp.example.com', 'https://'])('stays quiet while %j is typed', (url) => {
    expect(addressHint(url)).toBeNull();
  });

  it.each([
    ['https://mcp.polar.sh/mcp/polar-mcp?telemetry=false', /may not carry a query string/],
    ['https://mcp.example.com/mcp#tools', /may not carry a #fragment/],
    ['https://user:pass@mcp.example.com/mcp', /put the credential in the key field/],
    ['ftp://mcp.example.com/mcp', /must be an https:\/\/ address/],
    ['https://localhost/mcp', /private route/],
    ['https://10.0.0.4/mcp', /private route/],
  ])('says why %s cannot connect', (url, reason) => {
    expect(addressHint(url)).toMatch(reason);
    expect(addressProblem(url)).toMatch(reason);
  });

  it.each(['https://mcp.example.com/mcp', 'https://mcp.stripe.com/', 'https://mcp.vercel.com'])('accepts %s', (url) => {
    expect(addressHint(url)).toBeNull();
    expect(addressProblem(url)).toBeNull();
  });

  it('accepts a private host only with its exact route', () => {
    expect(addressProblem('https://mcp.local/mcp')).not.toBeNull();
    expect(addressProblem('https://mcp.local/mcp', [{ host: 'mcp.local', port: 443 }])).toBeNull();
    expect(addressProblem('https://mcp.local:8443/mcp', [{ host: 'mcp.local', port: 443 }])).not.toBeNull();
  });

  it('reports an empty address as a problem but not as a hint', () => {
    expect(addressProblem('')).toMatch(/needs a URL/);
    expect(addressHint('')).toBeNull();
  });

  it.each([
    ['https://x.y/z', true], ['  https://x.y/z  ', true], ['x.y', false], ['', false],
  ])('parsesAsUrl(%j) is %s', (value, expected) => expect(parsesAsUrl(value)).toBe(expected));

  it.each([
    ['https://mcp.slack.com/mcp', true], ['https://mcp.slack.com.evil.com/mcp', false], ['http://mcp.slack.com/mcp', false], ['nope', false],
  ])('isSlackAddress(%s) is %s', (url, expected) => expect(isSlackAddress(url)).toBe(expected));

  it.each([['https://mcp.example.com/mcp', 'mcp.example.com'], ['bad', 'invalid']])('hostOf(%s)', (url, host) => expect(hostOf(url)).toBe(host));
});

describe('identifier and initial input', () => {
  it.each([
    ['Example Work', 'example-work'], ['my_server', 'my-server'], ['A  B__C', 'a-b-c'], ['linear', 'linear'], ['', ''],
  ])('types %j as %j', (typed, expected) => expect(identifierFromTyping(typed)).toBe(expected));

  it('prefills a catalog entry', () => {
    const input = initialEditorInput(null, mcpServerFromCatalog(mcpCatalogEntry('github')!), []);
    expect(input).toMatchObject({ name: 'github-mcp', url: 'https://api.githubcopilot.com/mcp/', catalogHandle: 'github',
      displayName: 'GitHub', authKind: 'bearer', tools: null, repositoryIds: null, enabled: true });
  });

  it('renames a catalog prefill whose name is taken', () => {
    const input = initialEditorInput(null, mcpServerFromCatalog(mcpCatalogEntry('linear')!), ['linear']);
    expect(input.name).toBe('linear-2');
  });

  it('starts from the saved server, with no secret', () => {
    const input = initialEditorInput({ ...server, hasSecret: true, tools: [], repositoryIds: ['r1'] }, undefined, []);
    expect(input).toMatchObject({ name: 'example', tools: [], repositoryIds: ['r1'] });
    expect('secret' in input && input.secret !== undefined).toBe(false);
  });

  it('starts empty for a custom server', () => {
    expect(initialEditorInput(null, undefined, [])).toEqual({ name: '', url: '', authKind: 'bearer', enabled: true, tools: null, repositoryIds: null });
  });

  it.each([
    ['https://tools.example.org/mcp', { name: 'tools-example-org', displayName: 'tools.example.org', authKind: 'bearer', secret: '' }],
    ['https://mcp.linear.app/mcp', { name: 'linear', catalogHandle: 'linear', displayName: 'Linear' }],
    ['https://mcp.context7.com/mcp', { authKind: 'header', inject: { header: 'CONTEXT7_API_KEY' } }],
    ['htt', { name: '', url: 'htt', authKind: 'bearer', secret: '', catalogHandle: undefined }],
  ])('fills the details for the address %s', (url, expected) => {
    expect(addressEdit(url, [])).toMatchObject({ url, ...expected });
  });

  it('gives a new address a free name', () => {
    expect(addressEdit('https://tools.example.org/mcp', ['tools-example-org']).name).toBe('tools-example-org-2');
  });
});

describe('authentication', () => {
  it.each([
    ['oauth', null, { authKind: 'bearer', secret: '', inject: undefined }],
    ['none', null, { authKind: 'none', secret: '', inject: undefined }],
    ['header', { methods: ['header'], source: 'catalog', inject: { header: 'X-Key' } }, { authKind: 'header', inject: { header: 'X-Key' } }],
    ['basic', { methods: ['basic'], source: 'server', inject: { header: 'X-Key' } }, { authKind: 'basic', inject: undefined }],
  ] as const)('methodEdit(%s)', (method, discovery, expected) => {
    expect(methodEdit(method, discovery as never)).toMatchObject(expected);
  });

  it('takes the first discovered method for a new server', () => {
    expect(discoveredMethod({ methods: ['oauth', 'bearer'], source: 'server' }, null, base.url))
      .toEqual({ method: 'oauth', patch: { authKind: 'bearer', inject: undefined } });
    expect(discoveredMethod({ methods: ['header'], source: 'catalog', inject: { header: 'H' } }, null, base.url))
      .toEqual({ method: 'header', patch: { authKind: 'header', inject: { header: 'H' } } });
  });

  it.each([
    [{ hasSecret: true }, 'bearer'],
    [{ oauth: { status: 'connected' as const } }, 'oauth'],
  ])('keeps the saved method %#', (patch, method) => {
    expect(discoveredMethod({ methods: ['oauth'], source: 'server' }, { ...server, ...patch }, server.url)).toEqual({ method });
  });

  it('does not keep the saved method at a new address', () => {
    expect(discoveredMethod({ methods: ['none'], source: 'server' }, { ...server, hasSecret: true }, 'https://other.example.com/mcp'))
      .toEqual({ method: 'none', patch: { authKind: 'none', inject: undefined } });
  });

  it('answers null when nothing is discovered', () => {
    expect(discoveredMethod({ methods: [], source: 'unknown' }, null, base.url)).toBeNull();
  });

  it.each([
    [{ ...server, hasSecret: true }, base, true],
    [{ ...server, hasSecret: true }, { ...base, secret: '' }, false],
    [{ ...server, hasSecret: true }, { ...base, secret: 'new' }, true],
    [{ ...server, hasSecret: true }, { ...base, authKind: 'header' as const }, false],
    [{ ...server, hasSecret: true }, { ...base, url: 'https://other.example.com/mcp' }, false],
    [{ ...server, hasSecret: false }, base, false],
    [null, base, false],
  ])('credentialStored %#', (editing, input, expected) => expect(credentialStored(editing, input)).toBe(expected));

  it('lists the chosen method first and drops repeats', () => {
    expect(availableMethods('bearer', { methods: ['oauth', 'bearer'], source: 'server' })).toEqual(['bearer', 'oauth']);
    expect(availableMethods('none', null)).toEqual(['none']);
  });
});

describe('allow-lists keep three states', () => {
  it.each<[string[] | null | undefined, string]>([[null, 'all'], [undefined, 'all'], [[], 'none'], [['a'], 'subset']])('accessScope(%j) is %s', (list, scope) => {
    expect(accessScope(list)).toBe(scope);
  });

  it('starts "only selected" with every repository', () => {
    expect(onlySelectedRepositories([{ id: 'a' }, { id: 'b' }])).toEqual(['a', 'b']);
    expect(onlySelectedRepositories([])).toEqual([]);
  });

  it.each([
    [['a', 'b'], 'b', ['a']], [['a'], 'a', []], [[], 'a', ['a']], [['a'], 'b', ['a', 'b']],
  ])('toggleId(%j, %s)', (list, id, expected) => expect(toggleId(list, id)).toEqual(expected));

  it('draws offered tools and stale allowed ones, sorted', () => {
    expect(toolNames(['search', 'read'], null)).toEqual(['read', 'search']);
    expect(toolNames(['read'], ['gone', 'read'])).toEqual(['gone', 'read']);
    expect(toolNames([], [])).toEqual([]);
  });

  it.each([
    [null, ['a', 'b'], ['a', 'b']], [undefined, ['a'], ['a']], [[], ['a'], []], [['b'], ['a', 'b'], ['b']],
  ])('selectedTools(%j, %j)', (allowed, offered, expected) => expect(selectedTools(allowed, offered)).toEqual(expected));

  it.each([
    [null, ['a', 'b'], 'a', ['b']],
    [['b'], ['a', 'b'], 'a', ['b', 'a']],
    [['a'], ['a'], 'a', []],
    [[], ['a'], 'a', ['a']],
    [['gone'], ['a'], 'gone', []],
  ])('toggleTool(%j, %j, %s)', (allowed, offered, name, expected) => expect(toggleTool(allowed, offered, name)).toEqual(expected));

  it.each([[true, ['a'], null], [false, ['a', 'b'], ['a', 'b']], [false, [], []]] as const)('allToolsChange(%s)', (checked, offered, expected) => {
    expect(allToolsChange(checked, [...offered])).toEqual(expected);
  });

  it.each([
    ['tools', null, null], ['tools', undefined, null], ['tools', [], []], ['tools', ['read'], ['read']],
    ['repositoryIds', null, null], ['repositoryIds', undefined, null], ['repositoryIds', [], []], ['repositoryIds', ['r1', 'r2'], ['r1', 'r2']],
  ] as const)('sends %s %j as %j', (field, value, expected) => {
    const body = mcpRequest({ ...base, [field]: value });
    expect(body[field]).toEqual(expected);
    expect(JSON.parse(JSON.stringify(body))[field]).toEqual(expected);
  });

  it('copies the lists so a later edit cannot change a sent body', () => {
    const tools = ['a'];
    const body = mcpRequest({ ...base, tools });
    tools.push('b');
    expect(body.tools).toEqual(['a']);
  });

  it.each([
    [undefined, false], ['', true], ['sk-123', true],
  ])('sends secret %j only when it is set', (secret, present) => {
    const body = mcpRequest({ ...base, secret });
    expect('secret' in body).toBe(present);
    if (present) expect(body.secret).toBe(secret);
  });

  it.each([
    [{}, {}, true],
    [{ tools: null }, { tools: undefined }, true],
    [{ tools: null }, { tools: [] }, false],
    [{ repositoryIds: [] }, { repositoryIds: ['a'] }, false],
    [{ secret: undefined }, { secret: 'x' }, false],
    [{ name: 'a' }, { name: 'b' }, false],
  ])('sameRequest %#', (a, b, expected) => expect(sameRequest({ ...base, ...a }, { ...base, ...b })).toBe(expected));

  it.each([
    [null, 5, 'All repositories'], [[], 5, '0 of 5'], [['a', 'b'], 5, '2 of 5'],
  ])('scopeSummary(%j)', (list, total, expected) => expect(scopeSummary(list, total, 'repositories')).toBe(expected));
});

describe('tools', () => {
  it.each([
    ['**Search documents.**', 'Search documents.'],
    ['Read [the docs](https://x.y) `now`', 'Read the docs now'],
    ['# Title\nLine two', 'Title Line two'],
    ['plain', 'plain'],
  ])('plainText(%j)', (markdown, text) => expect(plainText(markdown)).toBe(text));

  it.each([
    ['search', ['search'], [{ name: 'search', title: 'Search', description: '**Find.**' }], { label: 'Search', detail: 'Find.' }],
    ['search', ['search'], undefined, { label: 'search', detail: 'No description provided.' }],
    ['gone', ['search'], undefined, { label: 'gone', detail: 'Not offered by the server now.' }],
  ])('toolRow(%s) %#', (name, offered, metadata, expected) => expect(toolRow(name, offered, metadata)).toEqual(expected));
});

describe('the list', () => {
  it.each([
    [{ oauth: { status: 'needs_reauth' as const, detail: 'Revoked.' } }, { label: 'Sign in again', tone: 'warning', detail: 'Revoked.' }],
    [{ oauth: { status: 'pending' as const } }, { label: 'Needs sign-in', tone: 'warning' }],
    [{ lastProbe: { ok: true, at: '' } }, { label: 'Connected', tone: 'success' }],
    [{ lastProbe: { ok: false, at: '', detail: 'Refused.' } }, { label: 'Refused.', tone: 'destructive' }],
    [{ lastProbe: { ok: false, at: '' } }, { label: 'Could not connect', tone: 'destructive' }],
    [{ oauth: { status: 'connected' as const }, lastProbe: { ok: true, at: '' } }, { label: 'Connected', tone: 'success' }],
    [{}, null],
  ])('serverStatus %#', (patch, expected) => expect(serverStatus({ ...server, ...patch })).toEqual(expected));

  it.each([
    [{ ok: true, at: '', serverName: 'Linear', toolNames: ['a', 'b'] }, 'Connected to Linear, which offers 2 tools.'],
    [{ ok: true, at: '', toolNames: ['a'] }, 'Connected to the server, which offers 1 tool.'],
    [{ ok: true, at: '' }, 'Connected to the server.'],
    [{ ok: false, at: '', detail: 'The key was refused.' }, 'Could not connect. The key was refused.'],
  ])('probeSummary %#', (probe, text) => expect(probeSummary(probe)).toBe(text));

  it('searches the catalog by title, summary and handle', () => {
    expect(catalogMatches('').length).toBeGreaterThan(10);
    expect(catalogMatches('LINEAR').map((entry) => entry.handle)).toEqual(['linear']);
    expect(catalogMatches('postgres').map((entry) => entry.handle)).toContain('neon');
    expect(catalogMatches('no such vendor')).toEqual([]);
  });

  it('collects the connected catalog handles', () => {
    expect([...connectedHandles([{ catalogHandle: 'linear' }, { catalogHandle: null }, { catalogHandle: undefined }, { catalogHandle: 'linear' }])])
      .toEqual(['linear']);
  });

  it('leaves out the edited server from the names in use', () => {
    const list = [{ id: 'a', name: 'one' }, { id: 'b', name: 'two' }];
    expect(otherNames(list, 'a')).toEqual(['two']);
    expect(otherNames(list, null)).toEqual(['one', 'two']);
  });

  it.each([
    ['https://x.y/mcp', 'linear', true],
    ['https://mcp.linear.app/other', null, true],
    ['http://mcp.linear.app/mcp', null, false],
    ['https://unknown.example.com/mcp', null, false],
    ['bad', null, false],
    [null, null, false],
  ])('catalogLogo(%s, %s)', (url, handle, found) => {
    expect(catalogLogo(url, handle) !== null).toBe(found);
  });

  it.each([
    [{ name: 'Tom', email: 'tom@example.com' }, 'Signed in as Tom · tom@example.com'],
    [{ email: 'tom@example.com' }, 'Signed in as tom@example.com'],
    [{}, 'Signed in.'],
    [null, 'Signed in.'],
  ])('signedInLine %#', (account, line) => expect(signedInLine(account)).toBe(line));

  it.each([
    [{ status: 400, code: 'invalid_return_to' }, true],
    [{ status: 400, code: 'other' }, false],
    [{ status: 500, code: 'invalid_return_to' }, false],
    [new Error('x'), false],
    [null, false],
  ])('isInvalidReturnTo %#', (error, expected) => expect(isInvalidReturnTo(error)).toBe(expected));
});

describe('runMcpSignIn', () => {
  const flow = { flowId: 'flow-1', authorizeUrl: 'https://auth.example.com/authorize', expiresAt: '' };

  function deps(statuses: SignInStatus[], overrides: Partial<SignInDeps> = {}) {
    let clock = 0;
    const status = jest.fn(async () => statuses.shift() ?? { status: 'pending' as const, pending: true });
    const sleep = jest.fn(async (ms: number) => { clock += ms; });
    const value: SignInDeps = {
      start: jest.fn(async () => ({ ...flow, expiresAt: new Date(60_000).toISOString() })),
      open: jest.fn(async () => 'returned' as const),
      status, sleep, now: () => clock, alive: () => true, onBrowserClosed: jest.fn(), ...overrides,
    };
    return value;
  }

  it('finishes when the flow connects', async () => {
    const d = deps([{ status: 'connected', pending: false }]);
    await expect(runMcpSignIn(d)).resolves.toEqual({ outcome: 'connected' });
    expect(d.open).toHaveBeenCalledWith(flow.authorizeUrl);
    expect(d.status).toHaveBeenCalledWith('flow-1');
  });

  it('keeps polling while the flow is pending, then connects', async () => {
    const d = deps([{ status: 'pending', pending: true }, { status: 'pending', pending: true }, { status: 'connected', pending: false }]);
    await expect(runMcpSignIn(d)).resolves.toEqual({ outcome: 'connected' });
    expect(d.status).toHaveBeenCalledTimes(3);
    expect(d.onBrowserClosed).toHaveBeenCalledTimes(1);
    expect(d.onBrowserClosed).toHaveBeenCalledWith(flow.authorizeUrl);
  });

  it.each([
    [{ status: 'pending', pending: false, detail: 'The grant was refused.' }, 'The grant was refused.'],
    [{ status: 'needs_reauth', pending: true }, 'Sign-in did not finish. Try again.'],
    [{ status: 'connected', pending: true, detail: 'x' }, null],
  ] as const)('reports a failed flow %#', async (status, detail) => {
    const d = deps([status as SignInStatus, { status: 'connected', pending: false }]);
    const result = await runMcpSignIn(d);
    expect(result).toEqual(detail === null ? { outcome: 'connected' } : { outcome: 'error', detail });
  });

  it('stops when the flow expires', async () => {
    const d = deps([]);
    await expect(runMcpSignIn(d)).resolves.toEqual({ outcome: 'timeout' });
    expect((d.status as jest.Mock).mock.calls.length).toBe(60_000 / SIGN_IN_POLL_MS);
  });

  it('never polls longer than ten minutes', async () => {
    const d = deps([], { start: async () => ({ ...flow, expiresAt: new Date(SIGN_IN_MAX_MS * 3).toISOString() }) });
    await expect(runMcpSignIn(d)).resolves.toEqual({ outcome: 'timeout' });
    expect((d.status as jest.Mock).mock.calls.length).toBe(SIGN_IN_MAX_MS / SIGN_IN_POLL_MS);
  });

  it('treats a missing expiry as ten minutes', async () => {
    const d = deps([], { start: async () => ({ ...flow, expiresAt: 'not a date' }) });
    await expect(runMcpSignIn(d)).resolves.toEqual({ outcome: 'timeout' });
  });

  it('does nothing more once it is superseded', async () => {
    let alive = true;
    const d = deps([], { alive: () => alive, status: jest.fn(async () => { alive = false; return { status: 'connected' as const, pending: false }; }) });
    await expect(runMcpSignIn(d)).resolves.toEqual({ outcome: 'superseded' });
  });

  it('does not open the browser when it is superseded before the flow starts', async () => {
    const d = deps([], { alive: () => false });
    await expect(runMcpSignIn(d)).resolves.toEqual({ outcome: 'superseded' });
    expect(d.open).not.toHaveBeenCalled();
  });

  it('checks at once when the browser returns', async () => {
    const d = deps([{ status: 'connected', pending: false }], { sleep: () => new Promise<void>(() => undefined) });
    await expect(runMcpSignIn(d)).resolves.toEqual({ outcome: 'connected' });
  });
});
