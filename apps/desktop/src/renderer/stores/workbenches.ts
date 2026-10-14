import { create } from 'zustand';
import type {
  Workbench,
  WorkbenchChat,
  WorkbenchEvent,
  WorkbenchQueuedMessage,
  WorkbenchScriptFrame,
} from '@talyn/shared';

/**
 * Workbenches: the list, each workbench's chats, each chat's transcript
 * events, and the UI state of the panel.
 *
 * Events are stored per chat, ordered by `seq` and de-duplicated on it. They
 * arrive from three places that overlap: the paged history fetch, the
 * `workbench:event` broadcast, and (local runtime) the bridge's own stream,
 * which this client sequences before it uploads them. A replayed seq is
 * dropped, never appended twice.
 */

export type WorkbenchSideTab = 'changes' | 'files' | 'checks';
export type WorkbenchTerminalTab = 'setup' | 'run' | 'terminal';

export interface ChatEventsState {
  events: WorkbenchEvent[];
  /** The whole stored history has been fetched. */
  loaded: boolean;
  loading: boolean;
  error: string | null;
}

/** What the new-workbench page starts from when something opens it with a target (a PR row, a branch). */
export interface NewWorkbenchPrefill {
  repositoryId?: string;
  fromPullRequestId?: string;
  baseBranch?: string;
  /** An existing branch to check out. */
  branch?: string;
  runtime?: 'sandbox' | 'local';
}

/**
 * A request to show the new-workbench page. `seq` grows on every request, so
 * the page re-applies the prefill and re-focuses even when it is already open.
 */
export interface NewWorkbenchRequest {
  seq: number;
  prefill: NewWorkbenchPrefill | null;
}

export interface ScriptOutputState {
  /** Raw output chunks, in arrival order. Capped so a chatty dev server cannot grow it forever. */
  chunks: string[];
  /** Chunks ever received, including ones dropped by the cap — a reader's cursor. */
  total: number;
  running: boolean;
  exitCode: number | null;
}

/** Keeps the newest output of a script. A dev server can print for hours. */
export const SCRIPT_OUTPUT_MAX_CHUNKS = 5000;

export const TERMINAL_MIN_HEIGHT = 120;
export const TERMINAL_DEFAULT_HEIGHT = 260;

const EMPTY_EVENTS: ChatEventsState = { events: [], loaded: false, loading: false, error: null };

/**
 * Merge `incoming` into `existing`, de-duplicated on `seq` and in `seq` order.
 *
 * Returns `existing` itself when nothing new arrived, so a caller can skip the
 * store write (and the re-render). Append is the common case, so a sort only
 * runs when a seq actually arrived out of order.
 */
export function mergeWorkbenchEvents(existing: WorkbenchEvent[], incoming: WorkbenchEvent[]): WorkbenchEvent[] {
  if (incoming.length === 0) return existing;
  const seen = new Set(existing.map((e) => e.seq));
  const merged = existing.slice();
  let changed = false;
  for (const ev of incoming) {
    if (seen.has(ev.seq)) continue;
    seen.add(ev.seq);
    merged.push(ev);
    changed = true;
  }
  if (!changed) return existing;
  for (let i = 1; i < merged.length; i++) {
    if (merged[i].seq < merged[i - 1].seq) {
      merged.sort((a, b) => a.seq - b.seq);
      break;
    }
  }
  return merged;
}

/** The highest seq held for a chat, or 0 for none. */
export function lastSeq(events: WorkbenchEvent[]): number {
  return events.length ? events[events.length - 1].seq : 0;
}

/** The highest turn held for a chat, or 0 for none. */
export function lastTurn(events: WorkbenchEvent[]): number {
  let turn = 0;
  for (const e of events) if (e.turn > turn) turn = e.turn;
  return turn;
}

