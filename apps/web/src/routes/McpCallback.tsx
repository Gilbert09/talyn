import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { PANEL_PATHS } from '../lib/routes';
import { StartingSpinner } from '../components/StartingSpinner';
import { trackEvent } from '../lib/analytics';

/**
 * Where an MCP server's sign-in comes back to.
 *
 * This is the redirect URI the authorization server was given, so it is the
 * only page that ever sees the authorization code — and the code is harmless
 * here: PKCE binds it to a verifier that never left the backend, so a copy of
 * this URL completes nothing on its own.
 *
 * The page has nothing but `code` and `state`. The state names the server (see
 * `serverIdFromState`), and the backend's stored hash is what actually
 * authorises the exchange, so this page can hand both straight over without
 * knowing which server it is finishing.
 */
export function McpCallback() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [complete, setComplete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Strict mode mounts an effect twice in development, and an authorization
  // code is single-use: the second exchange would fail and overwrite a
  // perfectly good result with its refusal.
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;

    const code = params.get('code');
    const state = params.get('state');
    // The vendor refused before we ever got a code — the user pressed Cancel,
    // or the client is not approved. Its own words are the useful part.
    const denied = params.get('error_description') ?? params.get('error');

    // WHY a sign-in ended the way it did, separated at the only place that can
    // tell them apart. `denied` is the vendor refusing or the user pressing
    // Cancel; `malformed` is a redirect that arrived with nothing to finish,
    // which is a bug on our side or theirs rather than a user decision; and an
    // exchange failure is a third thing again. All three are "no connection"
    // to the backend, and each needs a different fix.
    //
    // No `code`, no `state`, no error text: the code is single-use and PKCE
    // binds it to a verifier that never left the server, but it is still a
    // credential-shaped string and has no business in an analytics payload.
    if (denied) {
      trackEvent('mcp_oauth_callback', { outcome: 'denied' });
      if (state) void api.mcpServers.complete(state, '', denied).catch(() => undefined);
      setError(denied);
      return;
    }
    if (!code || !state) {
      trackEvent('mcp_oauth_callback', { outcome: 'malformed' });
      setError('That sign-in did not come back with anything to finish.');
      return;
    }

    api.mcpServers
      .complete(state, code)
      .then(() => {
        trackEvent('mcp_oauth_callback', { outcome: 'connected' });
        setComplete(true);
      })
      .catch((err: unknown) => {
        trackEvent('mcp_oauth_callback', { outcome: 'exchange_failed' });
        setError(err instanceof Error ? err.message : 'Could not finish that sign-in.');
      });
  }, [params, navigate]);

  if (error) {
    return (
      <div className="flex h-screen items-center justify-center p-6">
        <div className="max-w-md text-center">
          <h1 className="font-medium">That sign-in did not finish</h1>
          <p className="mt-2 text-sm text-muted-foreground">{error}</p>
          <button
            className="mt-4 text-sm underline"
            onClick={() => navigate(PANEL_PATHS.mcp_servers, { replace: true })}
          >
            Back to MCP servers
          </button>
        </div>
      </div>
    );
  }

  if (complete) {
    return (
      <div className="flex h-screen items-center justify-center p-6">
        <div className="max-w-md text-center">
          <h1 className="font-medium">MCP server connected</h1>
          <p className="mt-2 text-sm text-muted-foreground">Return to Talyn. You can close this tab.</p>
        </div>
      </div>
    );
  }

  return <StartingSpinner />;
}
