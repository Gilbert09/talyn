import type { ToolBlock, WorkbenchEvent } from '@talyn/shared';
import { createContext, useContext } from 'react';

/** The seq of the event that holds a tool call: block keys are `<seq>.<index>`. */
export function toolSeq(tool: Pick<ToolBlock, 'key'>): number | null {
  const seq = Number(tool.key.split('.')[0]);
  return Number.isSafeInteger(seq) && seq > 0 ? seq : null;
}

/**
 * The tool call with its whole input and result, read from stored events. Returns null when
 * neither the call nor its result is among them.
 */
export function fullToolFrom(tool: ToolBlock, events: WorkbenchEvent[]): ToolBlock | null {
  if (!tool.toolId) return null;
  let input: unknown; let output: unknown; let foundInput = false; let foundOutput = false;
  for (const entry of events) {
    const content = (entry.event.message as { content?: unknown } | undefined)?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      const part = block as { type?: unknown; id?: unknown; input?: unknown; tool_use_id?: unknown; content?: unknown };
      if (entry.event.type === 'assistant' && part?.type === 'tool_use' && part.id === tool.toolId) { input = part.input ?? {}; foundInput = true; }
      if (entry.event.type === 'user' && part?.type === 'tool_result' && part.tool_use_id === tool.toolId) { output = part.content ?? ''; foundOutput = true; }
    }
    if (foundInput && foundOutput) break;
  }
  if (!foundInput && !foundOutput) return null;
  // A stopped call keeps its empty output, as `buildBlocks` gives it.
  return { ...tool, input: foundInput ? input : tool.input, output: foundOutput && !tool.stopped ? output : tool.output };
}

/** What the transcript offers its rows. Absent outside a conversation, where rows show only what they hold. */
export interface TranscriptActions { loadFullTool(tool: ToolBlock): Promise<ToolBlock | null> }
export const TranscriptContext = createContext<TranscriptActions | null>(null);
export const useTranscriptActions = () => useContext(TranscriptContext);
