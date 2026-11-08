/**
 * The transcript block model, shared by every surface that renders an agent run.
 *
 * The event stream is event-shaped; a reader wants a block shape — one card per
 * assistant turn, tool call, permission prompt or result. `buildBlocks`
 * collapses the flat list into that, pairing each `tool_result` back to the
 * `tool_use` that caused it so a collapsed row can say what the tool DID rather
 * than dumping its bytes.
 *
 * It lives here because three apps render the same stream and the logic is
 * pure. apps/web and apps/desktop carried byte-identical copies of it; the
 * admin console needed a third, which is the point at which a copy becomes a
 * bug waiting to be fixed twice.
 *
 * Deliberately free of React and of any HTML rendering. The admin console shows
 * cross-tenant data and renders transcripts as text on purpose, so the shared
 * layer must not decide how text becomes markup.
 */
import type { AgentEvent } from './index.js';
import { adoptedPullRequestMessage, parseAutoPrDetails } from './workbenchPullRequest.js';
import { memoryChangeText, parseMemoryChangeEvent, type MemoryChangeEvent } from './workbenchMemory.js';
import { messageTrigger, type WorkbenchMessageTrigger } from './workbenchBackground.js';
import { isTalynOriginMessage, parseThreadSessionEvent, threadSessionEventText, type ThreadSessionEvent } from './workbenchThread.js';

const INTERRUPTED_MESSAGES = new Set([
  '[Request interrupted by user]',
  '[Request interrupted by user for tool use]',
]);
const REJECTED_TOOL_PREFIX = "The user doesn't want to proceed with this tool use.";

export function isClaudeInterruptionText(text: string): boolean {
  return INTERRUPTED_MESSAGES.has(text.trim());
}

export function isClaudeInterruptionEvent(event: AgentEvent): boolean {
  if (event.type !== 'user') return false;
  const content = (event.message as { content?: unknown })?.content;
  if (typeof content === 'string') return isClaudeInterruptionText(content);
  return Array.isArray(content) && content.length > 0 &&
    content.every((block) => block?.type === 'text' && typeof block.text === 'string') &&
    isClaudeInterruptionText(content.map((block) => block.text).join('\n'));
}

export function isClaudeRejectedToolResult(content: unknown, isError: boolean): boolean {
  if (!isError) return false;
  const text = typeof content === 'string'
    ? content
    : Array.isArray(content) && content[0]?.type === 'text'
      ? content[0].text
      : null;
  return typeof text === 'string' && text.trimStart().startsWith(REJECTED_TOOL_PREFIX);
}

// ---------------------------------------------------------------------------
// Block model — the transcript is event-stream shaped; the renderer wants a
// block-stream shape (one "card" per assistant turn, tool call, permission
// prompt, etc.). `buildBlocks` collapses a flat event list into this shape.
// ---------------------------------------------------------------------------

export type Block =
  | { kind: 'text'; key: string; text: string }
  | { kind: 'thinking'; key: string; text: string }
  | { kind: 'tool_use'; key: string; toolId: string; name: string; input: unknown }
  | {
      kind: 'tool_result';
      key: string;
      toolId: string;
      content: unknown;
      isError: boolean;
      stopped?: boolean;
      /** Filled in at buildBlocks time by pairing with the preceding tool_use. */
      toolName?: string;
      toolInput?: unknown;
    }
  | {
      kind: 'permission';
      key: string;
      requestId: string;
      toolName: string;
      toolInput: unknown;
      status: 'pending' | 'allowed' | 'denied' | 'auto_allowed';
      persist?: boolean;
    }
  | {
      kind: 'system';
      key: string;
      text: string;
      subtype?: string;
      url?: string;
      isError?: boolean;
      /** Set for `subtype: 'talyn_memory'`, so a card can link to the entry. */
      memory?: MemoryChangeEvent;
      /** Set for `subtype: 'talyn_thread'`, so a card can link to the session. */
      thread?: ThreadSessionEvent;
      /** Set for an ok `subtype: 'talyn_pr'`, so a card can show the PR. `title` is the agent's own, when its reply had one. */
      pullRequest?: { number: number; title?: string; existing: boolean; adopted: boolean };
      /** Set for `subtype: 'talyn_message'` when a wake-up or a job exit started the turn. `text` is then the full message body. */
      trigger?: WorkbenchMessageTrigger;
    }
  | {
      kind: 'result';
      key: string;
      summary: string;
      costUsd?: number;
      inputTokens?: number;
      outputTokens?: number;
      isError: boolean;
      denials: number;
    };

/**
 * Talyn's own notes to the person about the session: shown as plain lines,
 * with no label. The sandbox and account notes were stored but not shown
 * until the resize note needed them.
 */
export const SESSION_NOTE_SUBTYPES: ReadonlySet<string> = new Set([
  'talyn_imported',
  'pr_merged_archive',
  'sandbox_moved',
  'sandbox_resize_failed',
  'sandbox_size_fallback',
  'sandbox_low_disk',
  'sandbox_processes_stopped',
  'fleet_account_switched',
  'agent_limit_switch',
  'local_turn_interrupted',
  'sandbox_capacity_wait',
  'agent_session_reset',
]);

