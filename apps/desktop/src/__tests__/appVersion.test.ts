import {
  appVersionFrom,
  gitBuildId,
  LOCAL_VERSION,
  PLACEHOLDER_VERSION,
  resolveAppVersion,
} from '../../.erb/configs/appVersion';
import {
  DEFAULT_POSTHOG_KEY,
  resolvePostHogKey,
} from '../../.erb/configs/posthogKey';
import {
  appVersion,
  isReleaseVersion,
  releaseVersion,
  isReleaseBuild,
} from '../renderer/lib/appVersion';

/**
 * The version baked into the renderer bundle. It feeds the `app_version`
 * analytics super property, the `environment` super property, and the
 * `X-Talyn-Client-Version` header. `release/app/package.json` carries a
 * committed placeholder that only CI replaces — so an unstamped build used to
 * report itself as an ancient release. Anything not stamped must read `dev`,
 * and must still say WHICH local build it is.
 */
describe('appVersionFrom', () => {
  it('passes a CI-stamped version through untouched', () => {
    expect(appVersionFrom('0.2.60')).toBe('0.2.60');
    expect(appVersionFrom('1.0.0-rc.1')).toBe('1.0.0-rc.1');
  });

  it('ignores a build id when the version was stamped', () => {
    // A release names itself by its release number, never by a commit.
    expect(appVersionFrom('0.2.60', 'abc1234')).toBe('0.2.60');
  });

  it('reports the committed placeholder as dev', () => {
    expect(appVersionFrom(PLACEHOLDER_VERSION)).toBe('dev');
  });

  it.each([undefined, null, ''])('reports %p as dev', (raw) => {
    expect(appVersionFrom(raw)).toBe('dev');
  });

  it.each([
    ['abc1234', 'dev+abc1234'],
    ['abc1234-dirty', 'dev+abc1234-dirty'],
  ])('names an unstamped build by its commit: %p', (buildId, expected) => {
    expect(appVersionFrom(PLACEHOLDER_VERSION, buildId)).toBe(expected);
    expect(appVersionFrom(undefined, buildId)).toBe(expected);
  });

  it.each([null, undefined, ''])(
    'falls back to a bare dev when the commit cannot be read (%p)',
    (buildId) => {
      // No git, a source tarball, an empty repo. Never a build failure.
      expect(appVersionFrom(PLACEHOLDER_VERSION, buildId)).toBe(LOCAL_VERSION);
    },
  );

  it('resolves this working tree to a local version — release/app is never stamped in git', () => {
    // Guards the wiring, not just the predicate: if the placeholder in
    // release/app/package.json is ever changed without updating
    // PLACEHOLDER_VERSION, local builds start reporting a fake release again.
    expect(resolveAppVersion()).toMatch(/^dev(\+[0-9a-f]{7}(-dirty)?)?$/);
    expect(isReleaseVersion(resolveAppVersion())).toBe(false);
  });
});

describe('gitBuildId', () => {
  it('reads this checkout as a short sha, with a dirty marker when it applies', () => {
    // Runs in the repo, so it must resolve; the suite must not care whether
    // the tree happens to be clean.
    expect(gitBuildId()).toMatch(/^[0-9a-f]{7}(-dirty)?$/);
  });
});

/**
 * The renderer's half: every consumer asks "is this a release?" through one
 * predicate, so the What's New check and the analytics `environment` property
 * cannot disagree about what a contributor's build is.
 */
describe('isReleaseVersion', () => {
  it.each(['0.2.60', '1.0.0', '0.2.60-rc.1', '10.20.30'])(
    'accepts the semver CI stamps: %p',
    (raw) => {
      expect(isReleaseVersion(raw)).toBe(true);
    },
  );

  it.each([
    'dev',
    'dev+abc1234',
    'dev+abc1234-dirty',
    'web/8da8028',
    '',
    'v0.2.60',
    '0.2',
    undefined,
    null,
  ])('rejects everything a non-release can report: %p', (raw) => {
    expect(isReleaseVersion(raw)).toBe(false);
  });
});

describe('appVersion / releaseVersion / isReleaseBuild', () => {
  const original = process.env.TALYN_APP_VERSION;

  afterEach(() => {
    if (original === undefined) delete process.env.TALYN_APP_VERSION;
    else process.env.TALYN_APP_VERSION = original;
  });

  it('reports a stamped release as itself, and as a release', () => {
    process.env.TALYN_APP_VERSION = '0.2.70';
    expect(appVersion()).toBe('0.2.70');
    expect(releaseVersion()).toBe('0.2.70');
    expect(isReleaseBuild()).toBe(true);
  });

  it('reports a local build as itself, but NOT as a release', () => {
    // The whole point: the build is identifiable (so its events can be told
    // apart) without being mistakable for a release (so it is never counted
    // as one, and never asks the release feed what it contains).
    process.env.TALYN_APP_VERSION = 'dev+abc1234';
    expect(appVersion()).toBe('dev+abc1234');
    expect(releaseVersion()).toBeNull();
    expect(isReleaseBuild()).toBe(false);
  });

  it('falls back to dev when nothing was baked', () => {
    delete process.env.TALYN_APP_VERSION;
    expect(appVersion()).toBe('dev');
    expect(releaseVersion()).toBeNull();
    expect(isReleaseBuild()).toBe(false);
  });
});

/**
 * Which key a build bakes. The whole point of committing a default is that a
 * build made outside CI still reports — so the ways a build can end up with
 * NO key must be deliberate ones, and "someone left a blank line in .env" is
 * not deliberate.
 */
describe('resolvePostHogKey', () => {
  it('uses the committed project key when nothing is set', () => {
    expect(resolvePostHogKey({})).toBe(DEFAULT_POSTHOG_KEY);
  });

  it.each(['', '   '])(
    'falls through to the default on a blank key (%p)',
    (TALYN_POSTHOG_KEY) => {
      // The regression that made this rewrite necessary: apps/desktop/.env is
      // loaded before the plugins are built, and a bare `TALYN_POSTHOG_KEY=`
      // line is DEFINED — so an EnvironmentPlugin default never applied and
      // the build went silent with nothing said.
      expect(resolvePostHogKey({ TALYN_POSTHOG_KEY })).toBe(DEFAULT_POSTHOG_KEY);
    },
  );

  it('prefers an explicitly set key, so CI can point a build elsewhere', () => {
    expect(resolvePostHogKey({ TALYN_POSTHOG_KEY: 'phc_other' })).toBe('phc_other');
    // Trimmed: a trailing newline out of a CI variable is not part of the key.
    expect(resolvePostHogKey({ TALYN_POSTHOG_KEY: ' phc_other\n' })).toBe('phc_other');
  });

  it.each(['1', 'true', 'TRUE', ' true '])(
    'returns no key when analytics is explicitly disabled (%p)',
    (TALYN_ANALYTICS_DISABLED) => {
      expect(resolvePostHogKey({ TALYN_ANALYTICS_DISABLED })).toBe('');
    },
  );

  it('lets the disable flag beat an explicitly set key', () => {
    expect(
      resolvePostHogKey({
        TALYN_POSTHOG_KEY: 'phc_other',
        TALYN_ANALYTICS_DISABLED: '1',
      }),
    ).toBe('');
  });

  it.each(['0', 'false', '', 'no', undefined])(
    'treats %p as NOT disabled — only 1/true opt out',
    (TALYN_ANALYTICS_DISABLED) => {
      expect(resolvePostHogKey({ TALYN_ANALYTICS_DISABLED })).toBe(DEFAULT_POSTHOG_KEY);
    },
  );
});
