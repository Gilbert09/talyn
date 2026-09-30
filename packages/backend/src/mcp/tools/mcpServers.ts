import type { McpProbeResult, McpServerDefinition } from '@talyn/shared';
import { callApi } from '../api.js';
import {
  bool,
  booleanSchema,
  defineTool,
  linesOrNone,
  requireId,
  resolveWorkspace,
  textSchema,
  workspaceSchema,
} from './helpers.js';

const idSchema = { mcp_server_id: textSchema };
const serverLine = (server: McpServerDefinition) =>
  `${server.id}  ${server.name}  enabled: ${server.enabled}  auth: ${server.authKind}  connection: ${server.oauth?.status ?? (server.hasSecret ? 'credential stored' : 'no credential')}  ${server.url}${server.oauth?.detail ? `  ${server.oauth.detail}` : ''}`;
const createSchema = {
  ...workspaceSchema,
  name: textSchema,
  displayName: textSchema,
  description: textSchema,
  url: textSchema,
  catalogHandle: textSchema,
  authKind: { type: 'string', enum: ['oauth', 'none'] },
  enabled: booleanSchema,
  tools: { type: ['array', 'null'], items: textSchema },
};

export const MCPSERVERS = [
  defineTool(
    'list_mcp_servers',
    'List MCP servers connected to Talyn Fleet runs. Credentials are never returned.',
    workspaceSchema,
    [],
    { readOnlyHint: true },
    async (ownerId, args) => {
      const params = new URLSearchParams({ workspaceId: await resolveWorkspace(ownerId, args) });
      return linesOrNone(
        await callApi<McpServerDefinition[]>(ownerId, 'GET', `/mcp-servers?${params}`),
        serverLine
      );
    },
    'mcpServers'
  ),
  defineTool(
    'get_mcp_server',
    'Get an MCP server and its OAuth connection state. Credentials are never returned.',
    idSchema,
    ['mcp_server_id'],
    { readOnlyHint: true },
    async (ownerId, args) => {
      const server = await callApi<McpServerDefinition>(
        ownerId,
        'GET',
        `/mcp-servers/${requireId(args, 'mcp_server_id')}`
      );
      return [
        serverLine(server),
        `tools: ${server.tools === null || server.tools === undefined ? 'all' : server.tools.join(', ') || 'none'}`,
        ...(server.lastProbe
          ? [
              `last test: ${server.lastProbe.ok ? 'passed' : 'failed'} at ${server.lastProbe.at} ${server.lastProbe.detail ?? ''}`,
            ]
          : []),
      ].join('\n');
    },
    'mcpServers'
  ),
  defineTool(
    'test_mcp_server',
    'Test a connected MCP server and list its available tools. This saves the test result.',
    idSchema,
    ['mcp_server_id'],
    { readOnlyHint: false, openWorldHint: true },
    async (ownerId, args) => {
      const id = requireId(args, 'mcp_server_id');
      const probe = await callApi<McpProbeResult>(ownerId, 'POST', `/mcp-servers/${id}/test`);
      return `${id}  ${probe.ok ? 'passed' : 'failed'}  ${probe.detail ?? probe.serverName ?? ''}\ntools: ${probe.toolNames?.join(', ') || 'none'}`;
    },
    'mcpServers'
  ),
  defineTool(
    'set_mcp_server_enabled',
    'Enable or disable a connected MCP server while preserving its settings and stored credential.',
    { ...idSchema, enabled: booleanSchema },
    ['mcp_server_id', 'enabled'],
    { idempotentHint: true },
    async (ownerId, args) => {
      const id = requireId(args, 'mcp_server_id');
      const server = await callApi<McpServerDefinition>(ownerId, 'GET', `/mcp-servers/${id}`);
      const { name, displayName, description, url, catalogHandle, authKind, inject, tools } =
        server;
      return serverLine(
        await callApi<McpServerDefinition>(ownerId, 'PATCH', `/mcp-servers/${id}`, {
          name,
          displayName,
          description,
          url,
          catalogHandle,
          authKind,
          inject,
          tools,
          enabled: bool(args, 'enabled'),
        })
      );
    },
    'mcpServers'
  ),
  defineTool(
    'delete_mcp_server',
    'Delete an MCP server connection and its stored credential.',
    idSchema,
    ['mcp_server_id'],
    { destructiveHint: true },
    async (ownerId, args) => {
      const id = requireId(args, 'mcp_server_id');
      await callApi(ownerId, 'DELETE', `/mcp-servers/${id}`);
      return `${id} deleted.`;
    },
    'mcpServers'
  ),
  defineTool(
    'connect_mcp_server',
    'Start OAuth sign-in for an MCP server. A person must open the returned URL.',
    idSchema,
    ['mcp_server_id'],
    { openWorldHint: true },
    async (ownerId, args) => {
      const id = requireId(args, 'mcp_server_id');
      const result = await callApi<{ authorizeUrl: string }>(
        ownerId,
        'POST',
        `/mcp-servers/${id}/connect`
      );
      return `${id} A PERSON must open this URL in a browser:\n${result.authorizeUrl}\nThen call talyn_get_mcp_server to check the connection state.`;
    },
    'mcpServers'
  ),
  defineTool(
    'create_mcp_server',
    'Create an OAuth or unauthenticated server. API-key servers must be added in the Talyn app, so the key never passes through an AI transcript.',
    createSchema,
    ['name', 'url', 'authKind'],
    {},
    async (ownerId, args) => {
      // Reject unknown fields before any request. Never echo a possible credential.
      if (Object.keys(args).some((key) => !Object.hasOwn(createSchema, key)))
        throw new Error('Unsupported field. Add API keys and secrets only in the Talyn app.');
      if (args.authKind !== 'oauth' && args.authKind !== 'none')
        throw new Error('Only oauth and none are supported. Add API-key servers in the Talyn app.');
      const url = new URL(requireId(args, 'url'));
      if (url.username || url.password || url.search || url.hash)
        throw new Error('Use a server URL without credentials, query parameters, or a fragment.');
      const { workspace_id: _workspace, ...fields } = args;
      return serverLine(
        await callApi<McpServerDefinition>(ownerId, 'POST', '/mcp-servers', {
          ...fields,
          workspaceId: await resolveWorkspace(ownerId, args),
          authKind: args.authKind === 'oauth' ? 'bearer' : 'none',
          enabled: bool(args, 'enabled', true),
        })
      );
    },
    'mcpServers'
  ),
];
