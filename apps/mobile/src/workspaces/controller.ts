export interface WorkspaceChoice { id: string; name: string }
export interface Preferences {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}
export interface WorkspaceSnapshot {
  status: 'idle' | 'loading' | 'ready' | 'error';
  choices: WorkspaceChoice[];
  selected: string | null;
}

export class WorkspaceController {
  private snapshot: WorkspaceSnapshot = { status: 'idle', choices: [], selected: null };
  private user: string | null = null;
  private generation = 0;
  private listeners = new Set<() => void>();
  private writes: Promise<unknown> = Promise.resolve();
  constructor(private preferences: Preferences, private environment: string,
    private list: () => Promise<WorkspaceChoice[]>) {}

  private key(user: string) { return `talyn.workspace.${this.environment}.${encodeURIComponent(user)}`; }
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(next: WorkspaceSnapshot) {
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
  private write(operation: () => Promise<void>) {
    const result = this.writes.then(operation);
    this.writes = result.catch(() => {});
    return result;
  }
  async load(user: string) {
    const generation = ++this.generation;
    this.user = user;
    this.publish({ status: 'loading', choices: [], selected: null });
    try {
      await this.writes;
      const [choices, selected] = await Promise.all([this.list(), this.preferences.getItem(this.key(user))]);
      if (generation !== this.generation) return;
      const valid = choices.some((choice) => choice.id === selected) ? selected : null;
      if (selected && !valid) await this.write(() => this.preferences.removeItem(this.key(user)));
      if (generation !== this.generation) return;
      this.publish({ status: 'ready', choices: choices.map(({ id, name }) => ({ id, name })), selected: valid });
    } catch {
      if (generation === this.generation) this.publish({ status: 'error', choices: [], selected: null });
    }
  }
  async select(id: string) {
    const user = this.user;
    const generation = this.generation;
    if (!user || this.snapshot.status !== 'ready' || !this.snapshot.choices.some((choice) => choice.id === id)) return;
    try {
      await this.write(() => this.preferences.setItem(this.key(user), id));
      if (generation === this.generation) this.publish({ ...this.snapshot, selected: id });
    } catch {
      if (generation === this.generation) this.publish({ ...this.snapshot, status: 'error', selected: null });
    }
  }
  clear(priorUser: string | null): Promise<void> {
    this.generation++;
    this.user = null;
    this.publish({ status: 'idle', choices: [], selected: null });
    return priorUser ? this.write(() => this.preferences.removeItem(this.key(priorUser))) : Promise.resolve();
  }
  dispose() { this.generation++; this.listeners.clear(); this.user = null; this.snapshot = { status: 'idle', choices: [], selected: null }; }
}