export function buildBlocks(events: AgentEvent[]): Block[] {
  const blocks: Block[] = [];
  let interruptionOpen = false;
  const interrupt = (key: string) => {
    if (!interruptionOpen) blocks.push({ kind: 'system', key, text: 'Interrupted', subtype: 'talyn_interruption' });
    interruptionOpen = true;
  };
  const permissionByRequestId = new Map<string, number>(); // requestId → blocks index
  // Pair tool_result → tool_use by tool_use_id so the collapsed result
  // row can say "Read 40 lines from <file>" instead of dumping bytes.
  const toolUseById = new Map<string, { name: string; input: unknown }>();
  // Live-stream accumulator. The CLI emits `stream_event`s with
  // incremental `content_block_delta`s as Claude writes; the full
  // `assistant` event only lands when the turn is DONE. Until Slice 4c
  // polish we were skipping stream_events entirely, so the terminal
  // stayed blank for several seconds per turn. Now: accumulate the
  // text deltas into a tail block that the user sees grow in real
  // time. When the canonical `assistant` event arrives we reset the
  // accumulator and let the assistant path below render the final content as
  // normal blocks — unconditionally, not on an id match; see the note there.
  let streamingText = '';
  // The title of the latest auto-PR details block, for the card the opened PR gets.
  let lastPrTitle: string | undefined;
  let streamingMsgId: string | undefined;

  for (const event of events) {
    const seqKey = String(event.seq);
    if (event.type !== 'user' && !(event.type === 'system' && event.subtype === 'talyn_interruption')) interruptionOpen = false;

    if (event.type === 'talyn_permission_request') {
      const reqId = String((event as { requestId?: unknown }).requestId ?? '');
      const idx = blocks.length;
      permissionByRequestId.set(reqId, idx);
      blocks.push({
        kind: 'permission',
        key: `perm-${reqId}`,
        requestId: reqId,
        toolName: String((event as { tool_name?: unknown }).tool_name ?? 'unknown'),
        toolInput: (event as { tool_input?: unknown }).tool_input,
        status: 'pending',
      });
      continue;
    }

    if (event.type === 'talyn_permission_auto_allowed') {
      const reqId = String((event as { requestId?: unknown }).requestId ?? '');
      blocks.push({
        kind: 'permission',
        key: `perm-${reqId}`,
        requestId: reqId,
        toolName: String((event as { tool_name?: unknown }).tool_name ?? 'unknown'),
        toolInput: (event as { tool_input?: unknown }).tool_input,
        status: 'auto_allowed',
      });
      continue;
    }

    if (event.type === 'talyn_permission_response') {
      const reqId = String((event as { requestId?: unknown }).requestId ?? '');
      const idx = permissionByRequestId.get(reqId);
      if (idx !== undefined) {
        const existing = blocks[idx];
        if (existing && existing.kind === 'permission') {
          const dec = String((event as { decision?: unknown }).decision ?? 'deny');
          existing.status = dec === 'allow' ? 'allowed' : 'denied';
          existing.persist = Boolean((event as { persist?: unknown }).persist);
        }
      }
      continue;
    }

    if (event.type === 'assistant') {
      // Finalise any in-flight streaming text: the assistant event carries the
      // canonical content, so stop appending deltas to the tail block (the
      // path below pushes proper text/tool_use/thinking blocks instead).
      //
      // ANY assistant event ends the streamed turn, matching id or not.
      //
      // This used to reset only when `message.id` matched the id captured at
      // `message_start`. Both halves of that can be absent: the fleet's guest
      // converter emits `id: msg.responseId ?? undefined`, and a provider that
      // sends deltas without a `message_start` never sets `streamingMsgId` at
      // all. Either way the accumulator was never cleared, so it kept every
      // turn's text for the whole run and the tail block rendered all of it
      // concatenated — each assistant message appearing twice, once in place
      // and once again, run together, at the bottom of the transcript.
      //
      // Resetting unconditionally is also right when the ids DO differ: an
      // assistant event means the canonical content is now in proper blocks,
      // so whatever is in the accumulator is stale by definition.
      streamingText = '';
      streamingMsgId = undefined;
      const content = (event.message as { content?: unknown })?.content;
      if (!Array.isArray(content)) continue;
      for (let i = 0; i < content.length; i++) {
        const b = content[i] as {
          type?: string;
          text?: string;
          thinking?: string;
          id?: string;
          name?: string;
          input?: unknown;
        };
        if (b.type === 'text' && b.text) {
          const details = parseAutoPrDetails(b.text);
          if (details.ok) lastPrTitle = details.details.title;
          blocks.push({ kind: 'text', key: `${seqKey}.${i}`, text: b.text });
        } else if (b.type === 'thinking' && b.thinking) {
          blocks.push({ kind: 'thinking', key: `${seqKey}.${i}`, text: b.thinking });
        } else if (b.type === 'tool_use') {
          const id = String(b.id ?? '');
          const name = String(b.name ?? 'unknown');
          const inp = b.input ?? {};
          if (id) toolUseById.set(id, { name, input: inp });
          blocks.push({
            kind: 'tool_use',
            key: `${seqKey}.${i}`,
            toolId: id,
            name,
            input: inp,
          });
        }
      }
      continue;
    }

    if (event.type === 'user') {
      const content = (event.message as { content?: unknown })?.content;
      if (isClaudeInterruptionEvent(event)) {
        interrupt(`${seqKey}.interrupted`);
        continue;
      }
      if (!Array.isArray(content)) {
        interruptionOpen = false;
        continue;
      }
      // A message Talyn wrote to wake a thread: a card, not the person's bubble.
      if (isTalynOriginMessage((event as { talyn?: unknown }).talyn)) {
        const text = content
          .map((part) => (part as { type?: unknown; text?: unknown }))
          .filter((part) => part.type === 'text' && typeof part.text === 'string')
          .map((part) => part.text as string)
          .join('\n');
        const trigger = messageTrigger((event as { talyn?: unknown }).talyn);
        blocks.push({ kind: 'system', key: seqKey, subtype: 'talyn_message', text, ...(trigger ? { trigger } : {}) });
        interruptionOpen = false;
        continue;
      }
      for (let i = 0; i < content.length; i++) {
        const b = content[i] as {
          type?: string;
          content?: unknown;
          tool_use_id?: string;
          is_error?: boolean;
        };
        if (b.type === 'tool_result') {
          const toolId = String(b.tool_use_id ?? '');
          const paired = toolId ? toolUseById.get(toolId) : undefined;
          const stopped = isClaudeRejectedToolResult(b.content, b.is_error === true);
          blocks.push({
            kind: 'tool_result',
            key: `${seqKey}.${i}`,
            toolId,
            content: stopped ? '' : b.content ?? '',
            isError: Boolean(b.is_error) && !stopped,
            stopped,
            toolName: paired?.name,
            toolInput: paired?.input,
          });
          if (stopped) interrupt(`${seqKey}.${i}.interrupted`);
          else interruptionOpen = false;
        } else {
          interruptionOpen = false;
        }
      }
      continue;
    }

    if (event.type === 'result') {
      const usage = (event.usage as { input_tokens?: number; output_tokens?: number }) ?? {};
      blocks.push({
        kind: 'result',
        key: seqKey,
        summary: String(event.result ?? ''),
        costUsd: event.total_cost_usd,
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        isError: Boolean(event.is_error),
        denials: event.permission_denials?.length ?? 0,
      });
      continue;
    }

    if (event.type === 'talyn_pr_link') {
      blocks.push({
        kind: 'system',
        key: seqKey,
        subtype: 'talyn_pr_link',
        text: `${event.linked === true ? 'Linked' : 'Unlinked'} PR #${event.number}`,
      });
      continue;
    }

    // A session saved or forgot a memory entry.
    if (event.type === 'talyn_memory') {
      const memory = parseMemoryChangeEvent(event as Record<string, unknown>);
      if (memory) blocks.push({ kind: 'system', key: seqKey, subtype: 'talyn_memory', text: memoryChangeText(memory), memory });
      continue;
    }

    // A session changed, or the thread paused its automatic turns.
    if (event.type === 'talyn_thread') {
      const thread = parseThreadSessionEvent(event as Record<string, unknown>);
      if (thread) {
        blocks.push({
          kind: 'system',
          key: seqKey,
          subtype: 'talyn_thread',
          text: threadSessionEventText(thread),
          thread,
          ...(thread.prUrl ? { url: thread.prUrl } : {}),
          ...(thread.action === 'session_finished' && thread.status === 'error' ? { isError: true } : {}),
        });
      }
      continue;
    }

    // What a workbench's Create PR turn did, as one line.
    if (event.type === 'talyn_pr') {
      const pr = event as {
        ok?: unknown;
        number?: unknown;
        url?: unknown;
        existing?: unknown;
        adopted?: unknown;
        message?: unknown;
      };
      const ok = pr.ok === true && typeof pr.number === 'number';
      blocks.push({
        kind: 'system',
        key: seqKey,
        subtype: 'talyn_pr',
        text: !ok
          ? String(pr.message ?? 'Could not open the pull request.')
          : pr.adopted === true
            ? adoptedPullRequestMessage(pr.number as number)
            : `${pr.existing === true ? 'Linked the open pull request' : 'Opened pull request'} #${pr.number}`,
        ...(ok && typeof pr.url === 'string' ? { url: pr.url } : {}),
        ...(ok
          ? {
              pullRequest: {
                number: pr.number as number,
                ...(lastPrTitle ? { title: lastPrTitle } : {}),
                existing: pr.existing === true,
                adopted: pr.adopted === true,
              },
            }
          : {}),
        isError: !ok,
      });
      continue;
    }

    // System events we actually want to show: stderr, spawn_error, and
    // the truncation marker. Drop init / status / etc — they're noise
    // in a conversation view.
    if (event.type === 'system') {
      if (event.subtype === 'talyn_interruption') {
        interrupt(seqKey);
        continue;
      }
      // Session notes have no label prefix.
      if (SESSION_NOTE_SUBTYPES.has(String(event.subtype ?? ''))) {
        blocks.push({ kind: 'system', key: seqKey, text: String((event as { text?: unknown }).text ?? '') });
        continue;
      }
      // The box-refusal notes (usage billing) keep their subtype: the clients
      // draw them as a notice with the plan's action, not as a log line.
      const show = ['stderr', 'spawn_error', 'truncated', 'usage_exhausted', 'box_limit_reached', 'size_requires_pro'].includes(
        String(event.subtype ?? ''),
      );
      if (show) {
        blocks.push({
          kind: 'system',
          key: seqKey,
          text: String((event as { text?: unknown }).text ?? event.subtype ?? ''),
          subtype: event.subtype,
        });
      }
      continue;
    }

    if (event.type === 'stream_event') {
      const inner = event.event as
        | {
            type?: string;
            message?: { id?: string };
            delta?: { type?: string; text?: string };
          }
        | undefined;
      if (!inner) continue;
      if (inner.type === 'message_start' && inner.message?.id) {
        // New turn starting — reset the accumulator. The message id
        // lets us match this streaming session to its forthcoming
        // `assistant` event.
        streamingMsgId = inner.message.id;
        streamingText = '';
        continue;
      }
      if (
        inner.type === 'content_block_delta' &&
        inner.delta?.type === 'text_delta' &&
        typeof inner.delta.text === 'string'
      ) {
        streamingText += inner.delta.text;
        continue;
      }
      continue;
    }

    // `rate_limit_event` and anything else unrecognised: suppressed.
  }

  // If the latest turn is still in-flight (assistant event hasn't
  // landed yet), show the accumulated streaming text as a tail block
  // so the user sees the response building in real time.
  if (streamingText) {
    blocks.push({
      kind: 'text',
      key: `stream-${streamingMsgId ?? 'live'}`,
      text: streamingText,
    });
  }

  return blocks;
}

