import { getFleetModelCatalog } from './index.js';
import type { Workbench, WorkbenchChat, WorkbenchDiffStat, WorkbenchSource } from './workbench.js';
import type { WorkbenchBackground } from './workbenchBackground.js';

/**
 * The facts a session's hover card shows (web and desktop sidebar) and the
 * long-press sheet shows on mobile: who runs it, where its sandbox is, where it
 * came from, what runs in the background and what it changed. Each app adds
 * the state, the pull request and the times with its own components.
 */
export type SessionGlanceTone = 'default' | 'success' | 'warning' | 'destructive';

export interface SessionGlanceFact {
  label: string;
  value: string;
  tone?: SessionGlanceTone;
}

type GlanceChat = Pick<WorkbenchChat, 'agent' | 'model' | 'updatedAt'>;

export type SessionGlanceWorkbench = Pick<Workbench, 'agent' | 'runtime' | 'status' | 'sandboxState' | 'diffStat'> &
  Partial<Pick<Workbench, 'uncommittedStats' | 'committedStats' | 'source' | 'error' | 'statusMessage'>>;

export interface SessionGlanceInput {
  workbench: SessionGlanceWorkbench;
  chats?: readonly GlanceChat[] | null;
  background?: Pick<WorkbenchBackground, 'jobs' | 'wakeups'> | null;
  /** True when the session has a pull request: its size replaces the committed changes. */
  hasPullRequest?: boolean;
}

const AGENT_NAME: Record<string, string> = { claude: 'Claude', codex: 'Codex' };

/** The catalogue label of a model id ("Opus 5.5"), or the id itself when the catalogue does not know it. */
export function glanceModelLabel(model: string): string {
  const catalog = getFleetModelCatalog();
  const id = catalog.retired[model] ?? model;
  return catalog.models.find((entry) => entry.id === id)?.label ?? model;
}

/** "Claude · Opus 5.5", from the chat that changed last. "· 3 chats" when there is more than one. */
export function agentGlance(agent: string, chats: readonly GlanceChat[] | null | undefined): string {
  const list = chats ?? [];
  const latest = list.reduce<GlanceChat | null>((best, chat) => (!best || chat.updatedAt > best.updatedAt ? chat : best), null);
  const name = AGENT_NAME[latest?.agent ?? agent] ?? latest?.agent ?? agent;
  const parts = [name];
  if (latest?.model) parts.push(glanceModelLabel(latest.model));
  if (list.length > 1) parts.push(`${list.length} chats`);
  return parts.join(' · ');
}

/** Where the session's code lives, and whether its sandbox is awake. Null when there is nothing to say. */
export function sandboxGlance(workbench: Pick<Workbench, 'runtime' | 'status' | 'sandboxState'>): SessionGlanceFact | null {
  if (workbench.runtime === 'local') return { label: 'Runs in', value: 'Local worktree' };
  if (workbench.status === 'moving') return { label: 'Sandbox', value: 'Moving to a fresh sandbox', tone: 'warning' };
  if (workbench.status === 'archived') return { label: 'Sandbox', value: 'Archived' };
  switch (workbench.sandboxState) {
    case 'creating':
      return { label: 'Sandbox', value: 'Starting' };
    case 'running':
      return { label: 'Sandbox', value: 'Awake', tone: 'success' };
    case 'suspended':
      return { label: 'Sandbox', value: 'Asleep, wakes when you send a message' };
    case 'lost':
      return { label: 'Sandbox', value: 'Lost', tone: 'warning' };
    case 'deleted':
      return { label: 'Sandbox', value: 'Deleted' };
    case 'error':
      return { label: 'Sandbox', value: 'Failed', tone: 'destructive' };
    default:
      return null;
  }
}

const RULE_INTEGRATION: Record<string, string> = {
  github: 'GitHub',
  slack: 'Slack',
  webhook: 'webhook',
  linear: 'Linear',
  github_issues: 'GitHub Issues',
};

/** What started the session when the app's composer did not. Null for the composer. */
export function sourceGlance(source: WorkbenchSource | null | undefined): string | null {
  if (!source) return null;
  switch (source.kind) {
    case 'slack': {
      if (source.channelId.startsWith('D')) return 'Slack DM';
      return source.channelName ? `Slack #${source.channelName}` : 'Slack';
    }
    case 'loop':
      return 'A scheduled rule';
    case 'workflow':
      return `A ${RULE_INTEGRATION[source.integration ?? 'github'] ?? 'GitHub'} rule`;
    case 'memory_review':
      return 'Memory review';
    default:
      return null;
  }
}

