import { api } from './api';

type Flow = Awaited<ReturnType<typeof api.mcpServers.startSignIn>>;

/**
 * Start an MCP server sign-in, with a loopback callback this app listens on.
 *
 * The backend uses the hosted callback when the server accepts it, and the
 * loopback one only when the server refuses the hosted one (pganalyze). The
 * authorize URL's `redirect_uri` says which. On loopback, the main process
 * receives the code and this forwards it to `/mcp-servers/complete`; the
 * caller's status poll then sees the result, as it does for the hosted path.
 *
 * Call `close` when the sign-in ends, so the port is freed.
 */
export async function startMcpSignIn(serverId: string): Promise<{ flow: Flow; close: () => void }> {
  const bridge = window.electron?.mcpOAuth;
  const loopback = bridge ? await bridge.listen().catch(() => null) : null;
  const close = () => {
    if (bridge && loopback) void bridge.close(loopback.id).catch(() => undefined);
  };
  let flow: Flow;
  try {
    flow = await api.mcpServers.startSignIn(
      serverId,
      loopback ? { loopbackRedirectUri: loopback.redirectUri } : undefined
    );
  } catch (err) {
    close();
    throw err;
  }
  const authorize = new URL(flow.authorizeUrl);
  const state = authorize.searchParams.get('state');
  if (!bridge || !loopback || !state || authorize.searchParams.get('redirect_uri') !== loopback.redirectUri) {
    close();
    return { flow, close: () => undefined };
  }
  void bridge
    .wait(loopback.id, state)
    .then((callback) => {
      if (!callback) return undefined;
      return api.mcpServers.complete(callback.state, callback.code ?? '', callback.error);
    })
    // The backend stores a failed exchange on the grant, and the poll shows it.
    .catch(() => undefined);
  return { flow, close };
}
