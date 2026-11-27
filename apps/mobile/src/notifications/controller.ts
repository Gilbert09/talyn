import {
  isMobileNotificationPayload,
  isMobileNotificationResolution,
  normalizeMobileNotificationPreferences,
  type MobileInstallation,
  type MobileNotificationDestination,
  type MobileNotificationPayload,
  type MobileNotificationPreferences,
  type MobileNotificationPreferencesResult,
  type MobileNotificationResolution,
  type RegisterMobileInstallationInput,
} from '@talyn/shared';

export type PushState = 'disabled' | 'loading' | 'ready' | 'denied' | 'unavailable' | 'failed';
export interface PushSnapshot {
  state: PushState;
  preferences: MobileNotificationPreferences | null;
  providerAvailable: boolean;
  tapIssue: string | null;
}
type PushSettingsSnapshot = Omit<PushSnapshot, 'tapIssue'>;
export interface PushScope { user: string; workspace: string | null }
export interface PushGateway {
  registerInstallation(input: RegisterMobileInstallationInput): Promise<MobileInstallation>;
  removeInstallation(id: string): Promise<void>;
  getPreferences(workspace: string): Promise<MobileNotificationPreferencesResult>;
  updatePreferences(input: MobileNotificationPreferences): Promise<MobileNotificationPreferencesResult>;
  resolveNotification(id: string): Promise<MobileNotificationResolution>;
}
export interface PushDevice {
  available(): boolean;
  permission(request: boolean): Promise<boolean>;
  channels(): Promise<void>;
  token(): Promise<string>;
  metadata(): Omit<RegisterMobileInstallationInput, 'schemaVersion' | 'installationId' | 'workspaceId' | 'provider' | 'token'>;
  installation(user: string, create: boolean): Promise<string | null>;
  clearInstallation(user: string): Promise<void>;
}

export const notificationPath = (destination: MobileNotificationDestination) =>
  `/${destination.kind === 'pull_request' ? 'attention' : destination.kind === 'thread' ? 'threads' : 'sessions'}/${destination.entityId}`;

export class NotificationController {
  private snapshot: PushSnapshot = { state: 'disabled', preferences: null, providerAvailable: false, tapIssue: null };
  private listeners = new Set<() => void>();
  private scope: PushScope | null = null;
  private generation = 0;
  private pending: MobileNotificationPayload | null = null;
  private seen = new Set<string>();
  private opening: string | null = null;
  private disposed = false;
  private operation: Promise<unknown> = Promise.resolve();
  private navigate: (path: string) => void = () => {};
  private navigationReady = false;
  private visible = '';
  constructor(private api: PushGateway, private device: PushDevice,
    private online: () => boolean, private fetchDestination: (destination: MobileNotificationDestination) => Promise<void>,
    private now = Date.now) {}

  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(next: Partial<PushSnapshot>) {
    if (this.disposed) return;
    this.snapshot = { ...this.snapshot, ...next };
    this.listeners.forEach((listener) => listener());
  }
  private current(generation: number) { return !this.disposed && generation === this.generation; }
  private queue<T>(work: () => Promise<T>) {
    const result = this.operation.then(work);
    this.operation = result.catch(() => {});
    return result;
  }
  setNavigation(navigate: (path: string) => void, visible: string) {
    this.navigate = navigate; this.visible = visible; this.navigationReady = true; void this.openPending();
  }
  setScope(scope: PushScope | null) {
    if (this.scope?.user === scope?.user && this.scope?.workspace === scope?.workspace) return;
    const priorUser = this.scope?.user;
    this.scope = scope;
    this.generation++;
    if (priorUser && scope?.user && priorUser !== scope.user) { this.pending = null; this.seen.clear(); }
    this.publish({ state: 'disabled', preferences: null, providerAvailable: false, tapIssue: null });
    if (scope) { void this.refresh(); void this.openPending(); }
  }
  refresh = async () => {
    if (this.scope?.workspace) await this.loadWorkspaceSettings(this.scope.workspace);
  };
  loadWorkspaceSettings = (workspace: string) => this.updateWorkspaceSettings(workspace);
  saveWorkspaceSettings = (input: MobileNotificationPreferences, requestPermission = false) =>
    this.updateWorkspaceSettings(input.workspaceId, input, requestPermission);

