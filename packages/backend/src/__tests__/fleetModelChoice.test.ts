import { describe, it, expect } from 'vitest';
import {
  DEFAULT_FLEET_CODEX_MODEL_ID,
  DEFAULT_FLEET_MODEL_ID,
  FLEET_MODELS,
  POSTHOG_CODE_MODELS,
  defaultFleetModelForAgent,
  fleetAgentForModel,
  fleetProviderForModel,
  isStoredFleetModelId,
  isStoredPostHogCodeModelId,
  RETIRED_FLEET_MODELS,
  resolveFleetModel,
  storedFleetModelForAgent,
  fleetModelForAgent,
} from '@talyn/shared';

/**
 * Which model a fleet run uses, and why it is not Opus.
 *
 * Fleet runs were served by Opus 5 on every turn — nothing set a model, so the
 * SDK picked its own default — and cost $348 in 18.5 hours, about $15.85 a run.
 * Most of that work is mechanical: rebase, resolve conflicts, re-run CI, answer
 * review threads. Sonnet 5 is the default now, with the picker in Settings →
 * Talyn Fleet for workspaces that want Opus back.
 */
describe('fleet model choice', () => {
  it('defaults to Sonnet 5, not Opus', () => {
    expect(DEFAULT_FLEET_MODEL_ID).toBe('claude-sonnet-5');
  });

  it('defaults a Codex-only workspace to a Codex model', () => {
    expect(DEFAULT_FLEET_CODEX_MODEL_ID).toBe('gpt-5.6-terra');
    expect(fleetProviderForModel(DEFAULT_FLEET_CODEX_MODEL_ID)).toBe('openai');
    expect(defaultFleetModelForAgent('codex')).toBe(DEFAULT_FLEET_CODEX_MODEL_ID);
    expect(defaultFleetModelForAgent('claude')).toBe(DEFAULT_FLEET_MODEL_ID);
  });

  it('offers each vendor\'s current flagship', () => {
    // Verified against platform.claude.com and learn.chatgpt.com on 2026-09-09.
    // This is a DATED assertion, not a permanent truth — it fails loudly when
    // the catalogue is edited, which is the only signal this file has that
    // someone re-checked. Fable 5.1 shipped 2026-09-01 and sat unnoticed for a
    // week; Astra likewise. See the note on FLEET_MODELS.
    const ids = FLEET_MODELS.map((m) => m.id);
    expect(ids).toContain('claude-fable-5-1');
    expect(ids).toContain('gpt-6-astra');
  });

  it('offers the current-generation Claude ids', () => {
    expect(FLEET_MODELS.some((m) => m.id === DEFAULT_FLEET_MODEL_ID)).toBe(true);
    expect(FLEET_MODELS.some((m) => m.id === 'claude-opus-5')).toBe(true);
  });

  /**
   * The two catalogues used to be the SAME OBJECT (`FLEET_MODELS =
   * POSTHOG_CODE_MODELS`). They cannot be, now the fleet offers Codex: Talyn
   * always sends PostHog's tasks API `runtime_adapter: 'claude'`, and that
   * adapter 400s on a `gpt-*` id — so a shared list would offer every PostHog
   * Code user a model their own dispatch refuses.
   */
  it('does not offer Codex models to PostHog Code', () => {
    const codex = FLEET_MODELS.filter((m) => m.provider === 'openai');
    expect(codex.length).toBeGreaterThan(0);
    for (const m of codex) {
      expect(POSTHOG_CODE_MODELS.some((p) => p.id === m.id)).toBe(false);
      // The guard is the enforcement: a gpt id stored as a fleet model must
      // never validate as a PostHog Code one.
      expect(isStoredFleetModelId(m.id)).toBe(true);
      expect(isStoredPostHogCodeModelId(m.id)).toBe(false);
    }
  });

  /**
   * Every model's vendor decides the microVM's egress route table — a run
   * dispatched at an OpenAI model has no route to api.anthropic.com at all. So
   * a wrong entry here is a run that cannot make a single call, and guessing is
   * worse than being explicit.
   */
  it('pins every offered model to its vendor', () => {
    for (const m of FLEET_MODELS) {
      expect(fleetProviderForModel(m.id)).toBe(m.provider);
      expect(fleetAgentForModel(m.id)).toBe(m.provider === 'openai' ? 'codex' : 'claude');
    }
    expect(fleetProviderForModel('gpt-5.1-codex')).toBe('openai');
    // An id this build has never heard of answers Anthropic — the back-compat
    // answer, because every model that predates the field was Anthropic's and a
    // workspace may still have one pinned.
    expect(fleetProviderForModel('some-future-model')).toBe('anthropic');
    expect(fleetProviderForModel(undefined)).toBe('anthropic');
  });

  /**
   * A workspace that pinned a model the picker no longer offers must keep it.
   * Falling back to the default would quietly move it — in the other direction
   * that is a bigger bill, in this one a weaker model, and both are surprises.
   */
  it('accepts a stored legacy id as well as an offered one', () => {
    expect(isStoredFleetModelId('claude-sonnet-5')).toBe(true);
    expect(isStoredFleetModelId('claude-opus-5')).toBe(true);
    expect(isStoredFleetModelId('claude-opus-4-7')).toBe(true); // legacy, still accepted
  });

  it('rejects anything it does not recognise', () => {
    for (const bad of ['gpt-4', '', null, undefined, 42, 'claude-opus-99', 'gpt-5.2-codex']) {
      expect(isStoredFleetModelId(bad)).toBe(false);
    }
  });
});

