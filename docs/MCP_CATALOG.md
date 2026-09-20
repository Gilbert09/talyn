# MCP catalog sources

Reviewed on 2026-09-20.

The [exe.dev integration catalog](https://exe.dev/docs/integrations-catalog) informed this expansion.
That catalog includes REST APIs and database connections. Talyn entries below use hosted MCP endpoints.

| Entry | Provider setup guide | Authentication |
| --- | --- | --- |
| Figma | [Remote server](https://developers.figma.com/docs/figma-mcp-server/remote-server-installation/) | OAuth |
| Render | [MCP server](https://render.com/docs/mcp-server) | API key; OAuth requires a registered client |
| Netlify | [Remote setup](https://docs.netlify.com/build/build-with-ai/agent-setup-guides/set-up-codex-for-netlify/) | OAuth |
| Buildkite | [Remote MCP](https://buildkite.com/docs/apis/mcp-server/remote/configuring-ai-tools) | OAuth; API tokens use a separate endpoint |
| Axiom | [MCP server](https://axiom.co/docs/console/intelligence/mcp-server) | OAuth; token setup requires an additional organization header |
| ClickUp | [MCP setup](https://developer.clickup.com/docs/connect-an-ai-assistant-to-clickups-mcp-server-1) | OAuth |
| monday.com | [MCP integration](https://developer.monday.com/api-reference/docs/integrate-with-monday-mcp) | OAuth or personal API token |
| Attio | [MCP server](https://mcp.attio.com/) | OAuth |
| Todoist | [Developer guide](https://developer.todoist.com/) | OAuth |
| Amplitude (US and EU) | [MCP regions](https://amplitude.com/docs/amplitude-ai/amplitude-mcp) | OAuth |
| Cloudflare, Workers, Observability | [Hosted servers](https://developers.cloudflare.com/agents/model-context-protocol/cloudflare/servers-for-cloudflare/) | OAuth |

Each endpoint returned an authentication challenge during an unauthenticated MCP initialization check.
Talyn's discovery code also read each authorization server's metadata.
These checks do not verify account access, token exchange, or authenticated tool calls.
Provider plans and administrator policies can limit access.

The catalog bundles public favicons. Connections reuse Talyn's existing credential storage and tool controls.
The US and EU Amplitude entries keep region selection explicit.
Render defaults to its documented API key because it does not advertise automatic OAuth client registration.
