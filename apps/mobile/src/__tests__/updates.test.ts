import { createUpdateController, type UpdatesApi } from '../features/updates/controller';
import {
  FOREGROUND_CHECK_INTERVAL_MS, initialUpdateState, reduceUpdate, shouldCheck, showsReadyBanner, updateStatusLabel,
  type UpdateEvent, type UpdatePhase, type UpdateState, type UpdateTrigger,
} from '../features/updates/model';

const NOW = 1_000_000_000;
const state = (overrides: Partial<UpdateState> = {}): UpdateState => ({ ...initialUpdateState(true), ...overrides });

describe('update throttle', () => {
  it.each<[string, Partial<UpdateState>, UpdateTrigger, number, boolean]>([
    ['launch checks once', {}, 'launch', NOW, true],
    ['launch does not repeat after a check', { lastCheckedAt: NOW - 1, phase: 'current' }, 'launch', NOW, false],
    ['foreground checks the first time', {}, 'foreground', NOW, true],
    ['foreground waits inside the interval', { lastCheckedAt: NOW - FOREGROUND_CHECK_INTERVAL_MS + 1, phase: 'current' }, 'foreground', NOW, false],
    ['foreground checks at the interval', { lastCheckedAt: NOW - FOREGROUND_CHECK_INTERVAL_MS, phase: 'current' }, 'foreground', NOW, true],
    ['foreground waits after a failure too', { lastCheckedAt: NOW - 60_000, phase: 'failed' }, 'foreground', NOW, false],
    ['manual ignores the interval', { lastCheckedAt: NOW - 1, phase: 'current' }, 'manual', NOW, true],
    ['manual checks again with an update ready', { lastCheckedAt: NOW - 1, phase: 'ready', ready: { updateId: 'a' } }, 'manual', NOW, true],
    ['foreground leaves a ready update alone', { lastCheckedAt: 0, phase: 'ready', ready: { updateId: 'a' } }, 'foreground', NOW, false],
    ['no check during a check', { phase: 'checking' }, 'manual', NOW, false],
    ['no check during a download', { phase: 'downloading' }, 'manual', NOW, false],
    ['no check when updates are off', { phase: 'off' }, 'manual', NOW, false],
  ])('%s', (_name, overrides, trigger, now, expected) => {
    expect(shouldCheck(state(overrides), trigger, now)).toBe(expected);
  });
});

describe('update state transitions', () => {
  it.each<[string, Partial<UpdateState>, UpdateEvent, Partial<UpdateState>]>([
    ['a check records its start', {}, { type: 'check', at: NOW }, { phase: 'checking', lastCheckedAt: NOW, error: null }],
    ['a check clears an old error', { phase: 'failed', error: 'offline' }, { type: 'check', at: NOW }, { phase: 'checking', error: null }],
    ['nothing new is current', { phase: 'checking' }, { type: 'current' }, { phase: 'current' }],
    ['nothing newer keeps a ready update', { phase: 'checking', ready: { updateId: 'a' } }, { type: 'current' }, { phase: 'ready', ready: { updateId: 'a' } }],
    ['a found update downloads', { phase: 'checking' }, { type: 'download' }, { phase: 'downloading' }],
    ['a download is ready', { phase: 'downloading' }, { type: 'downloaded', updateId: 'b' }, { phase: 'ready', ready: { updateId: 'b' } }],
    ['a rollback is ready', { phase: 'downloading' }, { type: 'downloaded', updateId: null }, { phase: 'ready', ready: { updateId: null } }],
    ['a new download shows the banner again', { phase: 'downloading', dismissed: true, ready: { updateId: 'a' } }, { type: 'downloaded', updateId: 'b' }, { dismissed: false }],
    ['a failure is recorded', { phase: 'checking' }, { type: 'failed', message: 'offline' }, { phase: 'failed', error: 'offline' }],
    ['a failure keeps a ready update', { phase: 'checking', ready: { updateId: 'a' } }, { type: 'failed', message: 'offline' }, { phase: 'ready', error: 'offline' }],
    ['dismissing hides the banner', { phase: 'ready', ready: { updateId: 'a' } }, { type: 'dismiss' }, { phase: 'ready', dismissed: true }],
  ])('%s', (_name, from, event, expected) => {
    expect(reduceUpdate(state(from), event)).toMatchObject(expected);
  });

  it.each<UpdateEvent>([{ type: 'check', at: NOW }, { type: 'download' }, { type: 'downloaded', updateId: 'a' }, { type: 'failed', message: 'x' }])(
    'ignores %j when updates are off', (event) => {
      const off = initialUpdateState(false);
      expect(reduceUpdate(off, event)).toBe(off);
    });

  it.each<[UpdatePhase, Partial<UpdateState>, boolean]>([
    ['ready', { ready: { updateId: 'a' } }, true],
    ['ready', { ready: { updateId: 'a' }, dismissed: true }, false],
    ['current', {}, false],
    ['downloading', {}, false],
  ])('shows the banner in %s: %j', (phase, overrides, shown) => {
    expect(showsReadyBanner(state({ phase, ...overrides }))).toBe(shown);
  });

  it.each<[Partial<UpdateState>, string]>([
    [{ phase: 'off' }, 'This build does not receive updates'],
    [{ phase: 'idle' }, 'Updates install when Talyn restarts'],
    [{ phase: 'checking' }, 'Checking for updates'],
    [{ phase: 'downloading' }, 'Downloading the update'],
    [{ phase: 'ready', ready: { updateId: 'a' } }, 'Update ready. Restart to apply it'],
    [{ phase: 'ready', ready: { updateId: null } }, 'Restart to return to the built-in version'],
    [{ phase: 'current' }, 'Talyn is up to date'],
    [{ phase: 'failed', error: 'Network error.' }, 'Could not check for updates. Network error.'],
  ])('labels %j', (overrides, label) => {
    expect(updateStatusLabel(state(overrides))).toBe(label);
  });
});

