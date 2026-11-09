import type { Space, SpacesTeam } from '@talyn/shared';

import type { Preferences } from './controller';

/**
 * Where the app is, like web's `AppContext`: one of my workspaces, or a
 * team's space. In a space the selected workspace keeps its value, so every
 * screen that reads it keeps working.
 */
export type AppContext = { kind: 'personal'; workspaceId: string | null } | { kind: 'space'; spaceId: string };

export type ActiveContext =
  | { kind: 'personal'; workspaceId: string | null }
  | { kind: 'space'; spaceId: string; space: Space; team: SpacesTeam }
  /** The saved choice, the features or my teams are still loading. */
  | { kind: 'pending' };

export interface ContextSnapshot { status: 'idle' | 'loading' | 'ready'; spaceId: string | null }

export function contextKey(environment: string, user: string) {
  return `talyn.context.${environment}.${encodeURIComponent(user)}`;
}

/** The saved space of an account. Null is Personal. */
export class ContextController {
  private snapshot: ContextSnapshot = { status: 'idle', spaceId: null };
  private user: string | null = null;
  private generation = 0;
  private listeners = new Set<() => void>();
  private writes: Promise<unknown> = Promise.resolve();
  constructor(private preferences: Preferences, private environment: string) {}

  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(next: ContextSnapshot) {
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
  private write(operation: () => Promise<void>) {
    const result = this.writes.then(operation);
    this.writes = result.catch(() => {});
    return result;
  }
  async load(user: string) {
    if (this.user === user && this.snapshot.status !== 'idle') return;
    const generation = ++this.generation;
    this.user = user;
    this.publish({ status: 'loading', spaceId: null });
    let spaceId: string | null = null;
    try {
      await this.writes;
      spaceId = await this.preferences.getItem(contextKey(this.environment, user));
    } catch { /* A broken read is Personal. */ }
    if (generation === this.generation) this.publish({ status: 'ready', spaceId: spaceId || null });
  }
  /** The choice shows at once. A failed write only means it is not remembered. */
  async select(spaceId: string | null) {
    const user = this.user;
    if (!user || this.snapshot.status !== 'ready' || this.snapshot.spaceId === spaceId) return;
    this.publish({ status: 'ready', spaceId });
    const key = contextKey(this.environment, user);
    await this.write(() => spaceId ? this.preferences.setItem(key, spaceId) : this.preferences.removeItem(key)).catch(() => {});
  }
  clear(priorUser: string | null): Promise<void> {
    this.generation++;
    this.user = null;
    this.publish({ status: 'idle', spaceId: null });
    return priorUser ? this.write(() => this.preferences.removeItem(contextKey(this.environment, priorUser))) : Promise.resolve();
  }
  dispose() { this.generation++; this.listeners.clear(); this.user = null; this.snapshot = { status: 'idle', spaceId: null }; }
}

export interface ResolveInput {
  saved: ContextSnapshot;
  /** Null while the features load. */
  offered: boolean | null;
  teams: readonly SpacesTeam[] | undefined;
  teamsLoading: boolean;
  workspaceId: string | null;
}

/**
 * The context to draw from the saved choice. A space that is gone (archived,
 * or I left its team) is forgotten. Spaces turned off, or my teams failing to
 * load, fall back to Personal and keep the choice, so it comes back.
 */
export function resolveContext({ saved, offered, teams, teamsLoading, workspaceId }: ResolveInput): { context: ActiveContext; forget: boolean } {
  const personal = { context: { kind: 'personal', workspaceId } as const, forget: false };
  if (saved.status !== 'ready') return { context: { kind: 'pending' }, forget: false };
  if (!saved.spaceId) return personal;
  if (offered === null) return { context: { kind: 'pending' }, forget: false };
  if (!offered) return personal;
  if (!teams) return teamsLoading ? { context: { kind: 'pending' }, forget: false } : personal;
  for (const team of teams) {
    const space = team.spaces.find((item) => item.id === saved.spaceId);
    if (space) return { context: { kind: 'space', spaceId: space.id, space, team }, forget: false };
  }
  return { context: { kind: 'personal', workspaceId }, forget: true };
}

export function contextsEqual(a: AppContext | ActiveContext, b: AppContext | ActiveContext): boolean {
  if (a.kind === 'personal' && b.kind === 'personal') return a.workspaceId === b.workspaceId;
  if (a.kind === 'space' && b.kind === 'space') return a.spaceId === b.spaceId;
  return false;
}
