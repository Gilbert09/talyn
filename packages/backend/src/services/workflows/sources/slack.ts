import { and, eq, sql } from 'drizzle-orm';
import type { SlackEventFacts, WorkflowDefinition } from '@talyn/shared';
import { getPoolDbClient } from '../../../db/client.js';
import {
  slackInstallations,
  slackUserLinks,
  workflows as workflowsTable,
  workspaces as workspacesTable,
} from '../../../db/schema.js';
import { channelName, mentionedUserIds, messagePermalink, PERSON_SUBTYPES } from '../../slack/context.js';
import { workspaceMayUseSlackRules } from '../../workflowsAccess.js';
import type { WorkflowSourceAdapter, WorkflowSourceTarget } from '../source.js';

/**
 * The Slack source adapter: a Slack `message` event in a channel in, the
 * facts of one message out.
 *
 * The engine core (`../engine.ts`) does the rest: the flags, the matcher, the
 * per-channel rate cap, the claim on `slack:<event_id>` and the actions.
 */

/** One stored Slack event, and what the caller already knows of its install. */
export interface SlackWorkflowInput {
  /** Slack's `event_id`. A redelivery repeats it. */
  eventId: string;
  teamId: string;
  /** `payload.event`, as Slack sent it. */
  event: Record<string, unknown>;
  /** The install's own bot user, so its messages and its mentions are dropped. */
  botUserId: string;
}

/** One workspace whose enabled Slack rules watch this team. */
export interface SlackWorkflowTarget extends WorkflowSourceTarget {
  repositoryId: null;
  ownerId: string;
  teamId: string;
}

