import { create } from 'zustand';
import type {
  Space,
  SpacePresenceMember,
  SpaceRepository,
  SpaceSessionRow,
  SpacesTeam,
  SpaceTaskRow,
  TaskStatus,
  TeamMember,
  Workbench,
  WorkbenchChat,
} from '@talyn/shared';
import { api } from '../lib/api';

export interface SpaceList<T> {
  items: T[];
  hiddenCount: number;
  loaded: boolean;
  error: string | null;
}

const EMPTY_LIST: SpaceList<never> = { items: [], hiddenCount: 0, loaded: false, error: null };

export function emptySpaceList<T>(): SpaceList<T> {
  return EMPTY_LIST as SpaceList<T>;
}

export type SpacesDialog =
  | { kind: 'createTeam' }
  | { kind: 'createSpace'; teamId: string }
  | { kind: 'addRepository'; spaceId: string }
  | { kind: 'move'; target: 'session' | 'task'; id: string; spaceId: string | null };

export type ExtraLoadState = 'loading' | 'failed';

interface SpacesState {
  teams: SpacesTeam[] | null;
  teamsError: string | null;
  selfUserId: string | null;
  members: Record<string, TeamMember[]>;
  sessions: Record<string, SpaceList<SpaceSessionRow>>;
  tasks: Record<string, SpaceList<SpaceTaskRow>>;
  repositories: Record<string, SpaceRepository[]>;
  presence: Record<string, SpacePresenceMember[]>;
  extraLoads: Record<string, ExtraLoadState>;
  settingsTeamId: string | null;
  dialog: SpacesDialog | null;

  setTeams: (teams: SpacesTeam[]) => void;
  setTeamsError: (error: string | null) => void;
  upsertTeam: (team: SpacesTeam) => void;
  upsertSpace: (space: Space) => void;
  removeSpace: (spaceId: string) => void;
  setSelfUserId: (id: string | null) => void;
  setMembers: (teamId: string, members: TeamMember[]) => void;
  setSessions: (spaceId: string, list: Partial<SpaceList<SpaceSessionRow>>) => void;
  setTasks: (spaceId: string, list: Partial<SpaceList<SpaceTaskRow>>) => void;
  setRepositories: (spaceId: string, repos: SpaceRepository[]) => void;
  setPresence: (spaceId: string, members: SpacePresenceMember[]) => void;
  setExtraLoad: (workbenchId: string, state: ExtraLoadState | null) => void;
  setSettingsTeamId: (teamId: string | null) => void;
  openDialog: (dialog: SpacesDialog | null) => void;
  // Return true when a new row needs its creator from the server.
  applyWorkbench: (workbench: Workbench) => boolean;
  applyChat: (chat: WorkbenchChat) => void;
  removeSession: (workbenchId: string) => void;
  applyTaskStatus: (taskId: string, status: TaskStatus) => void;
  applyTaskUpdate: (taskId: string, updates: Record<string, unknown>) => boolean;
  removeTask: (taskId: string) => void;
}

