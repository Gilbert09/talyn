import { create } from 'zustand';
import type { Workspace, Environment, Agent, Task, InboxItem } from '@fastowl/shared';
import type { GitHubStatus } from '../lib/api';

// Simplified repository type for store (matches API response)
export interface WatchedRepo {
  id: string;
  workspaceId: string;
  owner: string;
  repo: string;
  fullName: string;
}

export type Theme = 'light' | 'dark' | 'system';

// Get initial theme from localStorage or default to 'light'
function getInitialTheme(): Theme {
  if (typeof window !== 'undefined') {
    const stored = localStorage.getItem('fastowl-theme');
    if (stored === 'light' || stored === 'dark' || stored === 'system') {
      return stored;
    }
  }
  return 'light';
}

const DEBUG_MODE_KEY = 'fastowl-debug-mode';

// Developer-only Debug panel toggle. Persisted like the theme so it survives
// restarts. Off by default — it surfaces app internals (requests, polling,
// WebSocket) and is meant to be opt-in.
function getInitialDebugMode(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return localStorage.getItem(DEBUG_MODE_KEY) === 'true';
  } catch {
    return false;
  }
}

const ONBOARDING_KEY = 'fastowl-onboarding-complete';

// First-run onboarding gate. Persisted like the theme/debug flags so it
// survives restarts. Defaults to false → the wizard shows on a true first
// run; `useInitialDataLoad` flips it to true for returning users who already
// have at least one workspace, so they never see the wizard.
function getInitialOnboardingComplete(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return localStorage.getItem(ONBOARDING_KEY) === 'true';
  } catch {
    return false;
  }
}

const WORKSPACE_PREF_KEY = 'fastowl-current-workspace';

// Last-selected workspace id, so a switch survives an app restart instead of
// snapping back to the first workspace. Validated against the fetched list on
// load (the id may have been deleted elsewhere).
function getInitialWorkspaceId(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return localStorage.getItem(WORKSPACE_PREF_KEY);
  } catch {
    return null;
  }
}

function persistWorkspaceId(id: string | null) {
  try {
    if (id) localStorage.setItem(WORKSPACE_PREF_KEY, id);
    else localStorage.removeItem(WORKSPACE_PREF_KEY);
  } catch {
    // ignore quota / privacy-mode issues
  }
}

