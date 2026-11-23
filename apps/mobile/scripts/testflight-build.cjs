// Builds the internal-beta binaries from a push to main. EAS submits iOS to TestFlight and Android to the Play internal track.
// Each platform builds only when its native fingerprint has no internal-beta build yet. A change with the same fingerprint
// reaches testers as an EAS update, so a new binary would only use the EAS build quota.
// The guarded wrapper in release.cjs needs a reserved build number and an approval record, which a push cannot supply.
// This path reserves the next build number itself, in the EAS production environment that the build reads.
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { profiles, required } = require('../release/policy.cjs');
const { easOrThrow, publishEnvironment, pullEnvironment, redact, summarize } = require('./publish-update.cjs');

const root = path.resolve(__dirname, '..');
const PROFILE = 'internal-beta';
const PLATFORMS = ['ios', 'android'];
const policy = profiles[PROFILE];
const STORE_PROFILES = Object.keys(profiles).filter((name) => profiles[name].store);
// A build in one of these states already covers its fingerprint.
const LIVE_STATUSES = ['NEW', 'IN_QUEUE', 'IN_PROGRESS', 'FINISHED'];
const SELECTORS = ['APP_ENV', 'MOBILE_RELEASE_PROFILE', 'EAS_BUILD_PROFILE', 'MOBILE_UPDATES_ENABLED', 'MOBILE_BUILD_NUMBER'];

function assertTestflightExecution(env, git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()) {
  if (env.CI !== 'true' || env.GITHUB_REF !== 'refs/heads/main' || !['push', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME ?? '')) {
    throw new Error('Automatic internal-beta builds run only from the Mobile TestFlight workflow on main.');
  }
  if (env.MOBILE_TESTFLIGHT_AUTO === '0') throw new Error('MOBILE_TESTFLIGHT_AUTO is 0. Automatic internal-beta builds are off.');
  for (const name of ['EXPO_TOKEN', 'MOBILE_EAS_CLI_PATH']) required(env, name);
  if (!/^[0-9a-f]{40}$/.test(env.GITHUB_SHA ?? '') || git(['rev-parse', 'HEAD']) !== env.GITHUB_SHA || git(['status', '--porcelain', '--untracked-files=no'])) {
    throw new Error('Build from a clean checkout of the pushed commit.');
  }
  return true;
}

/** EAS evaluates the profile itself. Local selectors must not override what eas.json and the EAS environment set. */
function neutralEnvironment(env) {
  const neutral = { ...env, EXPO_NO_DOTENV: '1' };
  for (const name of SELECTORS) delete neutral[name];
  return neutral;
}

/**
 * The environment for every EAS call. EAS evaluates app.config.ts locally before it reads the EAS environment, and it
 * never sets EAS_BUILD_PROFILE locally. Without the pulled identifiers the production config fails, and without the
 * profile the config resolves the production channel, so the fingerprint would not match the internal-beta binary.
 */
function easEnvironment(base, pulled) {
  return publishEnvironment(neutralEnvironment(base), pulled, PROFILE);
}

/** The platforms this run checks. A push checks both; a manual run can select one. */
function selectedPlatforms(value) {
  if (!value || value === 'all') return PLATFORMS;
  if (!PLATFORMS.includes(value)) throw new Error(`Use all, ${PLATFORMS.join(', or ')} for MOBILE_TESTFLIGHT_PLATFORMS.`);
  return [value];
}

function fingerprintArgs(platform) {
  return ['fingerprint:generate', '--build-profile', PROFILE, '--platform', platform, '--json', '--non-interactive'];
}

function existingBuildArgs(platform, runtime) {
  return ['build:list', '--platform', platform, '--build-profile', PROFILE, '--runtime-version', runtime, '--limit', '10', '--json', '--non-interactive'];
}

function recentBuildArgs() {
  return ['build:list', '--platform', 'all', '--limit', '50', '--json', '--non-interactive'];
}

function buildArgs(platform, message) {
  return ['build', '--profile', PROFILE, '--platform', platform, '--auto-submit-with-profile', PROFILE,
    '--message', message, '--no-wait', '--non-interactive', '--json'];
}

/** The build that already covers this fingerprint, or null when a new binary is needed. */
function coveringBuild(builds) {
  return builds.find((build) => LIVE_STATUSES.includes(build.status)) ?? null;
}

/**
 * The next store build number. Both stores and both store profiles share MOBILE_BUILD_NUMBER, so it must exceed
 * the current reservation and every recent store build, including failed ones.
 */
function nextBuildNumber(current, builds) {
  const used = [current, ...builds.filter((build) => STORE_PROFILES.includes(build.buildProfile)).map((build) => build.appBuildVersion)]
    .map((value) => (/^\d+$/.test(String(value ?? '')) ? Number(value) : 0));
  const next = Math.max(0, ...used) + 1;
  if (next > 999999999) throw new Error('The next build number exceeds the store limit.');
  return String(next);
}

