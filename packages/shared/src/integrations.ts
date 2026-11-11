import { loopsOffered } from './loops.js';
import { privateRoutesOffered } from './privateRoutes.js';
import { workflowsOffered } from './workflows.js';

/**
 * The Integrations area: one page per integration, each holding its
 * connection and its rules. Every front end draws the catalog from here.
 */
export type IntegrationKind = 'github' | 'slack' | 'schedule' | 'tailscale' | 'posthog' | 'trunk';

export const INTEGRATION_KINDS: readonly IntegrationKind[] = [
  'github',
  'slack',
  'schedule',
  'tailscale',
  'posthog',
  'trunk',
];

/** The account feature that decides whether an integration is offered. `null` means always. */
export type IntegrationGate = 'workbenches' | 'loops' | 'privateRoutes' | 'trunkMergeEta' | null;

export interface IntegrationInfo {
  kind: IntegrationKind;
  name: string;
  description: string;
  /** A key each client maps to its own icon. */
  icon: 'github' | 'slack' | 'clock' | 'network' | 'posthog' | 'trunk';
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
  slack: {
    kind: 'slack',
    name: 'Slack',
    description: 'An automation watches Slack messages and can start a session, reply or react.',
    icon: 'slack',
    hasRules: false,
    builtIn: false,
    gate: 'workbenches',
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
  return true;
}