// Apply theme to document
function applyTheme(theme: Theme) {
  if (typeof document === 'undefined') return;

  const root = document.documentElement;
  let effectiveTheme = theme;

  if (theme === 'system') {
    effectiveTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  if (effectiveTheme === 'dark') {
    root.classList.add('dark');
  } else {
    root.classList.remove('dark');
  }
}

interface WorkspaceState {
  // Current workspace
  currentWorkspaceId: string | null;
  workspaces: Workspace[];

  // Environments
  environments: Environment[];

  // Agents (kept for internal use but not exposed in UI)
  agents: Agent[];

  // Tasks
  tasks: Task[];

  // Repositories (watched repos)
  repositories: WatchedRepo[];

  // Inbox
  inboxItems: InboxItem[];
  unreadCount: number;

  // UI State
  sidebarCollapsed: boolean;
  activePanel: 'inbox' | 'queue' | 'github' | 'settings' | 'debug';
  // Developer-only Debug panel visibility (sidebar entry + reachable view).
  debugMode: boolean;
  // Which bucket of the inbox is visible when activePanel === 'inbox'.
  // 'active' = items that still want attention (unread + read-but-not-actioned);
  // 'archive' = actioned items, kept around for history/audit.
  inboxView: 'active' | 'archive';
  selectedTaskId: string | null;
  theme: Theme;
  // Whether the create-workspace modal is open (triggered from the sidebar
  // switcher and the Settings empty state).
  createWorkspaceOpen: boolean;
  // First-run onboarding gate. When false, App renders the OnboardingWizard
  // instead of MainLayout.
  onboardingComplete: boolean;
  // GitHub connection status for the current workspace, kept in sync so the
  // global status banner can react app-wide. null = not yet checked.
  githubStatus: GitHubStatus | null;

  // Actions
  setCurrentWorkspace: (id: string | null) => void;
  setWorkspaces: (workspaces: Workspace[]) => void;
  addWorkspace: (workspace: Workspace) => void;
  setCreateWorkspaceOpen: (open: boolean) => void;
  setOnboardingComplete: (done: boolean) => void;
  setGitHubStatus: (status: GitHubStatus | null) => void;

  setEnvironments: (environments: Environment[]) => void;
  updateEnvironment: (id: string, updates: Partial<Environment>) => void;
  addEnvironment: (environment: Environment) => void;

  setAgents: (agents: Agent[]) => void;
  updateAgent: (id: string, updates: Partial<Agent>) => void;
  addAgent: (agent: Agent) => void;
  removeAgent: (id: string) => void;

  setTasks: (tasks: Task[]) => void;
  updateTask: (id: string, updates: Partial<Task>) => void;
  addTask: (task: Task) => void;
  removeTask: (id: string) => void;

  setRepositories: (repos: WatchedRepo[]) => void;

  setInboxItems: (items: InboxItem[]) => void;
  addInboxItem: (item: InboxItem) => void;
  updateInboxItem: (id: string, updates: Partial<InboxItem>) => void;
  markInboxRead: (id: string) => void;
  markInboxActioned: (id: string) => void;
  removeInboxItem: (id: string) => void;
  markAllInboxRead: () => void;

  toggleSidebar: () => void;
  setActivePanel: (panel: 'inbox' | 'queue' | 'github' | 'settings' | 'debug') => void;
  setDebugMode: (on: boolean) => void;
  setInboxView: (view: 'active' | 'archive') => void;
  selectTask: (id: string | null) => void;
  setTheme: (theme: Theme) => void;
}

export const useWorkspaceStore = create<WorkspaceState>((set) => ({
  // Initial state
  currentWorkspaceId: getInitialWorkspaceId(),
  workspaces: [],
  environments: [],
  agents: [],
  tasks: [],
  repositories: [],
  inboxItems: [],
  unreadCount: 0,
  sidebarCollapsed: false,
  activePanel: 'inbox',
  debugMode: getInitialDebugMode(),
  inboxView: 'active',
  selectedTaskId: null,
  theme: getInitialTheme(),
  createWorkspaceOpen: false,
  onboardingComplete: getInitialOnboardingComplete(),
  githubStatus: null,

  // Actions
  setCurrentWorkspace: (id) => {
    persistWorkspaceId(id);
    set({ currentWorkspaceId: id });
  },

  setWorkspaces: (workspaces) => set({ workspaces }),

  addWorkspace: (workspace) =>
    set((state) => ({ workspaces: [...state.workspaces, workspace] })),

  setCreateWorkspaceOpen: (createWorkspaceOpen) => set({ createWorkspaceOpen }),

  setOnboardingComplete: (done) => {
    try {
      localStorage.setItem(ONBOARDING_KEY, done ? 'true' : 'false');
    } catch {
      // ignore quota / privacy-mode issues
    }
    set({ onboardingComplete: done });
  },

  setGitHubStatus: (githubStatus) => set({ githubStatus }),

  setEnvironments: (environments) => set({ environments }),

  updateEnvironment: (id, updates) =>
    set((state) => ({
      environments: state.environments.map((e) =>
        e.id === id ? { ...e, ...updates } : e
      ),
    })),

  addEnvironment: (environment) =>
    set((state) =>
      state.environments.some((e) => e.id === environment.id)
        ? { environments: state.environments.map((e) => (e.id === environment.id ? environment : e)) }
        : { environments: [...state.environments, environment] }
    ),

  setAgents: (agents) => set({ agents }),

  updateAgent: (id, updates) =>
    set((state) => ({
      agents: state.agents.map((a) =>
        a.id === id ? { ...a, ...updates } : a
      ),
    })),

  addAgent: (agent) =>
    set((state) => ({ agents: [...state.agents, agent] })),

  removeAgent: (id) =>
    set((state) => ({
      agents: state.agents.filter((a) => a.id !== id),
    })),

  setTasks: (tasks) => set({ tasks }),

  updateTask: (id, updates) =>
    set((state) => ({
      tasks: state.tasks.map((t) =>
        t.id === id ? { ...t, ...updates } : t
      ),
    })),

  addTask: (task) =>
    set((state) => ({ tasks: [...state.tasks, task] })),

  removeTask: (id) =>
    set((state) => ({
      tasks: state.tasks.filter((t) => t.id !== id),
      selectedTaskId: state.selectedTaskId === id ? null : state.selectedTaskId,
    })),

  setRepositories: (repos) => set({ repositories: repos }),

  setInboxItems: (items) =>
    set({
      inboxItems: items,
      unreadCount: items.filter((i) => i.status === 'unread').length,
    }),

  addInboxItem: (item) =>
    set((state) => ({
      inboxItems: [item, ...state.inboxItems],
      unreadCount: state.unreadCount + (item.status === 'unread' ? 1 : 0),
    })),

  updateInboxItem: (id, updates) =>
    set((state) => {
      const existing = state.inboxItems.find((i) => i.id === id);
      if (!existing) return state;
      const next = { ...existing, ...updates };
      // Keep `unreadCount` honest when status transitions involve
      // unread. Backend's permissionInbox coalesces these.
      let unreadDelta = 0;
      if (existing.status === 'unread' && next.status !== 'unread') unreadDelta = -1;
      else if (existing.status !== 'unread' && next.status === 'unread') unreadDelta = 1;
      return {
        inboxItems: state.inboxItems.map((i) => (i.id === id ? next : i)),
        unreadCount: Math.max(0, state.unreadCount + unreadDelta),
      };
    }),

  markInboxRead: (id) =>
    set((state) => ({
      inboxItems: state.inboxItems.map((i) =>
        i.id === id ? { ...i, status: 'read' as const } : i
      ),
      unreadCount: Math.max(0, state.unreadCount - 1),
    })),

  markInboxActioned: (id) =>
    set((state) => {
      const existing = state.inboxItems.find((i) => i.id === id);
      const wasUnread = existing?.status === 'unread';
      return {
        inboxItems: state.inboxItems.map((i) =>
          i.id === id ? { ...i, status: 'actioned' as const } : i
        ),
        unreadCount: wasUnread
          ? Math.max(0, state.unreadCount - 1)
          : state.unreadCount,
      };
    }),

  removeInboxItem: (id) =>
    set((state) => {
      const existing = state.inboxItems.find((i) => i.id === id);
      const wasUnread = existing?.status === 'unread';
      return {
        inboxItems: state.inboxItems.filter((i) => i.id !== id),
        unreadCount: wasUnread
          ? Math.max(0, state.unreadCount - 1)
          : state.unreadCount,
      };
    }),

  markAllInboxRead: () =>
    set((state) => ({
      inboxItems: state.inboxItems.map((i) =>
        i.status === 'unread' ? { ...i, status: 'read' as const } : i
      ),
      unreadCount: 0,
    })),

  toggleSidebar: () =>
    set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),

  setActivePanel: (panel) => set({ activePanel: panel }),

  setDebugMode: (on) => {
    try {
      localStorage.setItem(DEBUG_MODE_KEY, on ? 'true' : 'false');
    } catch {
      // ignore quota / privacy-mode issues
    }
    // Leaving debug mode while sitting on the Debug panel would strand the
    // user on a now-hidden view — bounce them back to the inbox.
    set((state) => ({
      debugMode: on,
      activePanel: !on && state.activePanel === 'debug' ? 'inbox' : state.activePanel,
    }));
  },

  setInboxView: (view) => set({ inboxView: view }),

  selectTask: (id) => set({ selectedTaskId: id }),

  setTheme: (theme) => {
    localStorage.setItem('fastowl-theme', theme);
    applyTheme(theme);
    set({ theme });
  },
}));

// Apply initial theme on load
if (typeof window !== 'undefined') {
  const initialTheme = getInitialTheme();
  applyTheme(initialTheme);

  // Listen for system theme changes when in 'system' mode
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    const state = useWorkspaceStore.getState();
    if (state.theme === 'system') {
      applyTheme('system');
    }
  });
}