/** The queued build must be the binary this run reserved its number for. */
function assertQueuedBuild(builds, { platform, sha, buildNumber }) {
  if (!Array.isArray(builds) || builds.length !== 1) throw new Error('Expected EAS to queue exactly one build.');
  const [build] = builds;
  if (build.platform?.toLowerCase() !== platform || build.buildProfile !== PROFILE || build.gitCommitHash !== sha ||
    String(build.appBuildVersion) !== buildNumber || (build.updateChannel?.name && build.updateChannel.name !== policy.channel)) {
    throw new Error(`EAS queued build ${build.id ?? 'unknown'} that does not match this ${PROFILE} ${platform} candidate.`);
  }
  return build;
}

function json(env, args, what) {
  const text = easOrThrow(env, args, what);
  try { return JSON.parse(text); } catch { throw new Error(`${what} returned no JSON.`); }
}

const STORE = { ios: 'App Store Connect (TestFlight)', android: 'the Play internal track' };

function run() {
  const mode = process.argv[2];
  if (mode && !['--execute', '--dry-run'].includes(mode)) throw new Error('Use --dry-run or --execute.');
  const force = process.env.MOBILE_TESTFLIGHT_FORCE === 'true';
  const platforms = selectedPlatforms(process.env.MOBILE_TESTFLIGHT_PLATFORMS);
  console.log(JSON.stringify({ action: 'build-and-submit', profile: PROFILE, platforms, force, execute: mode === '--execute' }));
  if (mode !== '--execute') return;
  assertTestflightExecution(process.env);
  const pulled = pullEnvironment(neutralEnvironment(process.env), policy.environment);
  const env = easEnvironment(process.env, pulled);

  const lines = [];
  const needed = [];
  for (const platform of platforms) {
    const { hash } = json(env, fingerprintArgs(platform), `Generating the ${PROFILE} ${platform} fingerprint`);
    if (!/^[a-f0-9]{40,64}$/.test(hash ?? '')) throw new Error(`EAS returned no ${platform} fingerprint hash.`);
    const covering = coveringBuild(json(env, existingBuildArgs(platform, hash), `Listing ${PROFILE} ${platform} builds`));
    if (covering && !force) {
      lines.push(`${PROFILE} ${platform}: build ${covering.id} (${covering.status}, build number ${covering.appBuildVersion}) already runs fingerprint ${hash}. No new binary; the EAS update reaches it.`);
    } else {
      needed.push({ platform, hash, forced: Boolean(covering) });
    }
  }
  if (!needed.length) {
    summarize(env, lines);
    return;
  }

  // One reservation per run. Both stores accept the same number, and the next run reserves a higher one.
  const buildNumber = nextBuildNumber(pulled.MOBILE_BUILD_NUMBER, json(env, recentBuildArgs(), 'Listing recent builds'));
  easOrThrow(env, ['env:set', '--name', 'MOBILE_BUILD_NUMBER', '--value', buildNumber, '--environment', policy.environment,
    '--visibility', 'plaintext', '--type', 'string', '--non-interactive'], `Reserving build number ${buildNumber}`);

  const message = required(process.env, 'MOBILE_BUILD_MESSAGE').slice(0, 1000);
  const failures = [];
  // A failure on one platform must not stop the other platform's build.
  for (const { platform, hash, forced } of needed) {
    try {
      const builds = json({ ...env, MOBILE_BUILD_NUMBER: buildNumber }, buildArgs(platform, message), `Queueing the ${PROFILE} ${platform} build`);
      const build = assertQueuedBuild(builds, { platform, sha: process.env.GITHUB_SHA, buildNumber });
      const page = build.app?.ownerAccount?.name && build.app?.slug ? ` https://expo.dev/accounts/${build.app.ownerAccount.name}/projects/${build.app.slug}/builds/${build.id}` : '';
      lines.push(`${PROFILE} ${platform}: queued build ${build.id} with build number ${buildNumber} for fingerprint ${hash}${forced ? ' (forced)' : ''}.${page}`,
        `EAS submits the ${platform} build to ${STORE[platform]} when it finishes. Follow both in the EAS dashboard.`);
    } catch (error) {
      const text = redact(error instanceof Error ? error.message : String(error));
      lines.push(`${PROFILE} ${platform}: failed. ${text.split('\n')[0]}`);
      failures.push(`${platform}: ${text}`);
    }
  }
  summarize(env, lines);
  if (failures.length) throw new Error(failures.join('\n'));
}

if (require.main === module) {
  Promise.resolve().then(run).catch((error) => {
    // The first line is also an annotation, so the reason shows on the check without the log.
    const [first, ...rest] = redact(error instanceof Error ? error.message : String(error)).split('\n');
    console.log(`::error::Internal-beta build blocked: ${first}`);
    if (rest.length) console.error(rest.join('\n'));
    process.exitCode = 1;
  });
}
module.exports = { PLATFORMS, selectedPlatforms, assertTestflightExecution, neutralEnvironment, easEnvironment, fingerprintArgs, existingBuildArgs, recentBuildArgs, buildArgs, coveringBuild, nextBuildNumber, assertQueuedBuild };