const MAX_REASON = 80;

/** Running jobs and scheduled wake-ups, one fact each. */
export function backgroundGlance(background: Pick<WorkbenchBackground, 'jobs' | 'wakeups'> | null | undefined): SessionGlanceFact[] {
  if (!background) return [];
  const facts: SessionGlanceFact[] = [];
  const running = background.jobs.filter((job) => job.status === 'running');
  if (running.length === 1) facts.push({ label: 'Job', value: `Running: ${running[0].name}`, tone: 'success' });
  else if (running.length > 1) facts.push({ label: 'Jobs', value: `${running.length} running`, tone: 'success' });
  const scheduled = background.wakeups.filter((wakeup) => wakeup.status === 'scheduled');
  if (scheduled.some((wakeup) => wakeup.ci)) {
    facts.push({ label: 'Wake-up', value: 'When CI finishes, the agent continues' });
  } else if (scheduled.length > 0) {
    const reason = scheduled[0].reason.trim();
    const short = reason.length > MAX_REASON ? `${reason.slice(0, MAX_REASON - 1)}…` : reason;
    facts.push({ label: 'Wake-up', value: short ? `Scheduled: ${short}` : 'Scheduled' });
  }
  return facts;
}

/** "+12 −3 in 4 files". Null when nothing changed. */
export function diffGlance(stats: WorkbenchDiffStat | null | undefined): string | null {
  if (!stats || stats.files <= 0) return null;
  return `+${stats.added} −${stats.removed} in ${stats.files} ${stats.files === 1 ? 'file' : 'files'}`;
}

/** "10 passed, 1 failed, 2 running". Null when the PR has no checks. */
export function checksGlance(
  checks: { total: number; passed: number; failed: number; inProgress: number; skipped: number } | null | undefined,
): string | null {
  if (!checks || checks.total <= 0) return null;
  const parts: string[] = [];
  if (checks.passed > 0) parts.push(`${checks.passed} passed`);
  if (checks.failed > 0) parts.push(`${checks.failed} failed`);
  if (checks.inProgress > 0) parts.push(`${checks.inProgress} running`);
  if (checks.skipped > 0) parts.push(`${checks.skipped} skipped`);
  return parts.length > 0 ? parts.join(', ') : `${checks.total} ${checks.total === 1 ? 'check' : 'checks'}`;
}

/** "+120 −30 in 8 files". Null when the counts are absent: an unknown size is not a zero-line diff. */
export function prSizeGlance(additions?: number | null, deletions?: number | null, files?: number | null): string | null {
  if (additions == null || deletions == null) return null;
  const lines = `+${additions} −${deletions}`;
  if (files == null) return lines;
  return `${lines} in ${files} ${files === 1 ? 'file' : 'files'}`;
}

/** The error that stopped the session, when it has one. */
export function errorGlance(workbench: Pick<SessionGlanceWorkbench, 'status' | 'error' | 'statusMessage'>): string | null {
  const text = workbench.error?.trim() || (workbench.status === 'error' ? workbench.statusMessage?.trim() : '');
  return text || null;
}

/** The session facts, in the order the card lists them. */
export function sessionGlanceFacts({ workbench, chats, background, hasPullRequest = false }: SessionGlanceInput): SessionGlanceFact[] {
  const facts: SessionGlanceFact[] = [];
  const error = errorGlance(workbench);
  if (error) facts.push({ label: 'Error', value: error, tone: 'destructive' });
  const uncommitted = diffGlance(workbench.uncommittedStats === undefined ? workbench.diffStat : workbench.uncommittedStats);
  if (uncommitted) facts.push({ label: 'Uncommitted', value: uncommitted });
  const committed = hasPullRequest ? null : diffGlance(workbench.committedStats);
  if (committed) facts.push({ label: 'Committed', value: `${committed}, no pull request yet` });
  facts.push(...backgroundGlance(background));
  facts.push({ label: 'Agent', value: agentGlance(workbench.agent, chats) });
  const sandbox = sandboxGlance(workbench);
  if (sandbox) facts.push(sandbox);
  const source = sourceGlance(workbench.source);
  if (source) facts.push({ label: 'Started from', value: source });
  return facts;
}