/** The channel types a rule can watch: public and private channels. Never a DM. */
const CHANNEL_TYPES = new Set(['channel', 'group']);

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * PURE: the facts one Slack event yields, or `[]`.
 *
 * Dropped, so no rule can see them:
 *  - anything but a channel or private channel message (a DM is the personal
 *    trigger's);
 *  - a message from a bot (`bot_id`), from Talyn's own bot user, or with a
 *    subtype that is not a person writing (an edit, a delete, a join);
 *  - an edit, however Slack marks it;
 *  - a message that mentions Talyn's bot. That message belongs to the
 *    personal @mention trigger, and one message must not start two sessions.
 *
 * `authorLinked` is false here and filled in by `prepare`, which can read the
 * database. `channelName` and `permalink` are filled in there too.
 */
export function slackFactsFromEvent(input: SlackWorkflowInput): SlackEventFacts[] {
  const e = input.event;
  if (str(e.type) !== 'message' || !CHANNEL_TYPES.has(str(e.channel_type))) return [];
  if (e.bot_id || e.edited || !PERSON_SUBTYPES.has(e.subtype as string | undefined)) return [];
  const userId = str(e.user);
  const channelId = str(e.channel);
  const ts = str(e.ts);
  if (!userId || !channelId || !ts || !input.teamId) return [];
  if (userId === input.botUserId) return [];
  const text = str(e.text);
  if (input.botUserId && mentionedUserIds(text).includes(input.botUserId)) return [];
  return [
    {
      integration: 'slack',
      event: 'slack_message',
      teamId: input.teamId,
      channelId,
      userId,
      text,
      ts,
      threadTs: str(e.thread_ts) || null,
      authorLinked: false,
    },
  ];
}

/**
 * The workspaces whose enabled Slack rules watch `teamId`, with their owners.
 *
 * The WHERE repeats the partial index `idx_workflows_slack_team` (0130) word
 * for word: the expression `conditions ->> 'slackTeamId'`, and the predicate
 * `integration = 'slack' AND enabled` written as LITERALS. A bound parameter
 * there cannot prove the index predicate under a generic plan, and the lookup
 * would scan every rule.
 *
 * It also requires that the workspace OWNER installed the app in this team or
 * linked a Slack account in it. A rule names a team id by hand, and a rule in
 * a stranger's workspace must not read another team's messages.
 *
 * Explicit columns only: never a rule's jsonb, never an install's tokens.
 */
export function slackTargetsQuery(teamId: string) {
  return getPoolDbClient()
    .selectDistinct({ workspaceId: workflowsTable.workspaceId, ownerId: workspacesTable.ownerId })
    .from(workflowsTable)
    .innerJoin(workspacesTable, eq(workspacesTable.id, workflowsTable.workspaceId))
    .where(
      and(
        sql`${workflowsTable.integration} = 'slack'`,
        sql`${workflowsTable.enabled}`,
        sql`(${workflowsTable.conditions} ->> 'slackTeamId') = ${teamId}`,
        sql`(EXISTS (SELECT 1 FROM ${slackInstallations}
                     WHERE ${slackInstallations.teamId} = ${teamId}
                       AND ${slackInstallations.installedByUserId} = ${workspacesTable.ownerId})
             OR EXISTS (SELECT 1 FROM ${slackUserLinks}
                        WHERE ${slackUserLinks.teamId} = ${teamId}
                          AND ${slackUserLinks.userId} = ${workspacesTable.ownerId}))`
      )
    );
}

/** Whether a Slack user has linked a Talyn account in this team. */
export async function slackAuthorLinked(teamId: string, slackUserId: string): Promise<boolean> {
  const rows = await getPoolDbClient()
    .select({ id: slackUserLinks.id })
    .from(slackUserLinks)
    .where(and(eq(slackUserLinks.teamId, teamId), eq(slackUserLinks.slackUserId, slackUserId)))
    .limit(1);
  return rows.length > 0;
}

function watchedChannels(workflows: WorkflowDefinition[]): Set<string> {
  const out = new Set<string>();
  for (const w of workflows) {
    for (const c of w.conditions.channels ?? []) out.add(c.trim().toLowerCase());
  }
  return out;
}

/**
 * The facts with what the event could not say. Once per message, whatever
 * number of workspaces watch it: the author link is a property of the Slack
 * team, and the channel name and permalink are Slack's. Best effort for the
 * Slack reads: a failure leaves the field absent and never fails the run.
 */
const enriched = new WeakMap<SlackEventFacts, Promise<SlackEventFacts>>();

function enrich(facts: SlackEventFacts): Promise<SlackEventFacts> {
  let pending = enriched.get(facts);
  if (!pending) {
    pending = (async () => {
      const [authorLinked, name, permalink] = await Promise.all([
        slackAuthorLinked(facts.teamId, facts.userId),
        channelName(facts.teamId, facts.channelId).catch(() => null),
        messagePermalink(facts.teamId, facts.channelId, facts.ts).catch(() => null),
      ]);
      return {
        ...facts,
        authorLinked,
        ...(name ? { channelName: name } : {}),
        ...(permalink ? { permalink } : {}),
      };
    })();
    enriched.set(facts, pending);
  }
  return pending;
}

export const slackWorkflowSource: WorkflowSourceAdapter<
  SlackWorkflowInput,
  SlackWorkflowTarget,
  SlackEventFacts
> = {
  integration: 'slack',

  facts: slackFactsFromEvent,

  deliveryId: (input) => `slack:${input.eventId}`,

  targets: async (input) => {
    const rows = await slackTargetsQuery(input.teamId);
    return rows.map((r) => ({
      workspaceId: r.workspaceId,
      repositoryId: null,
      ownerId: r.ownerId,
      teamId: input.teamId,
    }));
  },

  workspaceAllowed: workspaceMayUseSlackRules,

  prepare: async (_target, facts, workflows) => {
    // No rule here watches this channel: skip the Slack reads entirely.
    const channels = watchedChannels(workflows);
    const watched = facts.filter((f) => channels.has(f.channelId.toLowerCase()));
    if (watched.length === 0) return { facts: [] };
    return { facts: await Promise.all(watched.map(enrich)) };
  },

  actionContext: (_target, facts, base) => ({
    ...base,
    integration: 'slack',
    repositoryId: null,
    facts,
  }),

  // Slack has no account-wide gate the engine must wait on. A 429 carries its
  // own Retry-After, which the action reports as its retry time.
  blockedUntilMs: () => 0,

  describe: (input) => `message ${input.teamId}/${str(input.event.channel)} (${input.eventId})`,
};