/**
 * Cheap render-affecting signature for a block. Most blocks are
 * immutable once created (their `key` encodes the source event's seq +
 * index), so the key alone is a stable identity. The two exceptions:
 *  - permission cards mutate in place (pending → allowed/denied), and
 *  - the live streaming-text tail grows token by token.
 * Including those mutable fields lets React.memo skip every settled
 * block on each per-frame transcript update while still re-rendering
 * the handful that actually changed.
 *
 * "The key alone is a stable identity" is true WITHIN one transcript and
 * false across two. `seq` restarts at 1 for every cloud run, so block
 * `"3.0"` of one task and block `"3.0"` of another are different content
 * behind identical keys. React then reconciles the old element onto the
 * new one by key, this comparator reports no change, and the previous
 * task's tool calls stay on screen under the new task's header — three
 * concurrent PR tasks all appeared to be working on the same PR.
 *
 * `scopeId` is what makes the identity whole. The mount site also keys
 * TaskTerminal by task id so this cannot arise there any more, but a
 * signature that is only correct because of where it happens to be
 * called from is a trap for the next caller.
 */
export function blockSignature(block: Block): string {
  switch (block.kind) {
    case 'permission':
      return `${block.key}|${block.status}|${block.persist ? 1 : 0}`;
    case 'text':
      // Settled text blocks have a stable key + length; the streaming
      // tail keeps the same key while its length grows.
      return `${block.key}|${block.text.length}`;
    default:
      return block.key;
  }
}

// ---------------------------------------------------------------------------
// Tool description
// ---------------------------------------------------------------------------

