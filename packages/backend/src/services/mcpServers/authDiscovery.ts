import { fetchFailureReason, type McpRequestContext } from './http.js';
import { MCP_CATALOG, type McpAuthDiscovery, type McpAuthMethod } from '@talyn/shared';
import {
  McpDiscoveryError,
  challengeParameter,
  discoverAuthServer,
  inspectMcpEndpoint,
  resourceMetadataFromChallenge,
} from './discovery.js';

export async function discoverMcpAuth(endpoint: string, context?: McpRequestContext): Promise<McpAuthDiscovery> {
  const catalog = MCP_CATALOG.find(
    (entry) => new URL(entry.url).toString() === new URL(endpoint).toString()
  );
  const known: McpAuthMethod[] = catalog
    ? [
        ...(catalog.oauth ? ['oauth' as const] : []),
        ...(!catalog.oauth || catalog.credentialLabel ? [catalog.authKind] : []),
      ]
    : [];
  const hints = { inject: catalog?.inject, credentialLabel: catalog?.credentialLabel };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('The MCP request timed out.', 'TimeoutError')), 10_000);
  try {
    const endpointInfo = await inspectMcpEndpoint(endpoint, controller.signal, context);
    let oauthAdvertised = Boolean(challengeParameter(endpointInfo.challenge, 'resource_metadata'));
    try {
      const resource = await resourceMetadataFromChallenge(
        endpoint,
        endpointInfo.challenge,
        controller.signal,
        context
      );
      oauthAdvertised = true;
      const server = await discoverAuthServer(resource.authorizationServers[0], controller.signal, context);
      return {
        methods: server.clientIdMetadataDocumentSupported || server.registrationEndpoint
          ? ['oauth', ...known.filter((method) => method !== 'oauth' && method !== 'none')]
          : [...known.filter((method) => method !== 'oauth' && method !== 'none'), 'oauth'],
        source: 'server',
        ...hints,
        ...(!server.clientIdMetadataDocumentSupported && !server.registrationEndpoint
          ? {
              detail:
                'This server requires a registered OAuth client. Talyn cannot register automatically with this server.',
            }
          : {}),
      };
    } catch (error) {
      if (oauthAdvertised)
        return {
          methods: known.filter((method) => method !== 'oauth'),
          source: known.length ? 'catalog' : 'unknown',
          ...hints,
          detail:
            `The server advertises OAuth, but its sign-in configuration could not be read: ${error instanceof McpDiscoveryError ? error.message : fetchFailureReason(error)}.`,
        };
    }
    if (known.length) return { methods: known, source: 'catalog', ...hints };
    if (endpointInfo.anonymous) return { methods: ['none'], source: 'server' };
    const methods: McpAuthMethod[] = [];
    if (endpointInfo.status === 401) {
      if (/(?:^|,)\s*Basic\s/i.test(endpointInfo.challenge)) methods.push('basic');
      if (/(?:^|,)\s*Bearer\s/i.test(endpointInfo.challenge)) methods.push('bearer');
    }
    return methods.length
      ? { methods, source: 'server' }
      : {
          methods: [],
          source: 'unknown',
          detail: 'The server did not identify its authentication method. Use manual setup.',
        };
  } catch (error) {
    return {
      methods: known,
      source: known.length ? 'catalog' : 'unknown',
      ...hints,
      detail: known.length
        ? 'The server could not be checked. These options come from the catalog.'
        : `The server could not be checked: ${error instanceof McpDiscoveryError ? error.message : fetchFailureReason(error)}.`,
    };
  } finally {
    clearTimeout(timer);
  }
}