  private updateWorkspaceSettings(workspace: string, input?: MobileNotificationPreferences, requestPermission = false) {
    const scope = this.scope;
    const generation = this.generation;
    if (!scope || !this.online()) return Promise.resolve(null);
    return this.queue(async (): Promise<PushSettingsSnapshot | null> => {
      if (!this.current(generation)) return null;
      const active = scope.workspace === workspace;
      let preferences: MobileNotificationPreferences | null = null;
      let providerAvailable = false;
      let state: PushState = 'failed';
      if (input && active) this.publish({ state: 'loading' });
      try {
        const result = input ? await this.api.updatePreferences(input) : await this.api.getPreferences(workspace);
        if (!this.current(generation)) return null;
        preferences = normalizeMobileNotificationPreferences(result.preferences);
        providerAvailable = result.providerAvailable;
        state = await this.register(scope.user, workspace, preferences.enabled, providerAvailable, requestPermission, generation);
      } catch { /* A failed registration can still have saved the workspace preferences. */ }
      if (!this.current(generation)) return null;
      if (active) this.publish({ state, ...(preferences ? { preferences, providerAvailable } : {}) });
      return { state, preferences, providerAvailable };
    });
  }
  private async register(user: string, workspace: string, enabled: boolean, providerAvailable: boolean,
    requestPermission: boolean, generation: number): Promise<PushState> {
    if (!enabled) return 'disabled';
    if (!providerAvailable || !this.device.available()) return 'unavailable';
    const existing = await this.device.installation(user, false);
    if (!this.current(generation) || (!existing && !requestPermission)) return 'disabled';
    await this.device.channels();
    if (!this.current(generation)) return 'disabled';
    if (!await this.device.permission(requestPermission)) return 'denied';
    if (!this.current(generation)) return 'disabled';
    const token = await this.device.token();
    if (!this.current(generation)) return 'disabled';
    if (!/^(ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_-]{10,200}\]$/.test(token)) throw new Error('Device registration is not available.');
    const installationId = existing ?? await this.device.installation(user, true);
    if (!installationId || !this.current(generation)) return 'disabled';
    const result = await this.api.registerInstallation({
      schemaVersion: 1, installationId, workspaceId: workspace, provider: 'expo', token, ...this.device.metadata(),
    });
    if (!result.providerAvailable) return 'unavailable';
    return result.enabled ? 'ready' : 'failed';
  }
  save = async (preferences: MobileNotificationPreferences, requestPermission = false) => {
    if (preferences.workspaceId === this.scope?.workspace) await this.saveWorkspaceSettings(preferences, requestPermission);
  };
  enableDevice = () => this.snapshot.preferences ? this.save({ ...this.snapshot.preferences, enabled: true }, true) : Promise.resolve();
  tokenChanged = () => { void this.refresh(); };
  clearLocal = async (user: string | null) => {
    if (user) { this.pending = null; this.seen.clear(); }
    this.setScope(null);
    if (user) await this.device.clearInstallation(user).catch(() => {});
  };
  async logout() {
    const user = this.scope?.user;
    this.scope = null;
    this.generation++;
    this.publish({ state: 'disabled', preferences: null, tapIssue: null });
    if (!user) return;
    try {
      await this.operation;
      const id = await this.device.installation(user, false);
      if (id && this.online()) await this.api.removeInstallation(id);
    } catch { /* Last-seen expiry removes registrations after offline sign-out. */ }
    finally {
      await this.device.clearInstallation(user).catch(() => {});
      this.scope = null; this.pending = null; this.seen.clear();
      this.publish({ state: 'disabled', preferences: null, tapIssue: null });
    }
  }
  receiveTap(value: unknown) {
    if (!isMobileNotificationPayload(value)) { this.publish({ tapIssue: 'This notification is not available.' }); return; }
    if (this.seen.has(value.eventId) || this.opening === value.eventId) return;
    this.pending = value;
    void this.openPending();
  }
  shouldAlert(value: unknown) {
    return isMobileNotificationPayload(value) && this.scope?.workspace === value.destination.workspaceId &&
      this.visible !== notificationPath(value.destination);
  }
  retryTap = () => { void this.openPending(); };
  clearTapIssue = () => this.publish({ tapIssue: null });
  private async openPending() {
    const value = this.pending;
    const scope = this.scope;
    const generation = this.generation;
    if (!value || !scope?.workspace || this.opening || !this.online() || !this.navigationReady) return;
    if (value.destination.workspaceId !== scope.workspace) {
      this.publish({ tapIssue: 'Choose the notification workspace in Settings, then try again.' }); return;
    }
    this.opening = value.eventId;
    try {
      const resolved = await this.api.resolveNotification(value.eventId);
      if (!this.current(generation)) return;
      if (!isMobileNotificationResolution(resolved)) throw { status: 404 };
      const { expiresAt, ...payload } = resolved;
      if (!isMobileNotificationPayload(payload) || payload.eventId !== value.eventId ||
        payload.destination.workspaceId !== scope.workspace || !Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= this.now()) {
        throw { status: 404 };
      }
      await this.fetchDestination(payload.destination);
      if (!this.current(generation)) return;
      this.seen.add(value.eventId);
      if (this.seen.size > 256) this.seen.delete(this.seen.values().next().value!);
      if (this.pending?.eventId === value.eventId) this.pending = null;
      this.publish({ tapIssue: null });
      this.navigate(notificationPath(payload.destination));
    } catch (error) {
      if (!this.current(generation)) return;
      if ([403, 404, 410].includes((error as { status?: number })?.status ?? 0)) {
        if (this.pending?.eventId === value.eventId) this.pending = null;
        this.seen.add(value.eventId);
      }
      this.publish({ tapIssue: 'This notification is no longer available. Refresh your sessions or try again.' });
    } finally {
      this.opening = null;
      if (this.pending && (this.pending.eventId !== value.eventId || this.generation !== generation)) void this.openPending();
    }
  }
  dispose() { this.disposed = true; this.generation++; this.pending = null; this.seen.clear(); this.listeners.clear(); }
}