/**
 * What a tool call actually did, in two parts: a short verb and its subject.
 *
 * # Why this is normalised rather than switched on verbatim
 *
 * Every provider names the same tools differently. Claude Code emits TitleCase
 * (`Bash`, `Read`, `Grep`); the fleet's guest harness emits Pi's lowercase set
 * (`bash`, `read`, `grep`); PostHog's ACP stream carries whatever
 * `_meta.claudeCode.toolName` or the update's `title`/`kind` happens to say.
 * The renderer used to switch on the TitleCase names alone, so a fleet run —
 * every fleet run — missed every case and fell through to a generic
 * `key=value` dump of the first two arguments. That is how a transcript ends up
 * reading `bash command=cd /work && rm -rf posthog && git clone --depth` with
 * the command severed mid-word.
 *
 * Argument keys vary the same way (`command` vs `cmd` vs `script`, `file_path`
 * vs `path`), so the subject is looked up by a candidate list too.
 *
 * Returns the FULL subject, un-truncated. Clamping is the renderer's business —
 * a terminal wants one CSS-ellipsised line with the whole thing in a tooltip,
 * and the admin console wants a hard character cap. Neither is served by the
 * other's choice being baked in here.
 */
export interface ToolDescription {
  /** Canonical short verb: `bash`, `read`, `edit`, `grep`, … */
  label: string;
  /** What it acted on — a command, a path, a pattern. May be empty. */
  detail: string;
  /** True when `detail` is a shell command, so a renderer can style it as one. */
  isCommand: boolean;
}

/** Canonical verb per known alias. Lowercased, non-alphanumerics stripped. */
const TOOL_ALIASES: Record<string, string> = {
  bash: 'bash', shell: 'bash', sh: 'bash', run: 'bash', runcommand: 'bash',
  exec: 'bash', execute: 'bash', executecommand: 'bash', terminal: 'bash',
  read: 'read', readfile: 'read', viewfile: 'read', view: 'read', open: 'read', cat: 'read',
  write: 'write', writefile: 'write', createfile: 'write', create: 'write',
  edit: 'edit', multiedit: 'edit', strreplace: 'edit', strreplaceeditor: 'edit',
  applypatch: 'edit', patch: 'edit', editfile: 'edit', update: 'edit',
  grep: 'grep', search: 'grep', ripgrep: 'grep', searchfiles: 'grep', findintext: 'grep',
  glob: 'glob', find: 'glob', findfiles: 'glob', listfiles: 'list', ls: 'list', list: 'list',
  webfetch: 'fetch', fetch: 'fetch', httpget: 'fetch', browse: 'fetch',
  websearch: 'websearch', searchweb: 'websearch',
  task: 'agent', agent: 'agent', subagent: 'agent', dispatchagent: 'agent',
  todowrite: 'todo', todoread: 'todo', updatetodos: 'todo',
  notebookedit: 'edit',
  fleetpublish: 'publish', publish: 'publish',
};

/** Which argument holds the subject, per canonical verb, most-specific first. */
const DETAIL_KEYS: Record<string, string[]> = {
  bash: ['command', 'cmd', 'script', 'shell', 'input'],
  read: ['file_path', 'filePath', 'path', 'file', 'filename', 'target_file'],
  write: ['file_path', 'filePath', 'path', 'file', 'filename', 'target_file'],
  edit: ['file_path', 'filePath', 'notebook_path', 'path', 'file', 'filename', 'target_file'],
  grep: ['pattern', 'query', 'q', 'regex', 'search'],
  glob: ['pattern', 'glob', 'path', 'query'],
  list: ['path', 'dir', 'directory', 'file_path'],
  fetch: ['url', 'uri', 'href'],
  websearch: ['query', 'q', 'search'],
  agent: ['description', 'prompt', 'task', 'instruction'],
  publish: ['branch', 'message'],
};

/** Lowercase and strip separators so `str_replace`, `strReplace` and
 *  `STR-REPLACE` all reach the same entry. */
function normaliseToolName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * The first argument worth showing, as text.
 *
 * SCALARS, not just strings. An MCP tool is commonly called with one numeric
 * argument — `mcp__fleet__get_pull_request({ number: 73784 })` — and taking
 * strings only meant that row rendered with no subject at all, which is how a
 * transcript comes to show three different PRs' tool calls as identical lines.
 *
 * Objects and arrays are skipped deliberately: inlining one is unreadable at
 * this size, and a row saying nothing beats a row saying `[object Object]`.
 */
function firstScalar(input: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = input[k];
    if (typeof v === 'string' && v.trim()) return v;
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
    if (typeof v === 'boolean') return String(v);
  }
  return '';
}

// ---------------------------------------------------------------------------
// Shell command classification
// ---------------------------------------------------------------------------

export interface ShellClassification {
  /** `bash` when the command is not a single recognisable read/search/list. */
  verb: 'bash' | 'read' | 'grep' | 'glob' | 'list';
  /** The pattern or path for a classified command; the unwrapped command for `bash`. */
  detail: string;
}

/**
 * Split a command into words the way a shell would, or null when it contains
 * an unquoted operator (pipe, list, redirect, substitution, newline). Being
 * conservative here is the point: a command we cannot read as ONE simple
 * command must stay a command.
 */
function tokenizeShell(input: string): string[] | null {
  const tokens: string[] = [];
  let cur = '';
  let has = false;
  let i = 0;
  while (i < input.length) {
    const c = input[i];
    if (c === "'") {
      const end = input.indexOf("'", i + 1);
      if (end < 0) return null;
      cur += input.slice(i + 1, end);
      has = true;
      i = end + 1;
    } else if (c === '"') {
      i++;
      let closed = false;
      while (i < input.length) {
        const d = input[i];
        if (d === '\\' && i + 1 < input.length && '"\\$`'.includes(input[i + 1])) {
          cur += input[i + 1];
          i += 2;
        } else if (d === '"') {
          closed = true;
          i++;
          break;
        } else if (d === '`' || (d === '$' && input[i + 1] === '(')) {
          return null;
        } else {
          cur += d;
          i++;
        }
      }
      if (!closed) return null;
      has = true;
    } else if (c === '\\') {
      if (i + 1 >= input.length) return null;
      cur += input[i + 1];
      has = true;
      i += 2;
    } else if (/\s/.test(c)) {
      if (c === '\n') return null;
      if (has) tokens.push(cur);
      cur = '';
      has = false;
      i++;
    } else if ('|;&<>`'.includes(c) || (c === '$' && input[i + 1] === '(')) {
      return null;
    } else {
      cur += c;
      has = true;
      i++;
    }
  }
  if (has) tokens.push(cur);
  return tokens;
}

