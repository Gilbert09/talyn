/**
 * The running build's identity, as baked in by webpack at build time
 * (`.erb/configs/appVersion.ts`).
 *
 * One module rather than three copies of `process.env.TALYN_APP_VERSION ||
 * 'dev'`, because the interesting question is never the string — it is "is
 * this a real release?", and three consumers answering it three ways is how
 * a local build ends up counted as production.
 *
 * Read at CALL time, not module scope: the value is a build-time constant in
 * a real bundle, but tests set it per case.
 */

/**
 * A release version is a semver, because that is exactly what CI stamps into
 * `release/app/package.json`. Everything a local build can report — `dev`,
 * `dev+abc1234`, or nothing at all — fails this, which is the point: the test
 * is structural, so a future local-version format cannot silently pass it.
 */
const RELEASE_VERSION = /^\d+\.\d+\.\d+(?:[-+].*)?$/;

/** What this build calls itself. Always a string; `dev` when unbaked. */
export function appVersion(): string {
  return process.env.TALYN_APP_VERSION || 'dev';
}

/** Whether `raw` is a version CI stamped, as opposed to a local build. */
export function isReleaseVersion(raw: string | undefined | null): boolean {
  return typeof raw === 'string' && RELEASE_VERSION.test(raw);
}

/**
 * This build's release version, or null when it is a local build.
 *
 * Null is the honest answer to "which releases do I contain?" from a build
 * that was never released — the What's New check and anything else keyed to
 * the release feed must stand down rather than guess.
 */
export function releaseVersion(): string | null {
  const version = appVersion();
  return isReleaseVersion(version) ? version : null;
}

/** Whether this build came out of CI. See `releaseVersion`. */
export function isReleaseBuild(): boolean {
  return releaseVersion() !== null;
}