/** Upsert by id, keeping creation order. */
function upsertChatList(list: WorkbenchChat[], chat: WorkbenchChat): WorkbenchChat[] {
  const i = list.findIndex((c) => c.id === chat.id);
  if (i === -1) return [...list, chat].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const next = list.slice();
  next[i] = chat;
  return next;
}

export type ChatFinishedListener = (chat: WorkbenchChat, workbench: Workbench | undefined) => void;

let chatFinishedListener: ChatFinishedListener | null = null;

/** Called when a chat leaves `running`. The notification module sets it; tests may too. */
export function setChatFinishedListener(listener: ChatFinishedListener | null): void {
  chatFinishedListener = listener;
}

interface WorkbenchState {
  workspaceId: string | null;
  workbenches: Record<string, Workbench>;
  listLoaded: boolean;
  listError: string | null;
  /** Chats per workbench, in creation order. */
  chats: Record<string, WorkbenchChat[]>;
  /** Transcript events per chat. */
  chatEvents: Record<string, ChatEventsState>;
  selectedWorkbenchId: string | null;
  /** The open chat tab per workbench. */
  selectedChatByWorkbench: Record<string, string>;
  /** Chat tabs the user closed. There is no server-side close, so this is a view decision. */
  hiddenChatIds: Record<string, true>;
  sideTab: WorkbenchSideTab;
  terminalOpen: boolean;
  terminalHeight: number;
  terminalTab: WorkbenchTerminalTab;
  /** Composer drafts per chat (or per workbench before it has a chat). */
  drafts: Record<string, string>;
  /** Chats that finished while nobody was looking. */
  unread: Record<string, true>;
  /** Local runtime only: messages sent while a turn ran. The sandbox queue lives on the chat row. */
  localQueues: Record<string, WorkbenchQueuedMessage[]>;
  /** Script output per workbench, per script name. */
  scriptOutput: Record<string, Record<string, ScriptOutputState>>;
  newWorkbench: NewWorkbenchRequest;

  setWorkspace: (workspaceId: string | null) => void;
  setWorkbenches: (workspaceId: string, list: Workbench[]) => void;
  setListError: (error: string | null) => void;
  upsertWorkbench: (workbench: Workbench) => void;
  removeWorkbench: (id: string) => void;
  setChats: (workbenchId: string, chats: WorkbenchChat[]) => void;
  upsertChat: (chat: WorkbenchChat) => void;
  setChatEventsState: (chatId: string, patch: Partial<ChatEventsState>) => void;
  appendEvents: (chatId: string, events: WorkbenchEvent[]) => void;
  selectWorkbench: (id: string | null) => void;
  selectChat: (workbenchId: string, chatId: string) => void;
  hideChat: (workbenchId: string, chatId: string) => void;
  setSideTab: (tab: WorkbenchSideTab) => void;
  setTerminalOpen: (open: boolean) => void;
  toggleTerminal: () => void;
  setTerminalHeight: (height: number) => void;
  setTerminalTab: (tab: WorkbenchTerminalTab) => void;
  setDraft: (key: string, text: string) => void;
  markRead: (chatId: string) => void;
  enqueueLocal: (chatId: string, message: WorkbenchQueuedMessage) => void;
  dequeueLocal: (chatId: string) => WorkbenchQueuedMessage | undefined;
  removeLocalQueued: (chatId: string, messageId: string) => void;
  appendScriptFrame: (frame: WorkbenchScriptFrame) => void;
  markScriptStarted: (workbenchId: string, name: string) => void;
  /** Ask the new-workbench page for a fresh start. Navigation is the caller's: see `openNewWorkbench`. */
  requestNewWorkbench: (prefill?: NewWorkbenchPrefill | null) => void;
  clearNewWorkbenchPrefill: () => void;
}