function fakeApi(overrides: Partial<UpdatesApi> = {}): jest.Mocked<UpdatesApi> {
  return {
    checkForUpdateAsync: jest.fn(async () => ({ isAvailable: true, isRollBackToEmbedded: false })),
    fetchUpdateAsync: jest.fn(async () => ({ isNew: true, isRollBackToEmbedded: false, manifest: { id: 'update-1' } })),
    reloadAsync: jest.fn(async () => {}),
    ...overrides,
  } as jest.Mocked<UpdatesApi>;
}

describe('update controller', () => {
  it('checks, downloads, and waits for a restart', async () => {
    const api = fakeApi();
    const controller = createUpdateController(api, { enabled: true, now: () => NOW });
    const phases: UpdatePhase[] = [];
    controller.subscribe(() => phases.push(controller.getState().phase));
    await controller.check('launch');
    expect(phases).toEqual(['checking', 'downloading', 'ready']);
    expect(controller.getState().ready).toEqual({ updateId: 'update-1' });
    expect(api.reloadAsync).not.toHaveBeenCalled();
  });

  it.each<[string, Partial<UpdatesApi>, Partial<UpdateState>]>([
    ['no update', { checkForUpdateAsync: jest.fn(async () => ({ isAvailable: false, isRollBackToEmbedded: false })) }, { phase: 'current', ready: null }],
    ['a rollback directive', {
      checkForUpdateAsync: jest.fn(async () => ({ isAvailable: false, isRollBackToEmbedded: true })),
      fetchUpdateAsync: jest.fn(async () => ({ isNew: false, isRollBackToEmbedded: true })),
    }, { phase: 'ready', ready: { updateId: null } }],
    ['an update already on the device', { fetchUpdateAsync: jest.fn(async () => ({ isNew: false, isRollBackToEmbedded: false })) }, { phase: 'current' }],
    ['a check error', { checkForUpdateAsync: jest.fn(async () => { throw new Error('Network request failed'); }) }, { phase: 'failed', error: 'Network request failed' }],
    ['a download error', { fetchUpdateAsync: jest.fn(async () => { throw new Error('Signature mismatch'); }) }, { phase: 'failed', error: 'Signature mismatch' }],
    ['a manifest without an ID', { fetchUpdateAsync: jest.fn(async () => ({ isNew: true, isRollBackToEmbedded: false, manifest: {} })) }, { phase: 'ready', ready: { updateId: null } }],
  ])('settles %s', async (_name, overrides, expected) => {
    const controller = createUpdateController(fakeApi(overrides), { enabled: true, now: () => NOW });
    await controller.check('manual');
    expect(controller.getState()).toMatchObject(expected);
  });

  it('throttles foreground checks to the interval', async () => {
    let now = NOW;
    const api = fakeApi({ checkForUpdateAsync: jest.fn(async () => ({ isAvailable: false, isRollBackToEmbedded: false })) });
    const controller = createUpdateController(api, { enabled: true, now: () => now });
    await controller.check('launch');
    await controller.check('launch');
    now += FOREGROUND_CHECK_INTERVAL_MS - 1;
    await controller.check('foreground');
    expect(api.checkForUpdateAsync).toHaveBeenCalledTimes(1);
    now += 1;
    await controller.check('foreground');
    expect(api.checkForUpdateAsync).toHaveBeenCalledTimes(2);
  });

  it('runs one check at a time', async () => {
    let finish: (value: { isAvailable: boolean; isRollBackToEmbedded: boolean }) => void = () => {};
    const api = fakeApi({ checkForUpdateAsync: jest.fn(() => new Promise((resolve) => { finish = resolve; })) });
    const controller = createUpdateController(api, { enabled: true, now: () => NOW });
    const first = controller.check('manual');
    await controller.check('manual');
    finish({ isAvailable: false, isRollBackToEmbedded: false });
    await first;
    expect(api.checkForUpdateAsync).toHaveBeenCalledTimes(1);
  });

  it('never calls the native module when updates are off', async () => {
    const api = fakeApi();
    const controller = createUpdateController(api, { enabled: false });
    await controller.check('manual');
    expect(api.checkForUpdateAsync).not.toHaveBeenCalled();
    expect(controller.getState().phase).toBe('off');
  });

  it('records a failed restart for About', async () => {
    const controller = createUpdateController(fakeApi({ reloadAsync: jest.fn(async () => { throw new Error('Reload failed'); }) }), { enabled: true, now: () => NOW });
    await controller.check('launch');
    await controller.restart();
    expect(controller.getState()).toMatchObject({ phase: 'ready', error: 'Reload failed' });
  });
});