/**
 * OpenAI withdraws models from the CHATGPT SIGN-IN path on its own schedule,
 * while leaving them on the API-key path. The fleet runs on the user's own
 * ChatGPT subscription, so the entire Codex catalogue went dead without
 * anything in this repo changing: every run answered
 * `"The 'gpt-5.1-codex' model is not supported when using Codex with a ChatGPT
 * account."` The harness still knew the id — the subscription was no longer
 * entitled to it.
 */
describe('retired Codex models', () => {
  it('offers only ids a ChatGPT account can currently run', () => {
    const openai = FLEET_MODELS.filter((m) => m.provider === 'openai').map((m) => m.id);
    // Every id that produced the outage must be gone from the MENU.
    for (const dead of Object.keys(RETIRED_FLEET_MODELS)) {
      expect(openai).not.toContain(dead);
    }
    expect(openai).toContain('gpt-5.6-terra');
  });

  it('migrates a retired pin forward instead of preserving it', () => {
    // A dead id is not a preference worth keeping: honouring it means a 400
    // and a failed run every time. Contrast LEGACY_POSTHOG_CODE_MODEL_IDS,
    // which still work and so are preserved.
    for (const [dead, replacement] of Object.entries(RETIRED_FLEET_MODELS)) {
      expect(resolveFleetModel(dead)).toBe(replacement);
      expect(FLEET_MODELS.some((m) => m.id === replacement)).toBe(true);
    }
  });

  it('leaves a live id and an unknown id alone', () => {
    // Not a rewrite-everything hook — only the ids we know are dead.
    expect(resolveFleetModel('claude-sonnet-5')).toBe('claude-sonnet-5');
    expect(resolveFleetModel('gpt-5.6-sol')).toBe('gpt-5.6-sol');
    expect(resolveFleetModel('some-future-model')).toBe('some-future-model');
    expect(resolveFleetModel(undefined)).toBeUndefined();
  });

  it('still routes a retired Codex id at OpenAI', () => {
    // fleetProviderForModel falls back to 'anthropic', and the fleet builds the
    // microVM's egress table from the answer. A retired pin that answered
    // 'anthropic' would send a Codex run at a workspace's Claude credential —
    // or refuse it for a credential that workspace never connected.
    for (const dead of Object.keys(RETIRED_FLEET_MODELS)) {
      expect(fleetProviderForModel(dead)).toBe('openai');
      expect(fleetAgentForModel(dead)).toBe('codex');
    }
  });

  it('still accepts a retired id as a STORED setting', () => {
    // It has to validate, or the executor's ladder drops past it to the next
    // source — which for a Codex-only workspace is the Claude default.
    for (const dead of Object.keys(RETIRED_FLEET_MODELS)) {
      expect(isStoredFleetModelId(dead)).toBe(true);
    }
  });
});

