import { ClientInactiveError } from '@talyn/client/native';
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
type WorkspaceSettingsLoad = PushSettingsSnapshot & { registration?: Promise<PushState | null> };
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

export const PUSH_TOKEN_TIMEOUT_MS = 15_000;

export class NotificationController {
  private snapshot: PushSnapshot = { state: 'disabled', preferences: null, providerAvailable: false, tapIssue: null };
  private listeners = new Set<() => void>();
  private scope: PushScope | null = null;
  private generation = 0;
  private settingsRevision = 0;
  private pending: MobileNotificationPayload | null = null;
  private seen = new Set<string>();
  private opening: string | null = null;
  private retryRequested = false;
  private disposed = false;
  private operation: Promise<unknown> = Promise.resolve();
  private registration: Promise<unknown> = Promise.resolve();
  private navigate: (path: string) => void = () => {};
  private navigationReady = false;
  private visible = '';
  constructor(private api: PushGateway, private device: PushDevice,
    private canRequest: () => boolean, private fetchDestination: (destination: MobileNotificationDestination) => Promise<void>,
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
    if (this.scope?.workspace) {
      const result = await this.loadWorkspaceSettings(this.scope.workspace);
      await result?.registration;
    }
  };
  loadWorkspaceSettings = (workspace: string) => this.updateWorkspaceSettings(workspace);
  saveWorkspaceSettings = (input: MobileNotificationPreferences, requestPermission = false) =>
    this.updateWorkspaceSettings(input.workspaceId, input, requestPermission);

  private updateWorkspaceSettings(workspace: string, input?: MobileNotificationPreferences, requestPermission = false) {
    const scope = this.scope;
    const generation = this.generation;
    if (!scope || !this.canRequest()) return Promise.resolve(null);
    return this.queue(async (): Promise<WorkspaceSettingsLoad | null> => {
      if (!this.current(generation) || !this.canRequest()) return null;
      const active = scope.workspace === workspace;
      const revision = active ? ++this.settingsRevision : null;
      if (input && active) this.publish({ state: 'loading' });
      let result: MobileNotificationPreferencesResult;
      try {
        const response = input ? await this.api.updatePreferences(input) : await this.api.getPreferences(workspace);
        result = { ...response, preferences: normalizeMobileNotificationPreferences(response.preferences) };
      } catch {
        if (!this.current(generation)) return null;
        if (active) this.publish({ state: 'failed' });
        return { state: 'failed', preferences: null, providerAvailable: false };
      }
      if (!this.current(generation)) return null;
      const { preferences, providerAvailable } = result;
      const state = !preferences.enabled ? 'disabled' : !providerAvailable || !this.device.available() ? 'unavailable' : 'loading';
      const settings = { state, preferences, providerAvailable } satisfies PushSettingsSnapshot;
      if (active) this.publish(settings);
      if (state !== 'loading') return settings;

      // Let preference requests finish while the device obtains its token.
      const registration = this.registration.then(async () => {
        if (!this.current(generation) || !this.canRequest()) return null;
        let status: PushState = 'failed';
        try { status = await this.register(scope.user, workspace, requestPermission, generation); } catch { /* Show registration failure. */ }
        if (!this.current(generation)) return null;
        if (active && revision === this.settingsRevision) this.publish({ state: status });
        return status;
      });
      this.registration = registration;
      return { ...settings, registration };
    });
  }
  private async register(user: string, workspace: string, requestPermission: boolean, generation: number): Promise<PushState> {
    const existing = await this.device.installation(user, false);
    if (!this.current(generation) || (!existing && !requestPermission)) return 'disabled';
    await this.device.channels();
    if (!this.current(generation)) return 'disabled';
    if (!await this.device.permission(requestPermission)) return 'denied';
    if (!this.current(generation)) return 'disabled';
    const token = await this.readPushToken();
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
  private async readPushToken() {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error('Device token request timed out.')), PUSH_TOKEN_TIMEOUT_MS);
    });
    try {
      return await Promise.race([this.device.token(), expired]);
    } finally {
      clearTimeout(timeout);
    }
  }
  save = async (preferences: MobileNotificationPreferences, requestPermission = false) => {
    if (preferences.workspaceId === this.scope?.workspace) {
      const result = await this.saveWorkspaceSettings(preferences, requestPermission);
      await result?.registration;
    }
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
      await this.registration;
      const id = await this.device.installation(user, false);
      if (id && this.canRequest()) await this.api.removeInstallation(id);
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
  retryTap = () => {
    if (this.opening) { this.retryRequested = true; return; }
    void this.openPending();
  };
  clearTapIssue = () => this.publish({ tapIssue: null });
  private async openPending() {
    const value = this.pending;
    const scope = this.scope;
    const generation = this.generation;
    if (!value || !scope?.workspace || this.opening || !this.canRequest() || !this.navigationReady) return;
    if (value.destination.workspaceId !== scope.workspace) {
      this.publish({ tapIssue: 'Choose the notification workspace in Settings, then try again.' }); return;
    }
    this.opening = value.eventId;
    let retryAfterResume = false;
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
      if (error instanceof ClientInactiveError) {
        // The app can resume before the interrupted request rejects.
        retryAfterResume = this.retryRequested;
        return;
      }
      if ([403, 404, 410].includes((error as { status?: number })?.status ?? 0)) {
        if (this.pending?.eventId === value.eventId) this.pending = null;
        this.seen.add(value.eventId);
      }
      this.publish({ tapIssue: 'This notification is no longer available. Refresh your sessions or try again.' });
    } finally {
      this.opening = null;
      this.retryRequested = false;
      if (this.pending && (retryAfterResume || this.pending.eventId !== value.eventId || this.generation !== generation)) void this.openPending();
    }
  }
  dispose() { this.disposed = true; this.generation++; this.pending = null; this.seen.clear(); this.listeners.clear(); }
}
