// Asking the vendor whether a subscription is REALLY spent, instead of
// believing a sentence about it.
//
// # Why this exists
//
// `exhaustedQuota.ts` learns "this subscription has nothing left" from the
// words a failed run came back with, because neither vendor exposes a
// "how much is left" endpoint. That inference is load-bearing — it parks the
// agent, moves the work to the other vendor and tells the user to go and top
// up — and on 2026-09-21 it was WRONG for a whole day.
//
// Anthropic answered every fleet run with a 400 `invalid_request_error`:
// "You're out of extra usage. Add more at claude.ai/settings/usage and keep
// going." The same stored credential, at the same minute, answered HTTP 200
// with `anthropic-ratelimit-unified-status: allowed` — from a laptop, from the
// fleet host itself, and through the fleet harness's own request builder
// (`@earendil-works/pi-ai`, the version the guest image pins), with tools, with
// a 200KB request, streaming, at `max_tokens: 128000`. So the sentence was
// real and its subject was not this account: something in the sandbox path
// turns a perfectly good subscription request into a refusal. That is still
// open — see docs/SESSIONS.md — and every hour it stayed open, Talyn silently
// ran the user's work on the vendor they had not chosen and blamed them for it.
//
// # What it does instead
//
// One minimal request to the vendor, with the workspace's own credential, at
// the moment a run claims exhaustion. The answer is evidence rather than prose:
// if the vendor serves a one-token turn, the subscription is not spent,
// whatever the failed run said.
//
// # What it deliberately does not do
//
// It does not probe on a schedule, it is not a health check, and it never runs
// except on the failure path — so a workspace that never hits this pays
// nothing. And it can only ever answer three ways: an unreachable vendor, a
// missing credential or an unrecognised refusal is `unknown`, which leaves the
// caller doing exactly what it did before this existed. Being unsure must not
// be more decisive than being told.

import {
  defaultFleetModelForAgent,
  fleetAgentForModel,
  type FleetAgent,
} from '@talyn/shared';
import { getSelfHostedCredentials } from './credentials.js';
import { workspaceAgentModel } from './fleetModel.js';
import { exhaustedAgentFrom } from './exhaustedQuota.js';
import { debugBus } from '../debugBus.js';

/**
 * What the vendor said when asked directly.
 *
 * `unknown` is not a failure of this module, it is its honest answer for
 * everything that is not a clean yes or no — and it is the common case for
 * Codex, whose ChatGPT-subscription endpoint this cannot probe (see below).
 */
export type QuotaVerdict = 'spent' | 'available' | 'unknown';

/** How long the probe may take. Past this the answer is `unknown`. */
const PROBE_TIMEOUT_MS = 20_000;

/**
 * Anthropic's OAuth path serves its OWN client, so a request that does not look
 * like Claude Code is refused with a 429 on an account with quota to spare —
 * which would read as "unknown" here and waste the probe. This is the same
 * shape the fleet's harness builds in its OAuth mode: Bearer, the two betas,
 * the CLI user-agent, and Claude Code's identity as the FIRST system block.
 */
const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

/**
 * Can this workspace's Claude credential still run a model, right now?
 *
 * One token in, one token out, on the workspace's own model — the cheapest
 * question that distinguishes "this subscription is spent" from "that one run
 * was refused for some other reason".
 */
async function probeClaude(workspaceId: string, token: string): Promise<QuotaVerdict> {
  const model = await workspaceAgentModel(workspaceId, 'claude').catch(() =>
    defaultFleetModelForAgent('claude')
  );
  // A Codex model would be refused by Anthropic for reasons that have nothing
  // to do with quota, and `workspaceAgentModel` is vendor-checked, so this can
  // only happen if the catalogue changes hands under us.
  const probeModel = fleetAgentForModel(model) === 'claude' ? model : defaultFleetModelForAgent('claude');

  let res: Response;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      headers: {
        authorization: `Bearer ${token}`,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20',
        'content-type': 'application/json',
        'user-agent': 'claude-cli/2.1.75',
        'x-app': 'cli',
      },
      body: JSON.stringify({
        model: probeModel,
        max_tokens: 1,
        system: [{ type: 'text', text: CLAUDE_CODE_IDENTITY }],
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
  } catch {
    // The vendor is unreachable from here. That says nothing about the quota.
    return 'unknown';
  }

  if (res.ok) return 'available';
  const body = await res.text().catch(() => '');
  // The SAME matcher the failure path uses, so the probe cannot disagree with
  // the detector about what an exhaustion sounds like.
  return exhaustedAgentFrom(body) === 'claude' ? 'spent' : 'unknown';
}

/**
 * Ask the vendor whether `agent`'s subscription is spent.
 *
 * Claude only, for now. Codex on the fleet runs on a ChatGPT subscription
 * through OpenAI's Codex backend, which wants an account id parsed out of the
 * token and a request shape this module would have to keep in step with
 * OpenAI's own client — a second stealth path to maintain, for a vendor we
 * have never actually observed reporting an exhaustion. Until then it answers
 * `unknown`, which leaves Codex behaving exactly as it does today.
 */
export async function verifyAgentQuota(
  workspaceId: string,
  agent: FleetAgent
): Promise<QuotaVerdict> {
  if (agent !== 'claude') return 'unknown';

  const creds = await getSelfHostedCredentials(workspaceId).catch(() => null);
  const token = creds?.claudeToken;
  // No credential is not a quota answer: the dispatch path refuses such a run
  // long before this, and pretending to know would park an agent over a
  // missing key.
  if (!token) return 'unknown';

  const verdict = await probeClaude(workspaceId, token);
  debugBus.recordEvent({
    service: 'fleet',
    action: 'quota_probe',
    summary: `${agent} quota probe → ${verdict}`,
    workspaceId,
    ok: verdict !== 'spent',
  });
  return verdict;
}
