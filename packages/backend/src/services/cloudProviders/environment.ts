import { v4 as uuid } from 'uuid';
import { and, eq } from 'drizzle-orm';
import { fleetAgentLabel, type CloudProviderType, type FleetAgent } from '@talyn/shared';
import { getDbClient } from '../../db/client.js';
import { environments as environmentsTable } from '../../db/schema.js';
import { emitEnvironmentCreated } from '../websocket.js';
import { rowToEnvironment } from '../../routes/environments.js';
import { getCloudProvider } from './registry.js';
import { notifyTodiex } from '../todiex.js';
import {
  describeWorkspace,
  ownerLine,
  workspaceLabel,
  workspaceMetadata,
} from '../todiexContext.js';

/**
 * Ensure the user has a secret-free env marker for a cloud provider.
 * Created on first integration connect, marked `connected` immediately
 * (no daemon to pair). Idempotent — at most one marker per (user,
 * provider). The per-workspace credentials live on the `integrations`
 * row; this row only carries the provider `type` so a task assigned to it
 * resolves the right provider.
 */
export async function ensureCloudEnvironment(
  userId: string,
  type: CloudProviderType,
): Promise<void> {
  const db = getDbClient();
  const existing = await db
    .select({ id: environmentsTable.id })
    .from(environmentsTable)
    .where(
      and(
        eq(environmentsTable.ownerId, userId),
        eq(environmentsTable.type, type),
      ),
    )
    .limit(1);
  if (existing[0]) return;

  const now = new Date();
  const row = {
    id: uuid(),
    ownerId: userId,
    name: getCloudProvider(type)?.displayName ?? type,
    type,
    status: 'connected' as const,
    config: { type },
    createdAt: now,
    updatedAt: now,
  };
  const [inserted] = await db.insert(environmentsTable).values(row).returning();

  // Tell the owner's connected clients live so the env appears without an
  // app restart (scoped — other tenants must not see this row).
  emitEnvironmentCreated(userId, rowToEnvironment(inserted ?? (row as typeof inserted)));
}


/**
 * Tell the inbox a workspace can now run cloud tasks.
 *
 * Activation for Talyn has two halves — connecting a provider, then actually
 * dispatching — and this is the first. Worth knowing about because it is the
 * step someone gets stuck on: credentials, an OAuth round-trip and a fleet
 * reachability check all have to go right.
 *
 * Deliberately NOT called from inside ensureCloudEnvironment, even though that
 * is the choke point all three connect routes funnel through. That function
 * keys its marker on (user, provider) and never sees a workspaceId, so the
 * notification would be wrong for the second workspace a user connects — and
 * it is also reached by the disconnect path, which must never announce itself
 * as a setup.
 *
 * Fired unconditionally: the dedupe key is per workspace, provider AND agent,
 * so a reconnect or a credential swap resolves to the setup that already
 * happened and stores nothing.
 *
 * The agent is PART of the key rather than merely part of the payload, and the
 * two halves of that are one decision. The fleet is one provider running two
 * different vendors on the workspace's own subscription, so "which one did they
 * connect" is the first thing anyone asks of a fleet signup — and with the
 * vendor named in the notification, collapsing the second agent into the first
 * would be worse than leaving it out: the feed would say a workspace connected
 * the fleet with Claude and nothing anywhere would record that Codex arrived
 * too. Two agents means at most two events, each a separate fact, each once.
 * Every other provider passes no agent, so its key is unchanged.
 */
export function notifyProviderConnected(args: {
  workspaceId: string;
  type: CloudProviderType;
  /** Free-form detail for the feed — a PostHog project, a fleet agent name. */
  detail?: string;
  /** Which fleet agent this connected. Absent for a single-agent provider. */
  agent?: FleetAgent;
}): void {
  const name = getCloudProvider(args.type)?.displayName ?? args.type;
  // Deferred: this is called from three connect routes, and none of them
  // should wait on a name lookup to answer the browser. `provider` keeps the
  // raw type (it is what a query filters on) and `provider_name` adds the
  // one the product uses out loud.
  notifyTodiex(async () => {
    const ws = await describeWorkspace(args.workspaceId);
    return {
      kind: 'workspace.provider_connected',
      level: 'success',
      // The agent goes in the TITLE, not only the metadata: the feed is read as
      // a list of one-liners, and "connected Talyn Fleet" answered the question
      // a fleet signup actually raises with the one detail it needed.
      title: `${workspaceLabel(ws)} connected ${name}${
        args.agent ? ` \u00B7 ${fleetAgentLabel(args.agent)}` : ''
      }`,
      message: [args.detail ?? 'It can run cloud tasks now.', ownerLine(ws)]
        .filter(Boolean)
        .join(' '),
      metadata: {
        provider_name: name,
        provider: args.type,
        // The raw vendor id, matching `FleetAgent` and what the wire uses, so
        // it can be filtered on rather than read.
        ...(args.agent ? { fleet_agent: args.agent } : {}),
        ...workspaceMetadata(ws),
        ...(args.detail ? { detail: args.detail } : {}),
      },
      dedupeKey: `workspace:${args.workspaceId}:provider:${args.type}${
        args.agent ? `:agent:${args.agent}` : ''
      }:connected`,
    };
  });
}
