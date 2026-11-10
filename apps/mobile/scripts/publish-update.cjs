// Publishes an unsigned EAS update to one automatic channel (preview or internal-beta) from a push to main.
// The guarded wrapper in release.cjs needs the installed runtime and an approval record, which a push cannot supply.
// This path instead lets the fingerprint policy pick the runtime: an update reaches only binaries whose native
// fingerprint matches, so a native change publishes to a runtime no installed app runs and needs a new build.
// Updates are unsigned by decision (2026-11-09): EAS code signing needs a paid EAS plan.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { profiles, required, CHECK_AUTOMATICALLY, POSTHOG_SYMBOL_UPLOADS } = require('../release/policy.cjs');
const { assertChannel } = require('./release.cjs');
const { uploadUpdateSourceMaps } = require('./posthog-symbols.cjs');

const root = path.resolve(__dirname, '..');
const autoProfiles = Object.keys(profiles).filter((name) => profiles[name].autoUpdate);
// The names the app configuration reads. Nothing else pulled from EAS enters the local publish environment.
const PULLED = /^(?:EXPO_PUBLIC_[A-Z0-9_]+|TALYN_MOBILE_[A-Z0-9_]+|MOBILE_UPDATES_ENABLED)$/;
// Selectors this script sets itself. They are removed while EAS evaluates the project for `env:pull`.
const SELECTORS = ['APP_ENV', 'MOBILE_RELEASE_PROFILE', 'EAS_BUILD_PROFILE', 'MOBILE_UPDATES_ENABLED'];

function autoUpdatePlan(profile, env) {
  const policy = profiles[profile];
  if (!policy?.autoUpdate) throw new Error(`Automatic updates publish only to ${autoProfiles.join(' and ')}.`);
  const message = required(env, 'MOBILE_UPDATE_MESSAGE');
  return {
    profile, policy,
    args: ['update', '--channel', policy.channel, '--environment', policy.environment, '--platform', 'all',
      '--message', message, '--non-interactive', '--json'],
  };
}

function assertAutoExecution(env, git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()) {
  if (env.CI !== 'true' || env.GITHUB_REF !== 'refs/heads/main' || !['push', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME ?? '')) {
    throw new Error('Automatic updates run only from the Mobile update workflow on main.');
  }
  if (env.MOBILE_UPDATES_AUTO === '0') throw new Error('MOBILE_UPDATES_AUTO is 0. Automatic updates are off.');
  for (const name of ['EXPO_TOKEN', 'MOBILE_EAS_CLI_PATH']) required(env, name);
  if (!/^[0-9a-f]{40}$/.test(env.GITHUB_SHA ?? '') || git(['rev-parse', 'HEAD']) !== env.GITHUB_SHA || git(['status', '--porcelain', '--untracked-files=no'])) {
    throw new Error('Publish from a clean checkout of the pushed commit.');
  }
  return true;
}

function parseDotenv(text) {
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) continue;
    const value = match[2];
    values[match[1]] = /^(["']).*\1$/.test(value) ? value.slice(1, -1) : value;
  }
  return values;
}

/** The environment `eas update` evaluates the app with. EAS applies the same pulled values on top again. */
function publishEnvironment(base, pulled, profile) {
  const policy = profiles[profile];
  const remote = Object.fromEntries(Object.entries(pulled).filter(([name]) => PULLED.test(name)));
  if (remote.MOBILE_UPDATES_ENABLED !== undefined && remote.MOBILE_UPDATES_ENABLED !== '1') {
    throw new Error(`The EAS ${policy.environment} environment sets MOBILE_UPDATES_ENABLED=${remote.MOBILE_UPDATES_ENABLED}. Remove it; eas.json owns the switch.`);
  }
  const env = { ...base, ...remote };
  delete env.EAS_BUILD_PROFILE;
  // The PostHog key goes only to the PostHog CLI, after the publish.
  delete env[POSTHOG_SYMBOL_UPLOADS.keyName];
  return {
    ...env, APP_ENV: policy.environment, MOBILE_RELEASE_PROFILE: profile, MOBILE_UPDATES_ENABLED: '1', EXPO_NO_DOTENV: '1',
    // Store profiles require a build number. The fingerprint skips version fields, and About reads the native number.
    MOBILE_BUILD_NUMBER: base.MOBILE_BUILD_NUMBER || '1',
  };
}

/** The resolved configuration must be the one the installed binary was built with. */
function assertUpdateConfig(exp, profile) {
  const updates = exp.updates ?? {};
  const projectId = exp.extra?.eas?.projectId;
  if (!updates.enabled || !projectId || updates.url !== `https://u.expo.dev/${projectId}` || updates.checkAutomatically !== CHECK_AUTOMATICALLY ||
    updates.requestHeaders?.['expo-channel-name'] !== profiles[profile].channel) {
    throw new Error(`The ${profile} configuration does not enable updates as its binary does.`);
  }
  // A signing certificate would make EAS try to sign (a paid plan) and the binary reject unsigned updates.
  if (updates.codeSigningCertificate || updates.codeSigningMetadata) throw new Error(`The ${profile} configuration has update code signing. Updates are unsigned.`);
}

