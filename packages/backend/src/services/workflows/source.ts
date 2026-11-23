import type { WorkflowDefinition, WorkflowFacts, WorkflowIntegration } from '@talyn/shared';
import type { BaseActionContext, WorkflowActionContext } from './actions.js';

/**
 * A source adapter: what one integration contributes to the rules engine.
 *
 * The engine core (`engine.ts` → `evaluateWorkflows`) owns everything that is
 * the same for every integration: the flag gates, the enabled-rule read, the
 * matcher, the rate cap, the claim on `UNIQUE (workflow_id, delivery_id)`, the
 * action runner, the two-write settle and the analytics. An adapter owns only
 * what differs: how an inbound event becomes facts, which workspaces it
 * concerns, what to fill in or drop per workspace, and what an action needs
 * to know about its target.
 *
 * `sources/github.ts` is the GitHub adapter. The Slack adapter
 * (`sources/slack.ts`) implements this same interface.
 *
 * @typeParam Input  - the inbound event, as the caller hands it over.
 * @typeParam Target - one workspace the event concerns, plus whatever the
 *   adapter needs to act there.
 * @typeParam Facts  - this integration's member of the facts union.
 */
export interface WorkflowSourceAdapter<
  Input,
  Target extends WorkflowSourceTarget,
  Facts extends WorkflowFacts,
> {
  readonly integration: WorkflowIntegration;

  /**
   * PURE: the facts this event yields. `[]` for anything no rule can trigger
   * on. Never throws: an unmapped event must be inert on the hot path.
   */
  facts(input: Input): Facts[];

  /**
   * The id a redelivery of the same event repeats. The claim's unique index
   * keys on it, so a duplicate becomes a no-op.
   */
  deliveryId(input: Input): string;

  /** The workspaces this event concerns. */
  targets(input: Input, facts: Facts[]): Promise<Target[]>;

  /**
   * A per-workspace audience check, asked IN ADDITION to the workflows flag.
   * Absent means no extra gate.
   */
  workspaceAllowed?(workspaceId: string): Promise<boolean>;

  /**
   * Once per workspace, before matching: drop the facts this workspace must
   * not act on (Talyn hearing its own action back), fill in what the event
   * could not say, and return what the matcher needs beyond the facts.
   *
   * `workflows` are the workspace's enabled rules of THIS integration, so an
   * adapter can skip work no rule asks for.
   */
  prepare(target: Target, facts: Facts[], workflows: WorkflowDefinition[]): Promise<PreparedFacts<Facts>>;

  /** What the action runner needs, for one matched rule on one fact. */
  actionContext(target: Target, facts: Facts, base: BaseActionContext): WorkflowActionContext;

  /**
   * When the account's outbound rate gate clears (epoch ms), 0 when it is
   * open. A parked run is scheduled from it.
   */
  blockedUntilMs(target: Target): number;

  /** A one-line description of the event, for logs. */
  describe(input: Input): string;
}

/** The part of a target the core reads. */
export interface WorkflowSourceTarget {
  workspaceId: string;
  /** The repository the run is recorded against, when there is one. */
  repositoryId: string | null;
}

export interface PreparedFacts<Facts extends WorkflowFacts> {
  facts: Facts[];
  /** The workspace's GitHub login, for a `viewer` actor match. */
  viewerLogin?: string | null;
}
