import { create } from 'zustand';
import type { Workspace, Environment, Task } from '@fastowl/shared';
import type { GitHubStatus, GitHubUser, PostHogCodeStatus } from '../lib/api';

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

  // Tasks
  tasks: Task[];

  // Repositories (watched repos)
  repositories: WatchedRepo[];

  // UI State
  sidebarCollapsed: boolean;
  activePanel: 'queue' | 'my_prs' | 'reviews' | 'merge_queue' | 'settings' | 'debug';
  // Developer-only Debug panel visibility (sidebar entry + reachable view).
  debugMode: boolean;
  selectedTaskId: string | null;
  theme: Theme;
  // Whether the create-workspace modal is open (triggered from the sidebar
  // switcher and the Settings empty state).
  createWorkspaceOpen: boolean;
  // First-run onboarding gate. When false, App renders the OnboardingWizard
  // instead of MainLayout.
  onboardingComplete: boolean;
  // Integration connection state for the current workspace, preloaded at
  // startup (useSystemStatus) so Settings → Integrations renders instantly
  // instead of fetching on open. null = not yet checked.
  githubStatus: GitHubStatus | null;
  githubUser: GitHubUser | null;
  posthogStatus: PostHogCodeStatus | null;

  // Actions
  setCurrentWorkspace: (id: string | null) => void;
  setWorkspaces: (workspaces: Workspace[]) => void;
  addWorkspace: (workspace: Workspace) => void;
  setCreateWorkspaceOpen: (open: boolean) => void;
  setOnboardingComplete: (done: boolean) => void;
  setGitHubStatus: (status: GitHubStatus | null) => void;
  setGitHubUser: (user: GitHubUser | null) => void;
  setPostHogStatus: (status: PostHogCodeStatus | null) => void;

  setEnvironments: (environments: Environment[]) => void;
  updateEnvironment: (id: string, updates: Partial<Environment>) => void;
  addEnvironment: (environment: Environment) => void;

  setTasks: (tasks: Task[]) => void;
  // Reconcile the task list for one workspace against a fresh server fetch,
  // used after a WebSocket reconnect to replay status changes whose broadcasts
  // we missed while offline. Unlike setTasks it preserves locally-loaded rich
  // fields (transcript) the list endpoint omits for egress.
  reconcileTasks: (tasks: Task[], workspaceId: string) => void;
  updateTask: (id: string, updates: Partial<Task>) => void;
  addTask: (task: Task) => void;
  removeTask: (id: string) => void;

  setRepositories: (repos: WatchedRepo[]) => void;

  toggleSidebar: () => void;
  setActivePanel: (
    panel: 'queue' | 'my_prs' | 'reviews' | 'merge_queue' | 'settings' | 'debug'
  ) => void;
  setDebugMode: (on: boolean) => void;
  selectTask: (id: string | null) => void;
  setTheme: (theme: Theme) => void;
}

export const useWorkspaceStore = create<WorkspaceState>((set) => ({
  // Initial state
  currentWorkspaceId: getInitialWorkspaceId(),
  workspaces: [],
  environments: [],
  tasks: [],
  repositories: [],
  sidebarCollapsed: false,
  activePanel: 'my_prs',
  debugMode: getInitialDebugMode(),
  selectedTaskId: null,
  theme: getInitialTheme(),
  createWorkspaceOpen: false,
  onboardingComplete: getInitialOnboardingComplete(),
  githubStatus: null,
  githubUser: null,
  posthogStatus: null,

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

  setGitHubUser: (githubUser) => set({ githubUser }),

  setPostHogStatus: (posthogStatus) => set({ posthogStatus }),

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

  setTasks: (tasks) => set({ tasks }),

  reconcileTasks: (incoming, workspaceId) =>
    set((state) => {
      const localById = new Map(state.tasks.map((t) => [t.id, t]));
      const incomingIds = new Set(incoming.map((t) => t.id));
      // Rebuild in the server's order, re-attaching any rich local-only fields
      // (transcript) the list endpoint drops for egress reasons.
      const next: Task[] = incoming.map((fresh) => {
        const local = localById.get(fresh.id);
        if (!local) return fresh;
        return {
          ...fresh,
          transcript: local.transcript ?? fresh.transcript,
        };
      });
      // Keep local tasks the fetch didn't cover (a different workspace's load);
      // tasks of *this* workspace absent from the fetch were deleted offline.
      for (const local of state.tasks) {
        if (local.workspaceId !== workspaceId && !incomingIds.has(local.id)) {
          next.push(local);
        }
      }
      return {
        tasks: next,
        // Drop the selection if the selected task vanished server-side.
        selectedTaskId:
          state.selectedTaskId && !next.some((t) => t.id === state.selectedTaskId)
            ? null
            : state.selectedTaskId,
      };
    }),

  updateTask: (id, updates) =>
    set((state) => ({
      tasks: state.tasks.map((t) =>
        t.id === id ? { ...t, ...updates } : t
      ),
    })),

  addTask: (task) =>
    set((state) =>
      // Idempotent: a task can arrive from several sources (optimistic create,
      // the task:created broadcast, an on-demand fetch). Skip if we already
      // have it rather than appending a duplicate or clobbering richer local
      // state (e.g. a loaded transcript) the incoming copy lacks.
      state.tasks.some((t) => t.id === task.id)
        ? state
        : { tasks: [...state.tasks, task] }
    ),

  removeTask: (id) =>
    set((state) => ({
      tasks: state.tasks.filter((t) => t.id !== id),
      selectedTaskId: state.selectedTaskId === id ? null : state.selectedTaskId,
    })),

  setRepositories: (repos) => set({ repositories: repos }),

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
    // user on a now-hidden view — bounce them back to the GitHub panel.
    set((state) => ({
      debugMode: on,
      activePanel: !on && state.activePanel === 'debug' ? 'my_prs' : state.activePanel,
    }));
  },

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