export const useSpacesStore = create<SpacesState>((set, get) => ({
  teams: null,
  teamsError: null,
  selfUserId: null,
  members: {},
  sessions: {},
  tasks: {},
  repositories: {},
  presence: {},
  extraLoads: {},
  settingsTeamId: null,
  dialog: null,

  setTeams: (teams) => set({ teams, teamsError: null }),
  setTeamsError: (teamsError) => set({ teamsError }),
  upsertTeam: (team) =>
    set((s) => {
      const teams = s.teams ?? [];
      return {
        teams: teams.some((t) => t.id === team.id) ? teams.map((t) => (t.id === team.id ? team : t)) : [...teams, team],
      };
    }),
  upsertSpace: (space) =>
    set((s) => ({
      teams: (s.teams ?? []).map((t) => {
        if (t.id !== space.teamId) return t;
        if (space.archivedAt) return { ...t, spaces: t.spaces.filter((x) => x.id !== space.id) };
        const has = t.spaces.some((x) => x.id === space.id);
        return { ...t, spaces: has ? t.spaces.map((x) => (x.id === space.id ? space : x)) : [...t.spaces, space] };
      }),
    })),
  removeSpace: (spaceId) =>
    set((s) => ({
      teams: (s.teams ?? []).map((t) => ({ ...t, spaces: t.spaces.filter((x) => x.id !== spaceId) })),
    })),
  setSelfUserId: (selfUserId) => set({ selfUserId }),
  setMembers: (teamId, members) => set((s) => ({ members: { ...s.members, [teamId]: members } })),
  setSessions: (spaceId, list) =>
    set((s) => ({ sessions: { ...s.sessions, [spaceId]: { ...(s.sessions[spaceId] ?? EMPTY_LIST), ...list } } })),
  setTasks: (spaceId, list) =>
    set((s) => ({ tasks: { ...s.tasks, [spaceId]: { ...(s.tasks[spaceId] ?? EMPTY_LIST), ...list } } })),
  setRepositories: (spaceId, repos) => set((s) => ({ repositories: { ...s.repositories, [spaceId]: repos } })),
  setPresence: (spaceId, members) => set((s) => ({ presence: { ...s.presence, [spaceId]: members } })),
  setExtraLoad: (workbenchId, state) =>
    set((s) => {
      const extraLoads = { ...s.extraLoads };
      if (state) extraLoads[workbenchId] = state;
      else delete extraLoads[workbenchId];
      return { extraLoads };
    }),
  setSettingsTeamId: (settingsTeamId) => set({ settingsTeamId }),
  openDialog: (dialog) => set({ dialog }),

  applyWorkbench: (wb) => {
    const spaceId = wb.spaceId ?? null;
    let missing = false;
    set((s) => {
      const sessions = { ...s.sessions };
      let changed = false;
      for (const [id, list] of Object.entries(s.sessions)) {
        const index = list.items.findIndex((row) => row.id === wb.id);
        if (index === -1) {
          if (id === spaceId && list.loaded && !wb.archivedAt) missing = true;
          continue;
        }
        changed = true;
        if (id !== spaceId) {
          sessions[id] = { ...list, items: list.items.filter((row) => row.id !== wb.id) };
          continue;
        }
        const items = list.items.slice();
        items[index] = patchSessionRow(items[index], wb);
        sessions[id] = { ...list, items };
      }
      return changed ? { sessions } : s;
    });
    return missing;
  },

  applyChat: (chat) =>
    set((s) => {
      const sessions = { ...s.sessions };
      let changed = false;
      for (const [id, list] of Object.entries(s.sessions)) {
        const index = list.items.findIndex((row) => row.id === chat.workbenchId);
        if (index === -1) continue;
        const running = chat.status === 'running';
        if (list.items[index].running === running) continue;
        const items = list.items.slice();
        items[index] = { ...items[index], running, lastActivityAt: chat.updatedAt ?? items[index].lastActivityAt };
        sessions[id] = { ...list, items };
        changed = true;
      }
      return changed ? { sessions } : s;
    }),

  removeSession: (workbenchId) =>
    set((s) => {
      const sessions = { ...s.sessions };
      let changed = false;
      for (const [id, list] of Object.entries(s.sessions)) {
        if (!list.items.some((row) => row.id === workbenchId)) continue;
        sessions[id] = { ...list, items: list.items.filter((row) => row.id !== workbenchId) };
        changed = true;
      }
      return changed ? { sessions } : s;
    }),

  applyTaskStatus: (taskId, status) => {
    get().applyTaskUpdate(taskId, { status });
  },

  applyTaskUpdate: (taskId, updates) => {
    let missing = false;
    set((s) => {
      const tasks = { ...s.tasks };
      let changed = false;
      const moved = 'spaceId' in updates;
      for (const [id, list] of Object.entries(s.tasks)) {
        const index = list.items.findIndex((row) => row.id === taskId);
        if (index === -1) {
          if (moved && updates.spaceId === id && list.loaded) missing = true;
          continue;
        }
        changed = true;
        if (moved && updates.spaceId !== id) {
          tasks[id] = { ...list, items: list.items.filter((row) => row.id !== taskId) };
          continue;
        }
        const items = list.items.slice();
        const { spaceId: _spaceId, ...rest } = updates;
        items[index] = { ...items[index], ...(rest as Partial<SpaceTaskRow>) };
        tasks[id] = { ...list, items };
      }
      return changed ? { tasks } : s;
    });
    return missing;
  },

  removeTask: (taskId) =>
    set((s) => {
      const tasks = { ...s.tasks };
      let changed = false;
      for (const [id, list] of Object.entries(s.tasks)) {
        if (!list.items.some((row) => row.id === taskId)) continue;
        tasks[id] = { ...list, items: list.items.filter((row) => row.id !== taskId) };
        changed = true;
      }
      return changed ? { tasks } : s;
    }),
}));

