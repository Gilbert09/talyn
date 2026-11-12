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
export interface PushScope { user: string; workspace: string }
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
  private queue(work: () => Promise<void>) {
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
  refresh = () => {
    const scope = this.scope;
    const generation = this.generation;
    if (!scope || !this.online()) return Promise.resolve();
    return this.queue(async () => {
      if (!this.current(generation)) return;
      try {
        const result = await this.api.getPreferences(scope.workspace);
        if (!this.current(generation)) return;
        // A backend from before onlyWhenAway sends no value; it reads as on.
        this.publish({ preferences: normalizeMobileNotificationPreferences(result.preferences), providerAvailable: result.providerAvailable });
        await this.register(false, generation);
      } catch { if (this.current(generation)) this.publish({ state: 'failed' }); }
    });
  };
  private async register(requestPermission: boolean, generation: number) {
    const scope = this.scope;
    if (!scope || !this.current(generation)) return;
    if (!this.snapshot.preferences?.enabled) { this.publish({ state: 'disabled' }); return; }
    if (!this.snapshot.providerAvailable || !this.device.available()) { this.publish({ state: 'unavailable' }); return; }
    const existing = await this.device.installation(scope.user, false);
    if (!this.current(generation)) return;
    if (!existing && !requestPermission) { this.publish({ state: 'disabled' }); return; }
    await this.device.channels();
    if (!this.current(generation)) return;
    if (!await this.device.permission(requestPermission)) { if (this.current(generation)) this.publish({ state: 'denied' }); return; }
    const token = await this.device.token();
    if (!this.current(generation)) return;
    if (!/^(ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_-]{10,200}\]$/.test(token)) throw new Error('Device registration is not available.');
    const installationId = existing ?? await this.device.installation(scope.user, true);
    if (!installationId || !this.current(generation)) return;
    const result = await this.api.registerInstallation({
      schemaVersion: 1, installationId, workspaceId: scope.workspace, provider: 'expo', token, ...this.device.metadata(),
    });
    if (!this.current(generation)) return;
    this.publish({ state: result.providerAvailable ? result.enabled ? 'ready' : 'failed' : 'unavailable' });
  }
  save = (preferences: MobileNotificationPreferences, requestPermission = false) => {
    const generation = this.generation;
    if (!this.scope || preferences.workspaceId !== this.scope.workspace || !this.online()) return Promise.resolve();
    return this.queue(async () => {
      if (!this.current(generation)) return;
      this.publish({ state: 'loading' });
      try {
        const result = await this.api.updatePreferences(preferences);
        if (!this.current(generation)) return;
        // A backend from before onlyWhenAway sends no value; it reads as on.
        this.publish({ preferences: normalizeMobileNotificationPreferences(result.preferences), providerAvailable: result.providerAvailable });
        await this.register(requestPermission, generation);
      } catch { if (this.current(generation)) this.publish({ state: 'failed' }); }
    });
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
    if (!value || !scope || this.opening || !this.online() || !this.navigationReady) return;
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
