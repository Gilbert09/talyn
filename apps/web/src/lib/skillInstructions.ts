import type { AgentEvent } from '@talyn/shared';

/**
 * A `user` message that the agent's harness wrote, not the person.
 *
 * When Claude Code launches a skill, it adds the skill's SKILL.md to the
 * conversation as a `user` message after the Skill tool result. stream-json
 * marks it `isSynthetic: true`; Claude Code's own session files mark it
 * `isMeta: true`. Talyn's own record of what the person sent never carries
 * either flag, so it can never match here.
 */
export function isInjectedUserMessage(event: AgentEvent): boolean {
  if (event.type !== 'user' || event.talyn_user_message === true) return false;
  return event.isSynthetic === true || event.isMeta === true;
}

function injectedText(event: AgentEvent): string {
  const content = event.message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => {
      const block = b as { type?: unknown; text?: unknown };
      return block?.type === 'text' && typeof block.text === 'string' ? block.text : '';
    })
    .filter(Boolean)
    .join('\n\n');
}

/**
 * The text each launched skill added, keyed by the id of its Skill tool call.
 *
 * stream-json does not say which call an injected message belongs to, so it
 * goes to the oldest Skill call whose result has landed and that has no text
 * yet. An injected message with no such call (a hook's feedback, for example)
 * is left out.
 */
export function skillInstructionsByToolId(events: AgentEvent[]): Map<string, string> {
  const out = new Map<string, string>();
  const skillCalls = new Set<string>();
  const waiting: string[] = [];
  for (const event of events) {
    const content = event.message?.content;
    if (event.type === 'assistant' && Array.isArray(content)) {
      for (const b of content as Array<{ type?: unknown; name?: unknown; id?: unknown }>) {
        if (b?.type === 'tool_use' && b.name === 'Skill' && typeof b.id === 'string') skillCalls.add(b.id);
      }
    } else if (isInjectedUserMessage(event)) {
      const source = typeof event.sourceToolUseID === 'string' ? event.sourceToolUseID : null;
      const id = source && skillCalls.has(source) ? source : waiting.shift();
      if (source) {
        const at = waiting.indexOf(source);
        if (at !== -1) waiting.splice(at, 1);
      }
      const text = injectedText(event);
      if (id && text) out.set(id, text);
    } else if (event.type === 'user' && Array.isArray(content)) {
      for (const b of content as Array<{ type?: unknown; tool_use_id?: unknown }>) {
        if (b?.type === 'tool_result' && typeof b.tool_use_id === 'string' && skillCalls.has(b.tool_use_id)) {
          waiting.push(b.tool_use_id);
        }
      }
    }
  }
  return out;
}
