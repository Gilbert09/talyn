import type { FleetAgent } from './index.js';

export type FleetAccountKind = 'claude_oauth' | 'anthropic_key' | 'codex_oauth' | 'openai_key';

export interface FleetAccountView {
  id: string;
  agent: FleetAgent;
  kind: FleetAccountKind;
  label: string;
  priority: number;
  needsReauth: boolean;
  held: { until: string | null } | null;
  usage:
    | { fetchedAt: string; windows: { key: string; label: string; usedPercent: number; resetsAt: string | null }[] }
    | { fetchedAt: string; error: string }
    | null;
  over: boolean;
}

export interface FleetAccountsResponse {
  accounts: FleetAccountView[];
  switchAtPercent: number;
  active: Record<FleetAgent, string | null>;
}
