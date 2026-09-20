import { beforeEach, describe, expect, it, vi } from 'vitest';
import { discoverMcpAuth } from '../services/mcpServers/authDiscovery.js';

const metadata = vi.hoisted(() => vi.fn());
vi.mock('../services/mcpServers/discovery.js', () => ({
  inspectMcpEndpoint: vi.fn().mockResolvedValue({ status: 401, challenge: '', anonymous: false }),
  challengeParameter: vi.fn(),
  resourceMetadataFromChallenge: vi.fn().mockResolvedValue({ authorizationServers: ['https://auth.example.com'] }),
  discoverAuthServer: metadata,
}));

beforeEach(() => metadata.mockReset());

describe('catalog authentication defaults', () => {
  it('prefers a supported key when OAuth requires a registered client', async () => {
    metadata.mockResolvedValue({ clientIdMetadataDocumentSupported: false });
    expect(await discoverMcpAuth('https://mcp.render.com/mcp')).toMatchObject({
      methods: ['bearer', 'oauth'],
      credentialLabel: 'Render API key',
    });
  });

  it.each([
    { registrationEndpoint: 'https://auth.example.com/register', clientIdMetadataDocumentSupported: false },
    { clientIdMetadataDocumentSupported: true },
  ])('prefers OAuth when the server supports automatic client setup: %j', async (server) => {
    metadata.mockResolvedValue(server);
    expect((await discoverMcpAuth('https://mcp.monday.com/mcp')).methods).toEqual(['oauth', 'bearer']);
  });

  it('does not invent a key option for a server that only documents OAuth', async () => {
    metadata.mockResolvedValue({ clientIdMetadataDocumentSupported: false });
    expect((await discoverMcpAuth('https://mcp.figma.com/mcp')).methods).toEqual(['oauth']);
  });
});
