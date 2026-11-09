import {
  DEFAULT_WORKBENCH_EFFORT, FLEET_MODELS, POSTHOG_CODE_MODELS, defaultFleetModelForAgent, resolveFleetModel,
  type WorkbenchChat, type WorkbenchEffort,
} from '@talyn/shared';

const AGENT_LABELS: Record<string, string> = { claude: 'Claude', codex: 'Codex' };
const EFFORT_LABELS: Record<WorkbenchEffort, string> = {
  low: 'Low effort', medium: 'Medium effort', high: 'High effort', xhigh: 'Extra-high effort', max: 'Max effort',
};
const MODEL_LABELS = new Map<string, string>([
  ...POSTHOG_CODE_MODELS.map((model) => [model.id, model.label] as const),
  ...FLEET_MODELS.map((model) => [model.id, model.label] as const),
]);

/** "Claude" or "Codex", like the web agent picker. An unknown agent keeps its own name. */
export function agentLabel(agent: string | null | undefined): string {
  if (!agent) return '';
  return AGENT_LABELS[agent] ?? agent.charAt(0).toUpperCase() + agent.slice(1);
}

/**
 * A model's name as the web pickers show it: `claude-opus-5-5` is "Opus 5.5".
 * No model means the agent's default, which is what the session runs.
 * An id outside the catalogue is made readable rather than shown raw.
 */
export function modelLabel(model: string | null | undefined, agent?: string | null): string {
  const id = model || (agent === 'codex' || agent === 'claude' ? defaultFleetModelForAgent(agent) : '');
  if (!id) return '';
  const known = MODEL_LABELS.get(id) ?? MODEL_LABELS.get(resolveFleetModel(id));
  if (known) return known;
  const claude = /^claude-([a-z]+)-(\d+(?:-\d+)*)/.exec(id);
  if (claude) return `${claude[1].charAt(0).toUpperCase()}${claude[1].slice(1)} ${claude[2].replace(/-/g, '.')}`;
  const gpt = /^gpt-([\d.]+)(?:-(.+))?$/.exec(id);
  if (gpt) return `GPT-${gpt[1]}${gpt[2] ? ` ${gpt[2].split('-').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' ')}` : ''}`;
  return id;
}

export function effortLabel(effort: WorkbenchEffort | null | undefined): string {
  return EFFORT_LABELS[effort ?? DEFAULT_WORKBENCH_EFFORT] ?? EFFORT_LABELS[DEFAULT_WORKBENCH_EFFORT];
}

/** One compact line for a chat: "Claude · Opus 5.5 · High effort · Plan mode". */
export function chatDetailsLine(chat: Pick<WorkbenchChat, 'agent' | 'model' | 'effort' | 'planMode'> | undefined, fallbackAgent?: string | null): string {
  const agent = chat?.agent ?? fallbackAgent ?? null;
  return [agentLabel(agent), modelLabel(chat?.model, agent), effortLabel(chat?.effort), chat?.planMode ? 'Plan mode' : '']
    .filter(Boolean).join(' · ');
}