/**
 * Which model each AGENT runs, per workspace.
 *
 * `fleetModel` holds one model for one vendor, and the fleet has two agents —
 * so a workspace could never express "Opus 5 on Claude AND gpt-6-astra on
 * Codex". Everything downstream papered over that with the SHIPPED default:
 * the per-task "run this on Codex" menu sent it unconditionally, and switching
 * the workspace default across vendors overwrote the other vendor's choice with
 * it. The picker saved a value that those paths never read.
 */
describe('per-agent model selection', () => {
  it('answers undefined when the workspace has chosen nothing', () => {
    // Must not answer the default here — the dispatch ladder has rungs below
    // the workspace (the environment's model), and answering would eat them.
    expect(storedFleetModelForAgent(undefined, 'codex')).toBeUndefined();
    expect(storedFleetModelForAgent({}, 'claude')).toBeUndefined();
  });

  it('reads each agent out of the per-agent map', () => {
    const settings = {
      fleetModels: { claude: 'claude-opus-5', codex: 'gpt-6-astra' },
    } as const;
    expect(storedFleetModelForAgent(settings, 'claude')).toBe('claude-opus-5');
    expect(storedFleetModelForAgent(settings, 'codex')).toBe('gpt-6-astra');
  });

  it('falls back to the legacy single field, but ONLY for its own vendor', () => {
    // The bug this guards: `fleetModel` is one model for one vendor. Handing a
    // Claude id back as the Codex answer is not a preference, it is a dispatch
    // at a credential the workspace may not even hold.
    const claudePinned = { fleetModel: 'claude-opus-5' } as const;
    expect(storedFleetModelForAgent(claudePinned, 'claude')).toBe('claude-opus-5');
    expect(storedFleetModelForAgent(claudePinned, 'codex')).toBeUndefined();

    const codexPinned = { fleetModel: 'gpt-5.6-sol' } as const;
    expect(storedFleetModelForAgent(codexPinned, 'codex')).toBe('gpt-5.6-sol');
    expect(storedFleetModelForAgent(codexPinned, 'claude')).toBeUndefined();
  });

  it('prefers the per-agent map over the legacy field', () => {
    const settings = {
      fleetModel: 'claude-sonnet-5',
      fleetModels: { claude: 'claude-opus-5' },
    } as const;
    expect(storedFleetModelForAgent(settings, 'claude')).toBe('claude-opus-5');
  });

  it('ignores an entry filed under the wrong vendor', () => {
    // Hand-edited settings, or a model that changed hands. Returning it would
    // send a Claude id to a Codex run.
    const settings = { fleetModels: { codex: 'claude-opus-5' } } as const;
    expect(storedFleetModelForAgent(settings, 'codex')).toBeUndefined();
    expect(fleetModelForAgent(settings, 'codex')).toBe(DEFAULT_FLEET_CODEX_MODEL_ID);
  });

  it('applies the shipped default only when nothing was chosen', () => {
    expect(fleetModelForAgent(undefined, 'claude')).toBe(DEFAULT_FLEET_MODEL_ID);
    expect(fleetModelForAgent(undefined, 'codex')).toBe(DEFAULT_FLEET_CODEX_MODEL_ID);
    expect(fleetModelForAgent({ fleetModels: { codex: 'gpt-5.6-luna' } }, 'codex')).toBe(
      'gpt-5.6-luna'
    );
  });

  it('migrates a retired pin on the way out', () => {
    // A workspace pinned to a withdrawn Codex id must not have it handed back.
    const settings = { fleetModels: { codex: 'gpt-5.1-codex' } } as const;
    expect(storedFleetModelForAgent(settings, 'codex')).toBe('gpt-5.1-codex');
    expect(fleetModelForAgent(settings, 'codex')).toBe(RETIRED_FLEET_MODELS['gpt-5.1-codex']);
  });
});