function patchSessionRow(row: SpaceSessionRow, wb: Workbench): SpaceSessionRow {
  const running = wb.chats ? wb.chats.some((c) => c.status === 'running') : row.running;
  return {
    ...row,
    kind: wb.kind ?? row.kind,
    threadId: wb.threadId === undefined ? row.threadId : wb.threadId,
    name: wb.name,
    title: wb.title ?? null,
    status: wb.status,
    sandboxState: wb.sandboxState,
    branch: wb.branch,
    baseBranch: wb.baseBranch,
    running,
    pullRequest: wb.pr ? { number: wb.pr.number, state: wb.pr.state, url: wb.pr.url } : row.pullRequest,
    archivedAt: wb.archivedAt,
    updatedAt: wb.updatedAt,
  };
}

function message(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

export async function loadTeams(): Promise<void> {
  try {
    useSpacesStore.getState().setTeams(await api.teams.list());
  } catch (err) {
    const store = useSpacesStore.getState();
    store.setTeamsError(message(err, 'Could not load your teams.'));
    if (store.teams === null) store.setTeams([]);
  }
}

export async function loadMembers(teamId: string): Promise<void> {
  try {
    useSpacesStore.getState().setMembers(teamId, await api.teams.members(teamId));
  } catch {
    // Keep the last member list until the next load.
  }
}

export async function loadSpaceSessions(spaceId: string): Promise<void> {
  try {
    const res = await api.spaces.sessions(spaceId);
    useSpacesStore.getState().setSessions(spaceId, { items: res.items, hiddenCount: res.hiddenCount, loaded: true, error: null });
  } catch (err) {
    useSpacesStore.getState().setSessions(spaceId, { loaded: true, error: message(err, 'Could not load the sessions.') });
  }
}

export async function loadSpaceTasks(spaceId: string): Promise<void> {
  try {
    const res = await api.spaces.tasks(spaceId);
    useSpacesStore.getState().setTasks(spaceId, { items: res.items, hiddenCount: res.hiddenCount, loaded: true, error: null });
  } catch (err) {
    useSpacesStore.getState().setTasks(spaceId, { loaded: true, error: message(err, 'Could not load the tasks.') });
  }
}

export async function loadSpaceRepositories(spaceId: string): Promise<SpaceRepository[]> {
  try {
    const repos = await api.spaces.repositories(spaceId);
    useSpacesStore.getState().setRepositories(spaceId, repos);
    return repos;
  } catch {
    return useSpacesStore.getState().repositories[spaceId] ?? [];
  }
}

export interface SpaceRef {
  space: Space;
  team: SpacesTeam;
}

export function findSpace(teams: SpacesTeam[] | null, spaceId: string | null | undefined): SpaceRef | null {
  if (!teams || !spaceId) return null;
  for (const team of teams) {
    const space = team.spaces.find((s) => s.id === spaceId);
    if (space) return { space, team };
  }
  return null;
}

export function findSessionRow(sessions: Record<string, SpaceList<SpaceSessionRow>>, workbenchId: string): SpaceSessionRow | null {
  for (const list of Object.values(sessions)) {
    const row = list.items.find((r) => r.id === workbenchId);
    if (row) return row;
  }
  return null;
}
