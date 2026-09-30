import { site } from "@/lib/content";

/**
 * A second OAuth Client ID Metadata Document, for LOCAL development only.
 *
 * `/oauth-client` lists exactly one redirect URI, the production backend's
 * callback, and it stays that way: that list is what stops anybody nominating
 * a different destination for a production authorization code. A local
 * backend therefore cannot use that client. This document is a separate
 * client ("Talyn (local dev)") whose only redirect is the loopback callback of
 * a backend on this machine. PostHog accepts http redirect URIs for loopback
 * addresses only, and PKCE still protects the exchange.
 *
 * A code sent here goes to a port on the user's own machine, never to a
 * server, and the consent screen names the client as local dev, so it cannot
 * pass for the real app. To use it, a local backend sets:
 *   POSTHOG_OAUTH_CLIENT_ID=https://www.talyn.dev/oauth-client-dev
 *   POSTHOG_OAUTH_REDIRECT_URI=http://localhost:4747/api/v1/posthog/oauth/callback
 *
 * See `app/oauth-client/route.ts` for why `client_id` must equal the served
 * URL byte for byte, and why no token endpoint auth method is declared.
 */

const LOCAL_BACKEND_ORIGIN = "http://localhost:4747";

export const dynamic = "force-static";

export function GET(): Response {
  const body = {
    client_id: `${site.url}/oauth-client-dev`,
    client_name: `${site.name} (local dev)`,
    client_uri: site.url,
    logo_uri: `${site.url}/apple-touch-icon.png`,
    redirect_uris: [`${LOCAL_BACKEND_ORIGIN}/api/v1/posthog/oauth/callback`],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  };

  return new Response(JSON.stringify(body, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=3600, s-maxage=3600",
    },
  });
}
