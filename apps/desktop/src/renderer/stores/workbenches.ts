import { create } from 'zustand';
import { trackEvent } from '../lib/analytics';
import type {
  Workbench,
  WorkbenchAttachment,
  WorkbenchChat,
  WorkbenchEvent,
  WorkbenchQueuedMessage,
  WorkbenchScriptFrame,
} from '@talyn/shared';
import {
  DOCK_DEFAULT_HEIGHT,
  DOCK_MIN_HEIGHT,
  clampDockHeight,
  clampPanelWidth,
  readLayout,
  writeLayout,
  type GitPanelTab,
} from '../lib/workbenchLayout';
import type { PendingUserMessage } from '../lib/workbenchFormat';

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

export type WorkbenchSideTab = GitPanelTab;
export type WorkbenchTerminalTab = 'setup' | 'run' | 'terminal';

export interface ChatEventsState {
  events: WorkbenchEvent[];
  /** The newest page is in. Older events load on demand, see `hasOlder`. */
  loaded: boolean;
  loading: boolean;
  error: string | null;
  /** Stored events exist below `oldestSeq` that this client has not fetched. */
  hasOlder: boolean;
  /** The oldest seq of the fetched history; the next older page is the one below it. */
  oldestSeq: number | null;
  loadingOlder: boolean;
  olderError: string | null;
}

/** A prompt shown in the transcript until its own event arrives. See `pendingMessageState`. */
export type OutgoingWorkbenchMessage = PendingUserMessage;

let outgoingSequence = 0;

/** What a history page says about the events below it. */
export interface OlderEventsMarker {
  hasOlder: boolean;
  oldestSeq: number | null;
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
  generation?: string;
  offset?: number;
  revision?: number;
  /** Raw output chunks, in arrival order. Capped so a chatty dev server cannot grow it forever. */
  chunks: string[];
  /** Chunks ever received, including ones dropped by the cap — a reader's cursor. */
  total: number;
  running: boolean;
  exitCode: number | null;
}

/** Keeps the newest output of a script. A dev server can print for hours. */
/** What a workbench has that the user has not seen yet. */
export interface UnseenUpdates {
  /** Turns that finished while nobody looked. */
  turns: number;
  /** A pull request was linked while nobody looked. */
  prOpened: boolean;
}

const NO_UNSEEN: UnseenUpdates = { turns: 0, prOpened: false };

function hasLinkedPr(workbench: Pick<Workbench, 'pullRequestId' | 'pr'>): boolean {
  return !!workbench.pullRequestId || !!workbench.pr;
}

/**
 * True when a new pull request is the only unseen news. The turn that opened
 * the PR also finishes, so one finished turn counts as the same news. A second
 * finished turn is other news and brings the blue dot back.
 */
export function isPrOnlyUnseen(unseen: UnseenUpdates | undefined): boolean {
  return !!unseen && unseen.prOpened && unseen.turns <= 1;
}

export const SCRIPT_OUTPUT_MAX_CHUNKS = 5000;

export const TERMINAL_MIN_HEIGHT = DOCK_MIN_HEIGHT;
export const TERMINAL_DEFAULT_HEIGHT = DOCK_DEFAULT_HEIGHT;

const EMPTY_EVENTS: ChatEventsState = {
  events: [],
  loaded: false,
  loading: false,
  error: null,
  hasOlder: false,
  oldestSeq: null,
  loadingOlder: false,
  olderError: null,
};

/**
 * The entries of a `workbench:event` broadcast that are event objects. One
 * null entry would otherwise throw in the handler and drop the whole batch.
 */
