import { loopsOffered } from './loops.js';
import { privateRoutesOffered } from './privateRoutes.js';
import { issueRulesOffered, webhookRulesOffered, workflowsOffered } from './workflows.js';

/**
 * The Integrations area: one page per integration, each holding its
 * connection and its rules. Every front end draws the catalog from here.
 */
export type IntegrationKind =
  | 'github'
  | 'github_issues'
  | 'linear'
  | 'slack'
  | 'webhook'
  | 'schedule'
  | 'tailscale'
  | 'posthog'
  | 'trunk';

export const INTEGRATION_KINDS: readonly IntegrationKind[] = [
  'github',
  'github_issues',
  'linear',
  'slack',
  'webhook',
  'schedule',
  'tailscale',
  'posthog',
  'trunk',
];

/** The account feature that decides whether an integration is offered. `null` means always. */
export type IntegrationGate =
  | 'workbenches'
  | 'loops'
  | 'privateRoutes'
  | 'trunkMergeEta'
  | 'webhookRules'
  | 'issueRules'
  | null;

export interface IntegrationInfo {
  kind: IntegrationKind;
  name: string;
  description: string;
  /** A key each client maps to its own icon. */
  icon: 'github' | 'slack' | 'webhook' | 'clock' | 'network' | 'posthog' | 'trunk' | 'linear' | 'issues';
  /** True when the integration has rules (triggers that start work). */
  hasRules: boolean;
  /** True when there is nothing to connect: the integration is always on. */
  builtIn: boolean;
  gate: IntegrationGate;
}

export const INTEGRATION_CATALOG: Record<IntegrationKind, IntegrationInfo> = {
  github: {
    kind: 'github',
    name: 'GitHub',
    description: 'An automation watches pull request events and can label, comment, request reviewers, start a session and more.',
    icon: 'github',
    hasRules: true,
    builtIn: false,
    gate: null,
  },
  github_issues: {
    kind: 'github_issues',
    name: 'GitHub Issues',
    description: 'An automation watches GitHub issues and starts a session or a task. Talyn comments on the issue and closes it when the fix merges.',
    icon: 'issues',
    hasRules: true,
    // It uses the GitHub App connection. There is nothing else to connect.
    builtIn: true,
    gate: 'issueRules',
  },
  linear: {
    kind: 'linear',
    name: 'Linear',
    description: 'An automation watches Linear issues and starts a session or a task. Talyn comments on the issue and moves it to done when the fix merges.',
    icon: 'linear',
    hasRules: true,
    builtIn: false,
    gate: 'issueRules',
  },
  slack: {
    kind: 'slack',
    name: 'Slack',
    description: 'An automation watches Slack messages and can start a session, reply or react.',
    icon: 'slack',
    hasRules: false,
    builtIn: false,
    gate: 'workbenches',
  },
  webhook: {
    kind: 'webhook',
    name: 'Webhooks',
    description: 'An automation gets its own URL. A request to it starts a session or a task.',
    icon: 'webhook',
    hasRules: true,
    // Nothing to connect: each automation mints its own URL.
    builtIn: true,
    gate: 'webhookRules',
  },
  schedule: {
    kind: 'schedule',
    name: 'Schedule',
    description: 'An automation runs on a schedule and starts a session or a task.',
    icon: 'clock',
    hasRules: true,
    builtIn: true,
    gate: 'loops',
  },
  tailscale: {
    kind: 'tailscale',
    name: 'Tailscale',
    description: 'Let sandboxes reach private hosts on your tailnet.',
    icon: 'network',
    hasRules: false,
    builtIn: false,
    gate: 'privateRoutes',
  },
  posthog: {
    kind: 'posthog',
    name: 'PostHog Code',
    description: 'Run cloud tasks on PostHog Code and open pull requests.',
    icon: 'posthog',
    hasRules: false,
    builtIn: false,
    gate: null,
  },
  trunk: {
    kind: 'trunk',
    name: 'Trunk',
    description: 'Show merge queue estimates from Trunk.',
    icon: 'trunk',
    hasRules: false,
    builtIn: false,
    gate: 'trunkMergeEta',
  },
};

export function isIntegrationKind(value: unknown): value is IntegrationKind {
  return typeof value === 'string' && (INTEGRATION_KINDS as readonly string[]).includes(value);
}

type OfferedFeatures =
  | {
      workbenches?: boolean;
      loops?: boolean;
      privateRoutes?: boolean;
      trunkMergeEta?: boolean;
      workflows?: boolean;
      webhookRules?: boolean;
      issueRules?: boolean;
    }
  | null
  | undefined;

export function integrationOffered(features: OfferedFeatures, kind: IntegrationKind): boolean {
  if (!features) return false;
  switch (kind) {
    case 'slack':
      return features.workbenches === true;
    case 'schedule':
      return loopsOffered(features);
    case 'tailscale':
      return privateRoutesOffered(features);
    case 'trunk':
      return features.trunkMergeEta === true;
    case 'webhook':
      return webhookRulesOffered(features);
    case 'linear':
    case 'github_issues':
      return issueRulesOffered(features);
    default:
      return true;
  }
}

/** The integrations a client draws, in catalog order. Empty while features are unknown. */
export function integrationsOffered(features: OfferedFeatures): IntegrationKind[] {
  return INTEGRATION_KINDS.filter((kind) => integrationOffered(features, kind));
}

/** Whether the Rules section of an integration is drawn. GitHub rules ride the `workflows` gate. */
export function integrationRulesOffered(features: OfferedFeatures, kind: IntegrationKind): boolean {
  if (!INTEGRATION_CATALOG[kind].hasRules || !integrationOffered(features, kind)) return false;
  if (kind === 'github') return workflowsOffered(features);
  if (kind === 'webhook') return webhookRulesOffered(features);
  if (kind === 'linear' || kind === 'github_issues') return issueRulesOffered(features);
  return true;
}