// Signed asset URLs and tokens never reach CI logs. Error text keeps its shape so a failure can be read.
function redact(text) {
  return text.replace(/https?:\/\/[^\s"']+\?[^\s"']*/g, '[signed URL removed]').replace(/[A-Za-z0-9_-]{40,}/g, '[long value removed]');
}

function eas(env, args) {
  return spawnSync(process.execPath, [env.MOBILE_EAS_CLI_PATH, ...args], { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
}

function easOrThrow(env, args, what) {
  const result = eas(env, args);
  if (result.status !== 0) {
    const tail = redact(`${result.stderr ?? ''}\n${result.stdout ?? ''}`).trim().split('\n').slice(-30).join('\n');
    throw new Error(`${what} failed.${tail ? `\n${tail}` : ''}`);
  }
  return result.stdout;
}

function pullEnvironment(env, environment) {
  const dir = fs.mkdtempSync(path.join(env.RUNNER_TEMP || os.tmpdir(), 'mobile-eas-env-'));
  const file = path.join(dir, 'eas.env');
  try {
    const neutral = { ...env };
    for (const name of SELECTORS) delete neutral[name];
    easOrThrow(neutral, ['env:pull', '--environment', environment, '--path', file, '--non-interactive'], `Reading the EAS ${environment} environment`);
    return parseDotenv(fs.readFileSync(file, 'utf8'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

function summarize(env, lines) {
  for (const line of lines) console.log(line);
  if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, `${lines.map((line) => `- ${line}`).join('\n')}\n`);
}

/** Print upload results as Actions annotations. Only the first line is the annotation; the CLI output follows it. */
function annotate(results) {
  for (const { level, message } of results) {
    const [first, ...rest] = redact(message).split('\n');
    console.log(`::${level}::${first}`);
    for (const line of rest) console.log(line);
  }
  return results.map(({ message }) => redact(message).split('\n')[0]);
}

async function run() {
  const [profile, mode] = process.argv.slice(2);
  if (mode && !['--execute', '--dry-run'].includes(mode)) throw new Error('Use --dry-run or --execute.');
  const plan = autoUpdatePlan(profile, { MOBILE_UPDATE_MESSAGE: 'plan', ...process.env });
  console.log(JSON.stringify({ action: 'update', profile, channel: plan.policy.channel, environment: plan.policy.environment, platform: 'all', execute: mode === '--execute' }));
  if (mode !== '--execute') return;
  assertAutoExecution(process.env);
  autoUpdatePlan(profile, process.env);
  if (['ios', 'android'].some((name) => fs.existsSync(path.join(root, name)))) throw new Error('Publish from CNG source without generated native directories.');
  const env = publishEnvironment(process.env, pullEnvironment(process.env, plan.policy.environment), profile);
  const { getConfig } = require('@expo/config');
  const previous = process.env;
  let exp;
  process.env = env;
  try { ({ exp } = getConfig(root, { skipSDKVersionRequirement: true })); } finally { process.env = previous; }
  assertUpdateConfig(exp, profile);
  assertChannel(JSON.parse(easOrThrow(env, ['channel:view', plan.policy.channel, '--json', '--non-interactive'], `Reading the ${plan.policy.channel} channel`)), plan.policy.channel);
  const published = JSON.parse(easOrThrow(env, autoUpdatePlan(profile, env).args, `Publishing to ${plan.policy.channel}`));
  const lines = [`${plan.policy.channel}: update group ${published[0]?.group ?? 'unknown'}`];
  for (const update of published) {
    lines.push(`${plan.policy.channel} ${update.platform}: update ${update.id}, runtime ${update.runtimeVersion}`);
    const builds = eas(env, ['build:list', '--channel', plan.policy.channel, '--platform', update.platform, '--status', 'finished',
      '--runtime-version', update.runtimeVersion, '--limit', '1', '--json', '--non-interactive']);
    let found = null;
    try { found = builds.status === 0 ? JSON.parse(builds.stdout).length > 0 : null; } catch { /* Reported as unknown. */ }
    if (found === false) {
      console.log(`::warning::No finished ${plan.policy.channel} ${update.platform} build runs runtime ${update.runtimeVersion}. The native fingerprint changed, so this update reaches no installed app until a new binary ships.`);
    } else if (found === null) console.log(`::notice::Could not list ${plan.policy.channel} ${update.platform} builds to confirm an installed binary runs runtime ${update.runtimeVersion}.`);
  }
  lines.push(...annotate(uploadUpdateSourceMaps({ env: process.env, root, exp, channel: plan.policy.channel })));
  summarize(env, lines);
}

if (require.main === module) {
  Promise.resolve().then(run).catch((error) => {
    console.error(`Update blocked: ${redact(error instanceof Error ? error.message : String(error))}`);
    process.exitCode = 1;
  });
}
module.exports = { autoUpdatePlan, assertAutoExecution, parseDotenv, publishEnvironment, assertUpdateConfig, redact };