export const useWorkbenchStore = create<WorkbenchState>((set, get) => ({
  workspaceId: null,
  workbenches: {},
  listLoaded: false,
  listError: null,
  chats: {},
  chatEvents: {},
  selectedWorkbenchId: null,
  selectedChatByWorkbench: {},
  hiddenChatIds: {},
  sideTab: 'changes',
  terminalOpen: false,
  terminalHeight: TERMINAL_DEFAULT_HEIGHT,
  terminalTab: 'terminal',
  drafts: {},
  unread: {},
  localQueues: {},
  scriptOutput: {},
  newWorkbench: { seq: 0, prefill: null },

  setWorkspace: (workspaceId) =>
    set((s) =>
      s.workspaceId === workspaceId
        ? s
        : { workspaceId, workbenches: {}, listLoaded: false, listError: null, selectedWorkbenchId: null }
    ),

  setWorkbenches: (workspaceId, list) =>
    set((s) => {
      if (s.workspaceId !== workspaceId) return s;
      const workbenches: Record<string, Workbench> = {};
      for (const wb of list) workbenches[wb.id] = wb;
      const selected = s.selectedWorkbenchId && workbenches[s.selectedWorkbenchId] ? s.selectedWorkbenchId : null;
      return { workbenches, listLoaded: true, listError: null, selectedWorkbenchId: selected };
    }),

  setListError: (listError) => set({ listError, listLoaded: true }),

  upsertWorkbench: (workbench) =>
    set((s) => {
      if (s.workspaceId && workbench.workspaceId !== s.workspaceId) return s;
      return { workbenches: { ...s.workbenches, [workbench.id]: workbench } };
    }),

  removeWorkbench: (id) =>
    set((s) => {
      if (!s.workbenches[id]) return s;
      const workbenches = { ...s.workbenches };
      delete workbenches[id];
      return {
        workbenches,
        selectedWorkbenchId: s.selectedWorkbenchId === id ? null : s.selectedWorkbenchId,
      };
    }),

  setChats: (workbenchId, chats) =>
    set((s) => ({
      chats: {
        ...s.chats,
        [workbenchId]: chats.slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
      },
    })),

  upsertChat: (chat) => {
    const prev = (get().chats[chat.workbenchId] ?? []).find((c) => c.id === chat.id);
    set((s) => ({ chats: { ...s.chats, [chat.workbenchId]: upsertChatList(s.chats[chat.workbenchId] ?? [], chat) } }));
    if (prev && prev.status === 'running' && chat.status !== 'running') {
      const s = get();
      const looking =
        s.selectedWorkbenchId === chat.workbenchId &&
        s.selectedChatByWorkbench[chat.workbenchId] === chat.id &&
        (typeof document === 'undefined' || document.hasFocus());
      if (!looking) set((cur) => ({ unread: { ...cur.unread, [chat.id]: true } }));
      chatFinishedListener?.(chat, s.workbenches[chat.workbenchId]);
    }
  },

  setChatEventsState: (chatId, patch) =>
    set((s) => ({ chatEvents: { ...s.chatEvents, [chatId]: { ...(s.chatEvents[chatId] ?? EMPTY_EVENTS), ...patch } } })),

  appendEvents: (chatId, events) =>
    set((s) => {
      const cur = s.chatEvents[chatId] ?? EMPTY_EVENTS;
      const merged = mergeWorkbenchEvents(cur.events, events);
      if (merged === cur.events) return s;
      return { chatEvents: { ...s.chatEvents, [chatId]: { ...cur, events: merged } } };
    }),

  selectWorkbench: (id) => set({ selectedWorkbenchId: id }),

  selectChat: (workbenchId, chatId) =>
    set((s) => {
      const unread = { ...s.unread };
      delete unread[chatId];
      return { selectedChatByWorkbench: { ...s.selectedChatByWorkbench, [workbenchId]: chatId }, unread };
    }),

  hideChat: (workbenchId, chatId) =>
    set((s) => {
      const visible = (s.chats[workbenchId] ?? []).filter((c) => c.id !== chatId && !s.hiddenChatIds[c.id]);
      const selected = { ...s.selectedChatByWorkbench };
      if (selected[workbenchId] === chatId) {
        if (visible.length) selected[workbenchId] = visible[visible.length - 1].id;
        else delete selected[workbenchId];
      }
      return { hiddenChatIds: { ...s.hiddenChatIds, [chatId]: true }, selectedChatByWorkbench: selected };
    }),

  setSideTab: (sideTab) => set({ sideTab }),
  setTerminalOpen: (terminalOpen) => set({ terminalOpen }),
  toggleTerminal: () => set((s) => ({ terminalOpen: !s.terminalOpen })),
  setTerminalHeight: (height) => set({ terminalHeight: Math.max(TERMINAL_MIN_HEIGHT, Math.round(height)) }),
  setTerminalTab: (terminalTab) => set({ terminalTab, terminalOpen: true }),

  setDraft: (key, text) =>
    set((s) => {
      if ((s.drafts[key] ?? '') === text) return s;
      const drafts = { ...s.drafts };
      if (text) drafts[key] = text;
      else delete drafts[key];
      return { drafts };
    }),

  markRead: (chatId) =>
    set((s) => {
      if (!s.unread[chatId]) return s;
      const unread = { ...s.unread };
      delete unread[chatId];
      return { unread };
    }),

  enqueueLocal: (chatId, message) =>
    set((s) => ({ localQueues: { ...s.localQueues, [chatId]: [...(s.localQueues[chatId] ?? []), message] } })),

  dequeueLocal: (chatId) => {
    const queue = get().localQueues[chatId] ?? [];
    if (queue.length === 0) return undefined;
    const [head, ...rest] = queue;
    set((s) => ({ localQueues: { ...s.localQueues, [chatId]: rest } }));
    return head;
  },

  removeLocalQueued: (chatId, messageId) =>
    set((s) => ({
      localQueues: { ...s.localQueues, [chatId]: (s.localQueues[chatId] ?? []).filter((m) => m.id !== messageId) },
    })),

  appendScriptFrame: (frame) =>
    set((s) => {
      const byName = s.scriptOutput[frame.workbenchId] ?? {};
      const cur = byName[frame.name] ?? { chunks: [], total: 0, running: true, exitCode: null };
      let next: ScriptOutputState;
      if (frame.stream === 'exit') {
        next = { ...cur, running: false, exitCode: frame.exitCode ?? null };
      } else {
        const chunks = frame.data ? [...cur.chunks, frame.data] : cur.chunks;
        next = {
          chunks: chunks.length > SCRIPT_OUTPUT_MAX_CHUNKS ? chunks.slice(-SCRIPT_OUTPUT_MAX_CHUNKS) : chunks,
          total: cur.total + (frame.data ? 1 : 0),
          running: true,
          exitCode: null,
        };
      }
      return { scriptOutput: { ...s.scriptOutput, [frame.workbenchId]: { ...byName, [frame.name]: next } } };
    }),

  markScriptStarted: (workbenchId, name) =>
    set((s) => {
      const byName = s.scriptOutput[workbenchId] ?? {};
      return {
        scriptOutput: {
          ...s.scriptOutput,
          [workbenchId]: { ...byName, [name]: { chunks: [], total: 0, running: true, exitCode: null } },
        },
      };
    }),

  requestNewWorkbench: (prefill = null) => set((s) => ({ newWorkbench: { seq: s.newWorkbench.seq + 1, prefill } })),
  clearNewWorkbenchPrefill: () =>
    set((s) => (s.newWorkbench.prefill ? { newWorkbench: { ...s.newWorkbench, prefill: null } } : s)),
}));

/** The chats of a workbench the user has not closed. */
export function visibleChats(state: Pick<WorkbenchState, 'chats' | 'hiddenChatIds'>, workbenchId: string): WorkbenchChat[] {
  return (state.chats[workbenchId] ?? []).filter((c) => !state.hiddenChatIds[c.id]);
}

export const emptyChatEvents = EMPTY_EVENTS;