const SHELL_NAMES = new Set(['bash', 'sh', 'zsh', 'dash']);
const CD_PREFIX = /^\s*cd\s+(?:'[^']*'|"[^"]*"|[^\s;&|]+)\s*&&\s*/;

/** `bash -lc 'x'` → `x`; null when `command` is not exactly one shell wrapper. */
function unwrapShell(command: string): string | null {
  const tokens = tokenizeShell(command.trim());
  if (!tokens || tokens.length < 3 || !SHELL_NAMES.has(tokens[0].split('/').pop() ?? '')) return null;
  const flagIdx = tokens.findIndex((t, i) => i > 0 && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(t));
  if (flagIdx < 0 || flagIdx !== tokens.length - 2) return null;
  if (tokens.slice(1, flagIdx).some((t) => !t.startsWith('-'))) return null;
  return tokens[flagIdx + 1];
}

/** Strip shell wrappers (twice at most), keeping any `cd` prefix. */
function unwrapCommand(command: string): string {
  let cur = command.trim();
  for (let n = 0; n < 2; n++) {
    const inner = unwrapShell(cur);
    if (inner === null) break;
    cur = inner.trim();
  }
  return cur;
}

const GREP_VALUE_FLAGS = new Set([
  '-g', '--glob', '-t', '--type', '-T', '--type-not', '-A', '-B', '-C', '-m', '--max-count', '-d',
  '--max-depth', '-j', '--threads', '--type-add', '-f', '--file', '--include', '--exclude',
  '--exclude-dir', '--context', '--after-context', '--before-context', '--max-columns', '--sort',
]);

function isFlag(t: string): boolean {
  return t.length > 1 && t.startsWith('-');
}

function lastNonFlag(args: string[], valueFlags: ReadonlySet<string> = new Set()): string | undefined {
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--') {
      rest.push(...args.slice(i + 1));
      break;
    }
    if (isFlag(args[i])) {
      if (valueFlags.has(args[i])) i++;
      continue;
    }
    rest.push(args[i]);
  }
  return rest[rest.length - 1];
}

function nonFlags(args: string[], valueFlags: ReadonlySet<string>): string[] {
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--') {
      rest.push(...args.slice(i + 1));
      break;
    }
    if (isFlag(args[i])) {
      if (valueFlags.has(args[i])) i++;
      continue;
    }
    rest.push(args[i]);
  }
  return rest;
}

/**
 * Read a shell command as what it DOES, when it is one plain read, search or
 * listing. Everything else stays `bash`, with the shell wrapper removed so the
 * row shows the command and not `bash -lc '…'`.
 *
 * Done at render time on purpose: a stored Codex transcript gets the same
 * treatment as a new one.
 */
export function classifyShellCommand(cmd: string): ShellClassification {
  const unwrapped = unwrapCommand(cmd);
  const fallback: ShellClassification = { verb: 'bash', detail: unwrapped };
  const inner = unwrapped.replace(CD_PREFIX, '');
  const tokens = tokenizeShell(inner);
  if (!tokens || tokens.length === 0) return fallback;

  const name = tokens[0].split('/').pop() ?? '';
  const args = tokens.slice(1);

  switch (name) {
    case 'rg':
    case 'grep':
    case 'egrep':
    case 'fgrep':
    case 'ag':
    case 'ack': {
      if (args.includes('--files')) {
        const dir = lastNonFlag(args, GREP_VALUE_FLAGS);
        return { verb: 'glob', detail: dir ?? '' };
      }
      let pattern: string | undefined;
      for (let i = 0; i < args.length; i++) {
        if ((args[i] === '-e' || args[i] === '--regexp') && i + 1 < args.length) {
          pattern = args[i + 1];
          break;
        }
        if (args[i].startsWith('--regexp=')) {
          pattern = args[i].slice('--regexp='.length);
          break;
        }
      }
      if (pattern === undefined) {
        const values = new Set(GREP_VALUE_FLAGS);
        values.add('-e');
        values.add('--regexp');
        pattern = nonFlags(args, values)[0];
      }
      return pattern ? { verb: 'grep', detail: pattern } : fallback;
    }
    case 'sed': {
      const inPlace = args.some((a) => a === '--in-place' || /^-[a-zA-Z]*i/.test(a) || a.startsWith('--in-place='));
      const quiet = args.some((a) => a === '-n' || a === '--quiet' || a === '--silent' || /^-[a-zA-Z]*n[a-zA-Z]*$/.test(a));
      const files = nonFlags(args, new Set(['-e', '-f', '--expression', '--file']));
      if (inPlace || !quiet || files.length < 2) return fallback;
      return { verb: 'read', detail: files[files.length - 1] };
    }
    case 'cat':
    case 'head':
    case 'tail':
    case 'nl':
    case 'bat': {
      const file = lastNonFlag(args, new Set(['-n', '-c', '--lines', '--bytes']));
      return file ? { verb: 'read', detail: file } : fallback;
    }
    case 'ls':
      return { verb: 'list', detail: lastNonFlag(args) ?? '.' };
    case 'find': {
      // A find that acts on what it matches is not a listing.
      if (args.some((a) => ['-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fls'].includes(a))) {
        return fallback;
      }
      const idx = args.findIndex((a) => a === '-name' || a === '-iname' || a === '-path' || a === '-ipath');
      if (idx >= 0 && args[idx + 1]) return { verb: 'glob', detail: args[idx + 1] };
      const dir = args.find((a) => !isFlag(a) && !a.startsWith('!') && !a.startsWith('('));
      return { verb: 'glob', detail: dir ?? '.' };
    }
    case 'fd': {
      const first = nonFlags(args, new Set(['-e', '--extension', '-t', '--type', '-E', '--exclude', '-d', '--max-depth']))[0];
      return { verb: 'glob', detail: first ?? '.' };
    }
    default:
      return fallback;
  }
}

