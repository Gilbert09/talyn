#!/usr/bin/env node
/**
 * Tell us when Anthropic's catalogue and ours have diverged.
 *
 * We hard-code the models Talyn offers because the list is CURATED — ordering,
 * blurbs, and deliberate exclusions (Haiku, Mythos, anything text-only) are
 * judgement a live fetch would throw away. The cost of curating is that the
 * list silently rots: Claude Fable 5.1 shipped 2026-09-01 and we were still
 * offering Fable 5 as "newest" a week later, because nothing broke — a legacy
 * model keeps working, it just stops being the best one available.
 *
 * So this does not fetch-and-replace. It fetches and COMPARES, and the output
 * is for a human who then decides the label and whether to offer it at all.
 *
 * Only Anthropic. There is deliberately no Codex half: OpenAI's `GET /v1/models`
 * answers for an API KEY, while the fleet runs on the user's own ChatGPT
 * subscription, and the entitlement difference between those two is exactly
 * what took Codex runs down. A check that consulted it would have reported
 * `gpt-5.1-codex` as healthy on the day every Codex run was failing. That half
 * is handled at run time instead — see services/selfHosted/withdrawnModels.ts.
 */
import {
  FLEET_MODELS,
  LEGACY_POSTHOG_CODE_MODEL_IDS,
  RETIRED_FLEET_MODELS,
} from '../packages/shared/dist/cjs/index.js';

/**
 * Models Anthropic serves that we choose not to offer, and why. An entry here
 * is a decision; the check stays quiet about it. Without this the report cries
 * wolf every run and stops being read.
 */
const NOT_OFFERED = {
  'claude-haiku-4-5': 'cheapest tier — not worth pointing at a PR',
  'claude-mythos-5': 'Project Glasswing only',
  'claude-mythos-5-1': 'Project Glasswing only',
  'claude-mythos-preview': 'invitation-only preview',
};

/**
 * The Models API returns DATED ids for models whose dateless form is an alias
 * (`claude-haiku-4-5-20251001`), while we — and Anthropic's own docs — write
 * the alias. Comparing the two raw forms reports every aliased model as
 * missing, which on the first real run was four of the five "findings".
 */
const alias = (id) => id.replace(/-\d{8}$/, '');

/**
 * Ids we deliberately still ACCEPT without OFFERING: a workspace may have one
 * pinned, so they must keep validating, but they are off the menu. Reporting
 * them as missing would push someone to re-add a model we chose to retire from
 * the picker.
 */
const acceptedNotOffered = new Set([
  ...LEGACY_POSTHOG_CODE_MODEL_IDS,
  ...Object.keys(RETIRED_FLEET_MODELS),
]);

const KEY = process.env.ANTHROPIC_API_KEY;
if (!KEY) {
  // Absent secret is a SKIP, not a failure — the same posture as the fork
  // guards on the deploy workflows. A red build for a missing optional secret
  // trains people to ignore red builds.
  console.log('ANTHROPIC_API_KEY not set — skipping the model catalogue check.');
  process.exit(0);
}

const res = await fetch('https://api.anthropic.com/v1/models?limit=100', {
  headers: { 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
});
if (!res.ok) {
  console.log(`Models API returned ${res.status} — skipping (not treating a vendor blip as drift).`);
  process.exit(0);
}

// Keyed by ALIAS on both sides, so a dated id and its dateless form compare equal.
const live = new Map(
  (await res.json()).data.map((m) => [alias(m.id), m.display_name ?? m.id]),
);
const offered = new Set(
  FLEET_MODELS.filter((m) => m.provider === 'anthropic').map((m) => alias(m.id)),
);

// The dangerous direction: we offer something the vendor no longer serves.
const gone = [...offered].filter((id) => !live.has(id));
// The chore direction: the vendor serves something we have made no decision about.
const missing = [...live.keys()].filter(
  (id) => !offered.has(id) && !(id in NOT_OFFERED) && !acceptedNotOffered.has(id),
);

if (gone.length === 0 && missing.length === 0) {
  console.log(`In step with Anthropic: ${offered.size} models offered, none missing or stale.`);
  process.exit(0);
}

if (gone.length) {
  console.log('\nOFFERED BUT NOT SERVED — a dispatch at these will fail:');
  for (const id of gone) console.log(`  ${id}`);
}
if (missing.length) {
  console.log('\nSERVED BUT NOT OFFERED — add to FLEET_MODELS, or to NOT_OFFERED with a reason:');
  for (const id of missing) console.log(`  ${id}  (${live.get(id)})`);
}
console.log('\npackages/shared/src/index.ts → FLEET_MODELS');
process.exit(1);