export function wellFormedEvents(events: unknown[]): WorkbenchEvent[] {
  return events.filter((e): e is WorkbenchEvent => {
    const event = (e as { event?: unknown } | null)?.event;
    return typeof event === 'object' && event !== null;
  });
}

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
  /**
   * Workbenches outside `workspaceId` that are open for viewing: a teammate's
   * session in a space, or my own in another workspace. They live in
   * `workbenches` so the session view works unchanged, and stay out of the
   * Personal lists (see `useWorkspaceWorkbenches`).
   */
  extraWorkbenchIds: Record<string, true>;
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
  /** The right panel (files, changes, pull request and the terminal dock). ⌘⌥B. */
  rightPanelOpen: boolean;
  rightPanelWidth: number;
  /** The terminal dock under the right panel is open; closed, it is one bar. */
  terminalOpen: boolean;
  terminalHeight: number;
  terminalTab: WorkbenchTerminalTab;
  /** Composer drafts per chat (or per workbench before it has a chat). */
  drafts: Record<string, string>;
  /** Prompts shown in the transcript before their own event arrives. */
  outgoingMessages: Record<string, OutgoingWorkbenchMessage[]>;
  /** Chats that finished while nobody was looking. */
  unread: Record<string, true>;
  /**
   * Per workbench, what the user has not seen: how many turns finished and
   * whether a pull request was opened. A row shows the PR icon instead of the
   * blue dot when the PR opening is the only news (see `isPrOnlyUnseen`).
   */
  unseen: Record<string, UnseenUpdates>;
  /** Local runtime only: messages sent while a turn ran. The sandbox queue lives on the chat row. */
  localQueues: Record<string, WorkbenchQueuedMessage[]>;
  /** Script output per workbench, per script name. */
  scriptOutput: Record<string, Record<string, ScriptOutputState>>;
  newWorkbench: NewWorkbenchRequest;

  setWorkspace: (workspaceId: string | null) => void;
  setWorkbenches: (workspaceId: string, list: Workbench[]) => void;
  setListError: (error: string | null) => void;
  upsertWorkbench: (workbench: Workbench) => void;
  /** Hold a workbench from outside the current workspace, for viewing. */
  addExtraWorkbench: (workbench: Workbench) => void;
  removeWorkbench: (id: string) => void;
  setChats: (workbenchId: string, chats: WorkbenchChat[]) => void;
  upsertChat: (chat: WorkbenchChat) => void;
  setChatEventsState: (chatId: string, patch: Partial<ChatEventsState>) => void;
  appendEvents: (chatId: string, events: WorkbenchEvent[]) => void;
  /**
   * The newest page of a chat's history. Held events older than the page are
   * dropped: they came over the socket before the chat was opened and may sit
   * across a gap. They come back with the older pages.
   */
  setLatestPage: (chatId: string, events: WorkbenchEvent[], marker: OlderEventsMarker) => void;
  /** An older page, merged in front of what is held. */
  prependOlderPage: (chatId: string, events: WorkbenchEvent[], marker: OlderEventsMarker) => void;
  selectWorkbench: (id: string | null) => void;
  selectChat: (workbenchId: string, chatId: string) => void;
  hideChat: (workbenchId: string, chatId: string) => void;
  setSideTab: (tab: WorkbenchSideTab) => void;
  /** The Talyn pull request id shown in the session's details overlay, or null. */
  prDetailId: string | null;
  openPrDetail: (pullRequestId: string | null) => void;
  setRightPanelOpen: (open: boolean) => void;
  toggleRightPanel: () => void;
  setRightPanelWidth: (width: number) => void;
  setTerminalOpen: (open: boolean) => void;
  toggleTerminal: () => void;
  setTerminalHeight: (height: number) => void;
  setTerminalTab: (tab: WorkbenchTerminalTab) => void;
  setDraft: (key: string, text: string) => void;
  /** Show a sent prompt in the chat's transcript. Returns its id. `settled`: the send already finished. */
  addOutgoingMessage: (chatId: string, message: { text: string; attachments?: WorkbenchAttachment[]; settled?: boolean }) => string;
  /** The send request finished: the prompt stays until its event arrives or it stops being pending. */
  settleOutgoingMessage: (chatId: string, messageId: string) => void;
  removeOutgoingMessages: (chatId: string, messageIds: string[]) => void;
  /** Add text to the end of a draft, on its own paragraph. */
  appendDraft: (key: string, text: string) => void;
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

const initialLayout = readLayout();