export function describeTool(name: string, input: unknown): ToolDescription {
  const canonical = TOOL_ALIASES[normaliseToolName(name)];
  // An unrecognised tool keeps its own name rather than being forced into one
  // of ours. MCP servers add tools constantly and a wrong verb is worse than
  // an unfamiliar one.
  let label = canonical ?? name;
  const obj = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};

  let detail = canonical
    ? firstScalar(obj, DETAIL_KEYS[canonical] ?? [])
    : // Unknown tool: take the first string argument rather than dumping
      // `key=value` pairs. One readable value beats two truncated ones.
      firstScalar(obj, Object.keys(obj));

  let isCommand = canonical === 'bash';
  if (isCommand) {
    const classified = classifyShellCommand(detail);
    label = classified.verb;
    detail = classified.detail;
    isCommand = classified.verb === 'bash';
  }
  // Commands are collapsed to one line here, not by the renderer: a multi-line
  // heredoc otherwise blows the row height out on a surface that renders one
  // call per line.
  return {
    label,
    detail: isCommand ? detail.replace(/\s*\n\s*/g, ' ').trim() : detail,
    isCommand,
  };
}

/** True for tools the transcript leaves out (the todo list has its own panel). */
export function isHiddenTool(name: string): boolean {
  return TOOL_ALIASES[normaliseToolName(name)] === 'todo';
}

/**
 * Whether a settled tool call counts as failed.
 *
 * A shell search (`rg`, `grep`) exits 1 with no output when nothing matched,
 * and Codex reports that as an error. That is an answer, not a failure.
 */
export function effectiveToolError(name: string, input: unknown, output: unknown, isError: boolean): boolean {
  if (!isError) return false;
  if (TOOL_ALIASES[normaliseToolName(name)] !== 'bash') return true;
  if (describeTool(name, input).label !== 'grep') return true;
  return formatToolOutput(output).text.trim() !== '';
}

// ---------------------------------------------------------------------------
// Edit diffs
// ---------------------------------------------------------------------------

export interface EditDiffLine {
  kind: 'add' | 'del' | 'ctx' | 'hunk';
  text: string;
}

export interface EditDiff {
  path: string;
  added: number;
  removed: number;
  lines: EditDiffLine[];
}

const DIFF_CONTEXT = 2;
const DIFF_MAX_CELLS = 250_000;

function splitLines(text: string): string[] {
  if (text === '') return [];
  return (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n');
}

/** Line diff of one old/new pair: LCS in the middle, a little context around it. */
function diffLines(oldText: string, newText: string): EditDiffLine[] {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  if (start === endA && start === endB) return [];

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const out: EditDiffLine[] = [];
  for (const t of a.slice(Math.max(0, start - DIFF_CONTEXT), start)) out.push({ kind: 'ctx', text: t });

  if (midA.length * midB.length > DIFF_MAX_CELLS) {
    for (const t of midA) out.push({ kind: 'del', text: t });
    for (const t of midB) out.push({ kind: 'add', text: t });
  } else {
    const n = midA.length;
    const m = midB.length;
    const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i][j] = midA[i] === midB[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && midA[i] === midB[j]) {
        out.push({ kind: 'ctx', text: midA[i] });
        i++;
        j++;
      } else if (i < n && (j >= m || lcs[i + 1][j] >= lcs[i][j + 1])) {
        out.push({ kind: 'del', text: midA[i++] });
      } else {
        out.push({ kind: 'add', text: midB[j++] });
      }
    }
  }
  for (const t of a.slice(endA, endA + DIFF_CONTEXT)) out.push({ kind: 'ctx', text: t });
  return out;
}

