// PostHog error tracking symbol uploads outside the native build, through PostHog's own CLI only:
// - EAS updates: `posthog-cli hermes upload` on the Hermes source maps that `eas update` leaves in dist/.
// - EAS builds: install the pinned CLI that the Gradle and Xcode upload steps of plugins/withPostHogSymbolUploads.cjs call.
// Every path needs POSTHOG_CLI_API_KEY. With no key it is skipped with a notice, and the build or publish goes on.
// The app config does not load this file, so changing it needs no new binary.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { posthogUploadCredentials } = require('../release/policy.cjs');
const { posthogCli } = require('../release/toolchain.json');
const { symbolUploadCredentials } = require('../plugins/withPostHogSymbolUploads.cjs');

const PLATFORMS = ['ios', 'android'];

/**
 * One `hermes upload` per platform the export holds, read from the `metadata.json` that `expo export` writes.
 * Each platform gets its own app identifier, because event release mode matches an exception to its release
 * by the `$app_namespace` and `$app_version` the SDK sends.
 */
function hermesUploadPlan(distRoot, metadata, exp) {
  const root = path.resolve(distRoot);
  const appIds = { ios: exp?.ios?.bundleIdentifier, android: exp?.android?.package };
  const plan = [];
  for (const platform of PLATFORMS) {
    const bundle = metadata?.fileMetadata?.[platform]?.bundle;
    if (typeof bundle !== 'string' || !bundle) continue;
    const directory = path.dirname(path.resolve(root, bundle));
    if (!directory.startsWith(`${root}${path.sep}`)) throw new Error(`The ${platform} bundle path leaves the export directory.`);
    const args = ['hermes', 'upload', '--directory', directory, '--release-mode', 'event'];
    if (appIds[platform]) args.push('--release-name', appIds[platform]);
    if (exp?.version) args.push('--release-version', exp.version);
    plan.push({ platform, directory, args });
  }
  return plan;
}

function runCli(cliPath, args, env) {
  return spawnSync(process.execPath, [cliPath, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10 * 60 * 1000 });
}

/**
 * Upload the source maps of the update just published. It never throws, because the update is already live:
 * a failed upload costs readable stack traces for this update, not the update. Returns `{ level, message }` lines.
 */
function uploadUpdateSourceMaps({ env, root, exp, channel, run = runCli }) {
  const warn = (message) => [{ level: 'warning', message: `${channel}: ${message} No source maps were uploaded.` }];
  let credentials;
  try { credentials = posthogUploadCredentials(env); } catch (error) { return warn(error.message); }
  if (!credentials) {
    return [{ level: 'notice', message: `${channel}: POSTHOG_CLI_API_KEY is not set, so no source maps were uploaded. PostHog shows minified stack traces for this update.` }];
  }
  if (!env.POSTHOG_CLI_PATH) return warn('POSTHOG_CLI_PATH is not set.');
  const distRoot = path.join(root, 'dist');
  let plan;
  try {
    plan = hermesUploadPlan(distRoot, JSON.parse(fs.readFileSync(path.join(distRoot, 'metadata.json'), 'utf8')), exp);
  } catch (error) {
    return warn(`Could not read the exported bundles (${error.message}).`);
  }
  if (!plan.length) return warn('The export has no iOS or Android bundle.');
  // The Expo token goes only to EAS.
  const { EXPO_TOKEN: _expoToken, ...rest } = env;
  const cliEnv = { ...rest, ...credentials, POSTHOG_RELEASE_MODE: 'event' };
  return plan.map(({ platform, args }) => {
    const result = run(env.POSTHOG_CLI_PATH, args, cliEnv);
    if (result.status === 0) return { level: 'notice', message: `${channel} ${platform}: uploaded the Hermes source maps to PostHog.` };
    const tail = `${result.stderr ?? ''}\n${result.stdout ?? ''}`.trim().split('\n').slice(-10).join('\n');
    return { level: 'warning', message: `${channel} ${platform}: the PostHog source map upload failed${result.error ? ` (${result.error.message})` : ''}.${tail ? `\n${tail}` : ''}` };
  });
}

/** What the EAS build hook does: install the pinned CLI the Gradle and Xcode upload steps call, or skip. */
function easInstallPlan(env) {
  if (env.EAS_BUILD !== 'true') return { install: false, reason: 'This is not an EAS build.' };
  const profile = env.EAS_BUILD_PROFILE;
  if (!profile || profile === 'development') return { install: false, reason: 'The development client uploads no symbols.' };
  if (!symbolUploadCredentials(env, profile)) {
    return { install: false, reason: 'POSTHOG_CLI_API_KEY is not set in the EAS environment, so this build uploads no source maps or native symbols.' };
  }
  // The npm package downloads its binary in postinstall, so scripts must run. Gradle and Xcode find a global install.
  return { install: true, args: ['install', '--global', '--no-audit', '--no-fund', `@posthog/cli@${posthogCli}`] };
}

function runEasInstall(env = process.env, spawn = spawnSync) {
  let plan;
  try { plan = easInstallPlan(env); } catch (error) {
    console.error(`PostHog symbol upload blocked: ${error.message}`);
    return 1;
  }
  if (!plan.install) {
    console.log(`PostHog symbol upload skipped: ${plan.reason}`);
    return 0;
  }
  // The install scripts never need the key.
  const { POSTHOG_CLI_API_KEY: _key, ...installEnv } = env;
  const result = spawn('npm', plan.args, { stdio: 'inherit', env: installEnv });
  if (result.status !== 0) console.error('Installing the PostHog CLI failed. The Gradle or Xcode upload step needs it.');
  return result.status ?? 1;
}

if (require.main === module) {
  if (process.argv[2] !== 'eas-install') {
    console.error('Use: node scripts/posthog-symbols.cjs eas-install');
    process.exitCode = 1;
  } else {
    process.exitCode = runEasInstall();
  }
}

module.exports = { hermesUploadPlan, uploadUpdateSourceMaps, easInstallPlan, runEasInstall };
