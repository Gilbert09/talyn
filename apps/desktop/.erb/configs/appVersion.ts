import { execFileSync } from 'child_process';
import path from 'path';

/**
 * The version string baked into the renderer bundle as `TALYN_APP_VERSION`.
 *
 * It feeds two things: the `app_version` analytics super property, and the
 * `X-Talyn-Client-Version` header every API request carries.
 *
 * `release/app/package.json` is committed with a static placeholder and only
 * CI stamps the real version into it before building (see publish.yml). So a
 * build made anywhere else — a contributor running `npm start`, a local
 * `npm run package` — bakes the placeholder and then reports itself as a
 * release that shipped long ago.
 *
 * That was not cosmetic. The backend's free-plan paywall used to exempt any
 * client identifying as a version below the release that shipped the upgrade
 * UI, on the reasoning that an old build can only render a bare error. The
 * placeholder is below every floor, so every local build was silently exempt
 * from both the task and merge-queue caps. That exemption is gone, but the
 * lesson stands: a local build must never be mistakable for a release.
 *
 * So an unstamped build reports `dev+<sha>` — or a bare `dev` when the commit
 * cannot be read. Three properties earn that shape:
 *   - It can never parse as a release. Every consumer decides "is this a
 *     release?" with one test (`renderer/lib/appVersion.ts`), and `dev`
 *     anything fails it.
 *   - It still IDENTIFIES the build. `dev` alone made every contributor's app
 *     one indistinguishable bucket, which is worthless the moment you are
 *     reading their events — and since these builds now carry the analytics
 *     key (see the webpack configs), we are reading them.
 *   - `+<sha>` is semver build metadata, so it stays greppable and sorts
 *     next to nothing by accident.
 */

/**
 * The committed stub in `release/app/package.json`. Anything equal to this was
 * NOT stamped by CI and is therefore a local build.
 */
export const PLACEHOLDER_VERSION = '0.1.0';

/** What an unstamped build reports when the commit cannot be resolved. */
export const LOCAL_VERSION = 'dev';

/**
 * The commit this bundle was built from, `abc1234` or `abc1234-dirty`.
 *
 * Returns null rather than throwing on every way this can fail: no git on
 * PATH, a source tarball with no `.git`, a detached/empty repo. Analytics is
 * never worth failing a build over.
 *
 * The `-dirty` half matters more than it looks: a contributor builds from a
 * working tree, so a bare sha would claim a commit whose code is not what is
 * running. Better to say so than to report a precise lie.
 */
export function gitBuildId(): string | null {
  const run = (args: string[]): string =>
    execFileSync('git', args, {
      cwd: path.resolve(__dirname, '../..'),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();

  try {
    const sha = run(['rev-parse', '--short=7', 'HEAD']);
    if (!sha) return null;
    // `--porcelain` prints one line per changed path and nothing when clean.
    const dirty = run(['status', '--porcelain']) !== '';
    return dirty ? `${sha}-dirty` : sha;
  } catch {
    return null;
  }
}

/**
 * The pure decision, split out so it can be tested without shelling out to
 * git or loading the build file: a CI-stamped version passes through, and
 * anything else becomes `dev` with the build id appended when there is one.
 */
export function appVersionFrom(
  raw: string | undefined | null,
  buildId?: string | null,
): string {
  if (raw && raw !== PLACEHOLDER_VERSION) return raw;
  return buildId ? `${LOCAL_VERSION}+${buildId}` : LOCAL_VERSION;
}

export function resolveAppVersion(): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires, global-require
  const raw = require('../../release/app/package.json').version;
  // Only pay for the git calls on a build that needs an identity.
  return appVersionFrom(raw, raw && raw !== PLACEHOLDER_VERSION ? null : gitBuildId());
}

export default resolveAppVersion;