function stringOf(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

/**
 * The line diff an edit tool call carries in its own input, or null when it
 * carries none (Codex `file_change` names paths only).
 */
export function editDiffFromInput(toolName: string, input: unknown): EditDiff | null {
  if (!input || typeof input !== 'object') return null;
  const obj = input as Record<string, unknown>;
  const path = stringOf(obj.file_path) ?? stringOf(obj.notebook_path) ?? stringOf(obj.filePath) ?? stringOf(obj.path);
  if (path === null) return null;

  const pairs: Array<{ oldText: string; newText: string }> = [];
  switch (normaliseToolName(toolName)) {
    case 'edit': {
      const oldText = stringOf(obj.old_string);
      const newText = stringOf(obj.new_string);
      if (oldText === null || newText === null) return null;
      pairs.push({ oldText, newText });
      break;
    }
    case 'multiedit': {
      if (!Array.isArray(obj.edits)) return null;
      for (const e of obj.edits) {
        const rec = e && typeof e === 'object' ? (e as Record<string, unknown>) : {};
        const oldText = stringOf(rec.old_string);
        const newText = stringOf(rec.new_string);
        if (oldText !== null && newText !== null) pairs.push({ oldText, newText });
      }
      if (pairs.length === 0) return null;
      break;
    }
    case 'write': {
      const content = stringOf(obj.content);
      if (content === null) return null;
      pairs.push({ oldText: '', newText: content });
      break;
    }
    case 'notebookedit': {
      const newText = stringOf(obj.new_source);
      if (newText === null) return null;
      pairs.push({ oldText: stringOf(obj.old_source) ?? '', newText });
      break;
    }
    default:
      return null;
  }

  const lines: EditDiffLine[] = [];
  for (const { oldText, newText } of pairs) {
    const part = diffLines(oldText, newText);
    if (part.length === 0) continue;
    if (lines.length > 0) lines.push({ kind: 'hunk', text: '' });
    lines.push(...part);
  }
  return {
    path,
    added: lines.filter((l) => l.kind === 'add').length,
    removed: lines.filter((l) => l.kind === 'del').length,
    lines,
  };
}

// ---------------------------------------------------------------------------
// Tool pairing
// ---------------------------------------------------------------------------

/**
 * A tool call and whatever it returned, as one thing.
 *
 * `buildBlocks` keeps them as separate `tool_use` / `tool_result` blocks
 * because that is what the event stream says and what an audit log (the admin
 * console) should show. A conversation view wants the opposite: one row per
 * call, with the output nested under it. Rendering them as siblings is how the
 * task terminal came to show a boxed row for the call, then another boxed row
 * for the first line of its output, with a ✓ or ✗ on the OUTPUT — which reads
 * as a per-line verdict and is not one. `git fetch` writing "From <url>" to
 * stderr is not a failure, and it was rendered as a red ✗.
 */
export interface ToolBlock {
  kind: 'tool';
  key: string;
  toolId: string;
  name: string;
  input: unknown;
  /** Absent while the call is still in flight. */
  output?: unknown;
  /** Only meaningful once `output` has landed. */
  isError: boolean;
  stopped: boolean;
  /** False until the result arrives — lets a renderer show a spinner. */
  settled: boolean;
}

export type MergedBlock = Exclude<Block, { kind: 'tool_use' } | { kind: 'tool_result' }> | ToolBlock;

/**
 * Fold each `tool_result` back into the `tool_use` it answers.
 *
 * Pairs on `tool_use_id`, which `buildBlocks` has already resolved. A result
 * whose call we never saw (a truncated transcript, a run adopted mid-flight)
 * still gets a row of its own — dropping it would silently lose output.
 */
export function mergeToolBlocks(blocks: Block[]): MergedBlock[] {
  const out: MergedBlock[] = [];
  const indexByToolId = new Map<string, number>();

  for (const block of blocks) {
    if (block.kind === 'tool_use') {
      if (block.toolId) indexByToolId.set(block.toolId, out.length);
      out.push({
        kind: 'tool',
        key: block.key,
        toolId: block.toolId,
        name: block.name,
        input: block.input,
        isError: false,
        stopped: false,
        settled: false,
      });
      continue;
    }

    if (block.kind === 'tool_result') {
      const idx = block.toolId ? indexByToolId.get(block.toolId) : undefined;
      const target = idx === undefined ? undefined : out[idx];
      if (target && target.kind === 'tool') {
        target.output = block.content;
        target.isError = effectiveToolError(target.name, target.input, block.content, block.isError);
        target.stopped = block.stopped === true;
        target.settled = true;
        continue;
      }
      // Orphan: render it as a settled call we know nothing about.
      out.push({
        kind: 'tool',
        key: block.key,
        toolId: block.toolId,
        name: block.toolName ?? 'tool',
        input: block.toolInput,
        output: block.content,
        isError: effectiveToolError(block.toolName ?? 'tool', block.toolInput, block.content, block.isError),
        stopped: block.stopped === true,
        settled: true,
      });
      continue;
    }

    out.push(block);
  }

  return out;
}

/**
 * Render-affecting signature for a merged block.
 *
 * {@link blockSignature} is not enough here: a `tool` block MUTATES when its
 * result lands (`settled` flips, `output` appears) while keeping the key of the
 * call. Memoising on the key alone would leave every tool row showing a
 * spinner forever.
 */
export function mergedBlockSignature(block: MergedBlock): string {
  if (block.kind === 'tool') {
    const len =
      typeof block.output === 'string' ? block.output.length : block.output ? 1 : 0;
    return `${block.key}:${block.settled ? 1 : 0}:${block.isError ? 1 : 0}:${block.stopped ? 1 : 0}:${len}`;
  }
  return blockSignature(block);
}

// ---------------------------------------------------------------------------
// Tool output
// ---------------------------------------------------------------------------

/** Tool output, made readable, with enough about its size to decide how much
 *  of it to show. */
export interface ToolOutput {
  /** Display text — pretty-printed when the raw output was JSON. */
  text: string;
  /** Newline count of `text`. */
  lines: number;
  /** Character count of `text`. */
  chars: number;
  /** The raw output parsed as JSON and re-printed. */
  isJson: boolean;
  /** One line naming what came back, for a collapsed row. */
  summary: string;
}

/** Bytes, in the units a person reads. */
function humanSize(chars: number): string {
  if (chars < 1024) return `${chars} chars`;
  if (chars < 1024 * 1024) return `${(chars / 1024).toFixed(1)} KB`;
  return `${(chars / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Turn whatever a tool returned into something worth putting on screen.
 *
 * # Two things this fixes, both visible in a real transcript
 *
 * **Minified JSON.** A GitHub API call returns ~4 KB of
 * `{"url":"https://api.github.com/…","node_id":"…"}` as ONE string. Printed
 * verbatim it is a wall of punctuation nobody can read; pretty-printed it is a
 * document you can scan. So JSON is re-printed, and the fact that it IS JSON is
 * reported so a caller can collapse it behind a size rather than a line count.
 *
 * **Size measured in the wrong unit.** The renderer clamped output at six
 * LINES, and that single 4 KB JSON string is one line — so the clamp did
 * nothing and it wrapped to twenty-odd rows on screen. Anything deciding how
 * much to show needs the character count too, which is why both are here.
 */
export function formatToolOutput(output: unknown): ToolOutput {
  const raw =
    output === undefined || output === null
      ? ''
      : typeof output === 'string'
        ? output
        : (extractToolText(output) ?? safeStringify(output));

  let text = raw.replace(/\s+$/, '');
  let isJson = false;

  // Only worth re-printing when it is a JSON OBJECT or ARRAY. A bare `"42"` or
  // `"true"` is valid JSON and pretty-printing it changes nothing.
  const trimmed = text.trimStart();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object') {
        text = JSON.stringify(parsed, null, 2);
        isJson = true;
      }
    } catch {
      // Not JSON, or truncated mid-document. Leave it exactly as it came —
      // a half-parsed document is worse than the raw bytes.
    }
  }

  const lines = text ? text.split('\n').length : 0;
  const chars = text.length;

  const summary = !text
    ? ''
    : isJson
      ? `JSON · ${humanSize(chars)}`
      : lines > 1
        ? `${lines} lines · ${humanSize(chars)}`
        : humanSize(chars);

  return { text, lines, chars, isJson, summary };
}

/**
 * Unwrap a `[{type:'text', text:'…'}]` content array into a plain string.
 *
 * Anthropic's message content is always that shape when a subagent returns its
 * answer. A heterogeneous array bails out so the caller can dump raw JSON
 * rather than silently lose the non-text parts.
 */
export function extractToolText(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content) || content.length === 0) return null;
  const texts: string[] = [];
  for (const item of content) {
    if (
      item &&
      typeof item === 'object' &&
      (item as { type?: unknown }).type === 'text' &&
      typeof (item as { text?: unknown }).text === 'string'
    ) {
      texts.push((item as { text: string }).text);
    } else {
      return null;
    }
  }
  return texts.join('\n\n');
}

/** JSON.stringify that survives a cycle rather than throwing inside a render. */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? '';
  } catch {
    return String(value);
  }
}

// ---------------------------------------------------------------------------
// Tool grouping
// ---------------------------------------------------------------------------

/**
 * A run of consecutive tool calls with no prose between them.
 *
 * An agent typically does several things to answer one sentence — clone, fetch,
 * log, read — and rendering each as a top-level row buries the sentences that
 * explain them. Folding the run into one openable section is what makes a long
 * transcript skimmable: you read the prose, and open the plumbing only where
 * you care.
 *
 * Only ever built for TWO OR MORE calls. A lone tool call is not a "run", and
 * hiding it behind a disclosure costs a click to learn one line.
 */
export interface ToolGroupBlock {
  kind: 'tool_group';
  key: string;
  /** Only the tool calls, in order. */
  tools: ToolBlock[];
  /**
   * Tool calls and the reasoning BETWEEN them, in order. Reasoning before the
   * first call or after the last one stays outside the group.
   */
  children: ToolGroupChild[];
  /** How many calls in the run failed. */
  failedCount: number;
  /** True when the final call failed, so the turn probably ended on it. */
  lastFailed: boolean;
  /** e.g. "Ran 3 commands, read a file". */
  summary: string;
  /** True while any call in the run is still in flight. */
  running: boolean;
  /** True when any call in the run failed — the group says so without opening. */
  isError: boolean;
}

export type ThinkingBlock = Extract<Block, { kind: 'thinking' }>;
export type ToolGroupChild = ToolBlock | ThinkingBlock;

/** Failure figures for a run of calls, for a "· 1 failed" suffix. */
export function toolRunFailures(tools: ToolBlock[]): { failedCount: number; lastFailed: boolean } {
  const settled = tools.filter((t) => t.settled);
  return {
    failedCount: tools.filter((t) => t.isError).length,
    lastFailed: tools.length > 0 && tools[tools.length - 1].isError && settled.includes(tools[tools.length - 1]),
  };
}

export type GroupedBlock = Exclude<MergedBlock, ToolBlock> | ToolBlock | ToolGroupBlock;

/** `1 file` / `3 files`, without the caller assembling it each time. */
function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Name what a run of calls actually did, in the order a person would say it.
 *
 * Counts by CANONICAL verb, not by tool name, so `bash` and `Bash` and
 * `run_command` are the same three commands rather than three different things.
 */
export function summariseToolRun(tools: ToolBlock[]): string {
  const counts = new Map<string, number>();
  for (const t of tools) {
    const { label } = describeTool(t.name, t.input);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }

  const parts: string[] = [];
  const take = (label: string, fn: (n: number) => string) => {
    const n = counts.get(label);
    if (n) {
      parts.push(fn(n));
      counts.delete(label);
    }
  };

  take('bash', (n) => `Ran ${plural(n, 'command')}`);
  take('read', (n) => (n === 1 ? 'read a file' : `read ${plural(n, 'file')}`));
  take('edit', (n) => `edited ${plural(n, 'file')}`);
  take('write', (n) => `wrote ${plural(n, 'file')}`);
  take('grep', (n) => `${plural(n, 'search', 'searches')}`);
  take('glob', (n) => `${plural(n, 'search', 'searches')}`);
  take('list', (n) => `${plural(n, 'listing')}`);
  take('fetch', (n) => `fetched ${plural(n, 'URL')}`);
  take('websearch', (n) => `${plural(n, 'web search', 'web searches')}`);
  take('publish', (n) => `${plural(n, 'publish', 'publishes')}`);

  // Everything left over — MCP tools and anything this build has no verb for —
  // collapses into one honest count rather than a list of names nobody reads.
  const rest = [...counts.values()].reduce((a, b) => a + b, 0);
  if (rest) parts.push(`${plural(rest, 'tool call')}`);

  if (parts.length === 0) return `${plural(tools.length, 'tool call')}`;
  // Capitalise only if the first part did not already start with a verb.
  const [first, ...others] = parts;
  const head = /^[a-z]/.test(first) ? first[0].toUpperCase() + first.slice(1) : first;
  return [head, ...others].join(', ');
}

/**
 * Fold consecutive tool calls into openable sections.
 *
 * Anything that is not a tool call BREAKS the run — prose, reasoning, a
 * permission card — because those are exactly the boundaries a reader thinks
 * in: "it said this, then it did these four things, then it said that".
 */
export function groupToolRuns(blocks: MergedBlock[]): GroupedBlock[] {
  const out: GroupedBlock[] = [];
  let run: ToolBlock[] = [];
  let children: ToolGroupChild[] = [];
  // Reasoning seen since the last call: inside the group only if another call follows.
  let pending: ThinkingBlock[] = [];

  const flush = () => {
    if (run.length === 1) {
      out.push(run[0]);
    } else if (run.length > 1) {
      out.push({
        kind: 'tool_group',
        key: `group-${run[0].key}`,
        tools: run,
        children,
        ...toolRunFailures(run),
        summary: summariseToolRun(run),
        running: run.some((t) => !t.settled),
        isError: run.some((t) => t.isError),
      });
    }
    out.push(...pending);
    run = [];
    children = [];
    pending = [];
  };

  for (const block of blocks) {
    if (block.kind === 'tool') {
      if (isHiddenTool(block.name)) continue;
      children.push(...pending);
      pending = [];
      run.push(block);
      children.push(block);
      continue;
    }
    if (block.kind === 'thinking' && run.length > 0) {
      pending.push(block);
      continue;
    }
    flush();
    out.push(block);
  }
  flush();
  return out;
}

/**
 * Render-affecting signature for a grouped block.
 *
 * A group mutates as its calls settle — the summary is stable but `running`
 * and `isError` are not, and neither are the rows inside it. Folding every
 * member's signature in is what keeps an open group live while its last call
 * is still running.
 */
export function groupedBlockSignature(block: GroupedBlock): string {
  if (block.kind === 'tool_group') {
    return `${block.key}:${block.children.map((c) => (c.kind === 'tool' ? mergedBlockSignature(c) : c.key)).join(',')}`;
  }
  return mergedBlockSignature(block);
}