export const useWorkbenchStore = create<WorkbenchState>((set, get) => ({
  workspaceId: null,
  workbenches: {},
  extraWorkbenchIds: {},
  listLoaded: false,
  listError: null,
  chats: {},
  chatEvents: {},
  selectedWorkbenchId: null,
  selectedChatByWorkbench: {},
  hiddenChatIds: {},
  sideTab: initialLayout.gitPanelTab,
  prDetailId: null,
  rightPanelOpen: true,
  rightPanelWidth: initialLayout.gitPanelWidth,
  terminalOpen: false,
  terminalHeight: initialLayout.dockHeight,
  terminalTab: 'terminal',
  drafts: {},
  outgoingMessages: {},
  unread: {},
  unseen: {},
  localQueues: {},
  scriptOutput: {},
  newWorkbench: { seq: 0, prefill: null },

  setWorkspace: (workspaceId) =>
    set((s) =>
      s.workspaceId === workspaceId
        ? s
        : {
            workspaceId,
            workbenches: {},
            extraWorkbenchIds: {},
            listLoaded: false,
            listError: null,
            selectedWorkbenchId: null,
            outgoingMessages: {},
          }
    ),

  setWorkbenches: (workspaceId, list) =>
    set((s) => {
      if (s.workspaceId !== workspaceId) return s;
      const workbenches: Record<string, Workbench> = {};
      for (const id of Object.keys(s.extraWorkbenchIds)) {
        if (s.workbenches[id]) workbenches[id] = s.workbenches[id];
      }
      for (const wb of list) workbenches[wb.id] = wb;
      const selected = s.selectedWorkbenchId && workbenches[s.selectedWorkbenchId] ? s.selectedWorkbenchId : null;
      return { workbenches, listLoaded: true, listError: null, selectedWorkbenchId: selected };
    }),

  setListError: (listError) => set({ listError, listLoaded: true }),

  upsertWorkbench: (workbench) =>
    set((s) => {
      if (s.workspaceId && workbench.workspaceId !== s.workspaceId && !s.extraWorkbenchIds[workbench.id]) return s;
      const prev = s.workbenches[workbench.id];
      const opened = !!prev && !hasLinkedPr(prev) && hasLinkedPr(workbench);
      const looking = s.selectedWorkbenchId === workbench.id && (typeof document === 'undefined' || document.hasFocus());
      const workbenches = { ...s.workbenches, [workbench.id]: workbench };
      if (!opened || looking) return { workbenches };
      const cur = s.unseen[workbench.id] ?? NO_UNSEEN;
      return { workbenches, unseen: { ...s.unseen, [workbench.id]: { ...cur, prOpened: true } } };
    }),

  addExtraWorkbench: (workbench) =>
    set((s) => {
      if (!s.workspaceId || workbench.workspaceId === s.workspaceId) {
        return { workbenches: { ...s.workbenches, [workbench.id]: workbench } };
      }
      return {
        workbenches: { ...s.workbenches, [workbench.id]: workbench },
        extraWorkbenchIds: { ...s.extraWorkbenchIds, [workbench.id]: true },
      };
    }),

  removeWorkbench: (id) =>
    set((s) => {
      if (!s.workbenches[id]) return s;
      const workbenches = { ...s.workbenches };
      delete workbenches[id];
      const extraWorkbenchIds = { ...s.extraWorkbenchIds };
      delete extraWorkbenchIds[id];
      return {
        workbenches,
        extraWorkbenchIds,
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
      if (!looking) {
        set((cur) => {
          const unseen = cur.unseen[chat.workbenchId] ?? NO_UNSEEN;
          return {
            unread: { ...cur.unread, [chat.id]: true },
            unseen: { ...cur.unseen, [chat.workbenchId]: { ...unseen, turns: unseen.turns + 1 } },
          };
        });
      }
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

  setLatestPage: (chatId, events, marker) =>
    set((s) => {
      const cur = s.chatEvents[chatId] ?? EMPTY_EVENTS;
      const floor = marker.oldestSeq ?? (events.length ? events[0].seq : null);
      const kept = floor === null ? cur.events : cur.events.filter((e) => e.seq >= floor);
      const merged = mergeWorkbenchEvents(kept, events);
      const next: ChatEventsState = {
        ...cur,
        events: merged,
        hasOlder: marker.hasOlder,
        oldestSeq: merged.length ? merged[0].seq : null,
        olderError: null,
      };
      return { chatEvents: { ...s.chatEvents, [chatId]: next } };
    }),

  prependOlderPage: (chatId, events, marker) =>
    set((s) => {
      const cur = s.chatEvents[chatId] ?? EMPTY_EVENTS;
      const oldestSeq =
        marker.oldestSeq === null ? cur.oldestSeq : Math.min(marker.oldestSeq, cur.oldestSeq ?? marker.oldestSeq);
      const next: ChatEventsState = {
        ...cur,
        events: mergeWorkbenchEvents(cur.events, events),
        hasOlder: marker.hasOlder,
        oldestSeq,
        olderError: null,
      };
      return { chatEvents: { ...s.chatEvents, [chatId]: next } };
    }),

  selectWorkbench: (id) =>
    set((s) => {
      if (!id || !s.unseen[id]) return { selectedWorkbenchId: id };
      const unseen = { ...s.unseen };
      delete unseen[id];
      return { selectedWorkbenchId: id, unseen };
    }),

  selectChat: (workbenchId, chatId) =>
    set((s) => {
      const unread = { ...s.unread };
      delete unread[chatId];
      const unseen = { ...s.unseen };
      delete unseen[workbenchId];
      return { selectedChatByWorkbench: { ...s.selectedChatByWorkbench, [workbenchId]: chatId }, unread, unseen };
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

  openPrDetail: (prDetailId) => set({ prDetailId }),
  setSideTab: (sideTab) => {
    set({ sideTab, rightPanelOpen: true });
    writeLayout({ gitPanelTab: sideTab });
  },
  setRightPanelOpen: (rightPanelOpen) => set({ rightPanelOpen }),
  toggleRightPanel: () => set((s) => ({ rightPanelOpen: !s.rightPanelOpen })),
  setRightPanelWidth: (width) => {
    const rightPanelWidth = clampPanelWidth(width);
    set({ rightPanelWidth });
    writeLayout({ gitPanelWidth: rightPanelWidth });
  },
  // The dock lives under the right panel, so opening it shows the panel too.
  setTerminalOpen: (terminalOpen) => set((s) => ({ terminalOpen, rightPanelOpen: terminalOpen || s.rightPanelOpen })),
  toggleTerminal: () =>
    set((s) => {
      const open = !(s.terminalOpen && s.rightPanelOpen);
      return { terminalOpen: open, rightPanelOpen: open || s.rightPanelOpen };
    }),
  setTerminalHeight: (height) => {
    const terminalHeight = clampDockHeight(height);
    set({ terminalHeight });
    writeLayout({ dockHeight: terminalHeight });
  },
  setTerminalTab: (terminalTab) => set({ terminalTab, terminalOpen: true, rightPanelOpen: true }),

  setDraft: (key, text) =>
    set((s) => {
      if ((s.drafts[key] ?? '') === text) return s;
      const drafts = { ...s.drafts };
      if (text) drafts[key] = text;
      else delete drafts[key];
      return { drafts };
    }),

  addOutgoingMessage: (chatId, { text, attachments = [], settled = false }) => {
    outgoingSequence += 1;
    const id = `outgoing-${Date.now()}-${outgoingSequence}`;
    set((s) => {
      const held = s.chatEvents[chatId]?.events ?? [];
      const message: OutgoingWorkbenchMessage = {
        id,
        text,
        attachments,
        afterSeq: held.length ? held[held.length - 1].seq : null,
        ...(settled ? { settledAt: Date.now() } : {}),
      };
      return { outgoingMessages: { ...s.outgoingMessages, [chatId]: [...(s.outgoingMessages[chatId] ?? []), message] } };
    });
    return id;
  },

  settleOutgoingMessage: (chatId, messageId) =>
    set((s) => {
      const list = s.outgoingMessages[chatId];
      if (!list?.some((message) => message.id === messageId)) return s;
      return {
        outgoingMessages: {
          ...s.outgoingMessages,
          [chatId]: list.map((message) => (message.id === messageId ? { ...message, settledAt: Date.now() } : message)),
        },
      };
    }),

  removeOutgoingMessages: (chatId, messageIds) =>
    set((s) => {
      const list = s.outgoingMessages[chatId];
      if (!list?.some((message) => messageIds.includes(message.id))) return s;
      return {
        outgoingMessages: {
          ...s.outgoingMessages,
          [chatId]: list.filter((message) => !messageIds.includes(message.id)),
        },
      };
    }),

  appendDraft: (key, text) => {
    const add = text.trim();
    if (!add) return;
    const cur = get().drafts[key] ?? '';
    const sep = !cur.trim() ? '' : cur.endsWith('\n\n') ? '' : cur.endsWith('\n') ? '\n' : '\n\n';
    get().setDraft(key, cur.trim() ? `${cur}${sep}${add}` : add);
  },

  markRead: (chatId) =>
    set((s) => {
      if (!s.unread[chatId]) return s;
      const unread = { ...s.unread };
      delete unread[chatId];
      const unseen = { ...s.unseen };
      for (const [workbenchId, list] of Object.entries(s.chats)) {
        if (list.some((c) => c.id === chatId)) delete unseen[workbenchId];
      }
      return { unread, unseen };
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
      let cur = byName[frame.name] ?? { chunks: [], total: 0, running: true, exitCode: null };
      if (frame.generation && frame.generation === cur.generation && frame.offset !== undefined &&
          (frame.offset < (cur.offset ?? 0) || (frame.offset === cur.offset && frame.stream !== 'exit'))) return s;
      if (frame.generation && frame.generation !== cur.generation) {
        cur = { chunks: [], total: 0, running: true, exitCode: null, revision: (cur.revision ?? 0) + 1 };
      }
      let next: ScriptOutputState;
      if (frame.snapshot) {
        next = { chunks: frame.data ? [frame.data] : [], total: frame.data ? 1 : 0,
          running: frame.running ?? true, exitCode: frame.exitCode ?? null, revision: (cur.revision ?? 0) + 1 };
      } else if (frame.stream === 'exit') {
        next = { ...cur, running: false, exitCode: frame.exitCode ?? null };
      } else {
        const chunks = frame.data ? [...cur.chunks, frame.data] : cur.chunks;
        next = {
          ...cur,
          chunks: chunks.length > SCRIPT_OUTPUT_MAX_CHUNKS ? chunks.slice(-SCRIPT_OUTPUT_MAX_CHUNKS) : chunks,
          total: cur.total + (frame.data ? 1 : 0),
          running: true,
          exitCode: null,
        };
      }
      if (frame.generation) next = { ...next, generation: frame.generation, offset: frame.offset };
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

/** Where the composer keeps its draft: the chat's, or the workbench's before it has a chat. */
export function composerDraftKey(workbenchId: string, chat: Pick<WorkbenchChat, 'id'> | null): string {
  return chat?.id ?? `wb:${workbenchId}`;
}

/** The chats of a workbench the user has not closed. */
export function visibleChats(state: Pick<WorkbenchState, 'chats' | 'hiddenChatIds'>, workbenchId: string): WorkbenchChat[] {
  return (state.chats[workbenchId] ?? []).filter((c) => !state.hiddenChatIds[c.id]);
}

export const emptyChatEvents = EMPTY_EVENTS;

useWorkbenchStore.subscribe((state, previous) => {
  const workbenchId = state.selectedWorkbenchId;
  if (!workbenchId) return;
  if (state.terminalOpen && !previous.terminalOpen) {
    trackEvent('session_terminal_opened', { workbench_id: workbenchId });
  }
  if (state.prDetailId && state.prDetailId !== previous.prDetailId) {
    trackEvent('session_pr_overlay_opened', { workbench_id: workbenchId });
  }
});
