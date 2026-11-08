# Workspace private routes

Workspace private routes add exact TCP destinations to new Talyn Fleet
sandboxes. They do not replace the sandbox egress policy. A sandbox with
public internet access keeps `policy.egress.mode = "open"`.

Talyn owns the destination allow-list. YAS owns the workspace connector and
the Tailscale login flow. This design does not edit the customer tailnet
policy. It does not request access to that policy.

## Release gate

Create the `tailscale-private-routes` boolean flag in the production PostHog
project. Target the first release condition only to the selected Talyn account.
Do not add a catch-all rollout.

The backend evaluates this flag against the workspace owner. It checks the
flag for connector calls and sandbox policy creation. The safe fallback is
off. `TAILSCALE_PRIVATE_ROUTES_ENABLED` is the break-glass override. Leave this
variable unset in production so PostHog controls the audience.

## YAS deployment

The YAS control plane needs these variables:

```text
YASCTL_PRIVATE_ROUTES=1
YASCTL_TOKEN_KEY=<existing 32-byte hex key>
YASCTL_REPORT_TOKEN=<host report token>
DATABASE_URL=<Postgres connection string>
```

Each fleet host needs these variables:

```text
FLEET_PRIVATE_ROUTES_URL=https://<yas-host>/v1/private-routes/dial
FLEET_PRIVATE_ROUTES_TOKEN=<same value as YASCTL_REPORT_TOKEN>
```

The YAS HTTPS ingress must support HTTP/1.1 upgrades and long streams.

Backend MCP connections use a standard WebSocket upgrade with the `yas-private-tcp-v1` subprotocol.
Deploy the YAS WebSocket endpoint before the Talyn client.
The exact handshake and TLS rules are in [the setup guide](SETUP.md#private-mcp-setup-through-yas).

Talyn uses its existing gateway connection:

```text
FLEET_PINNED_ENDPOINT=https://api.yetanothersandbox.dev
FLEET_GATEWAY_TOKEN=yas_sk_...
```

Never expose the gateway token to a renderer. Talyn sends connector calls only
from its backend.

## User flow

The user opens **Settings → Private routes** and selects **Connect Tailscale**.
Talyn asks YAS to start the connector. The client opens the returned login URL
once and does not store or log it.

Tailscale does not redirect to Talyn. The settings page polls YAS every two
seconds. It stops when the connector is connected, needs approval, is
unavailable, or a request fails.

The user can replace the complete allow-list with exact hostname-or-IP and TCP
port pairs. Added routes apply to new sandboxes. Removed routes stop working
immediately. Existing sandboxes do not gain newly added routes.

## Sandbox policy

Every sandbox creation path uses the shared policy builder. It sends the Talyn
workspace UUID and adds routes only from a connected workspace connector:

```json
{
  "workspaceId": "<Talyn workspace UUID>",
  "policy": {
    "version": 2,
    "credentials": {},
    "egress": { "mode": "open" },
    "privateRoutes": [
      { "connectorId": "<YAS connector ID>", "host": "db.corp", "port": 5432 }
    ]
  }
}
```

The builder preserves `policy.credentials` and `policy.egress`. A YAS 404 means
that the workspace has no connector. Other YAS errors use safe messages that
do not include credentials or internal URLs.

Warm sandboxes include the current private routes in their specification hash.
Talyn does not claim a warm sandbox after the route policy changes.

## Operational checks

Before release, confirm these points:

1. A workspace outside the flag audience receives HTTP 403 for every connector
   operation.
2. A workspace member without access cannot read or change a connector.
3. A connected workspace sends its connector routes on new sandbox requests.
4. A disconnected workspace sends no `privateRoutes` field.
5. Public internet access still sends `egress.mode = "open"`.
6. YAS returns HTTP 204 before Talyn reports a successful disconnect.
7. The login URL is absent from logs, stored state, and GET responses.

The YAS implementation and its full operator contract are in
[yetanothersandbox-dev/yas#9](https://github.com/yetanothersandbox-dev/yas/pull/9).
