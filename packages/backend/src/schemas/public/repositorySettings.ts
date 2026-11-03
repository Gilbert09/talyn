import { MAX_REPOSITORY_INSTRUCTION_BYTES, REPOSITORY_INSTRUCTION_AGENTS, SANDBOX_SIZE_SETTINGS } from '@talyn/shared';
import { Id, Timestamp } from './common.js';
import { SANDBOX_SIZES_LIST } from './sessionWork.js';
import { z } from './zod.js';

/**
 * Per-repository settings for sessions: the sandbox size, the preview, setup
 * learning, the instructions written in Talyn and the learned setup recipe.
 */

const SizeSetting = z.enum(SANDBOX_SIZE_SETTINGS as [string, ...string[]]);
const PREVIEW_TARGETS = ['sandbox', 'coder', 'off'] as const;

const PreviewPort = z.object({
  port: z.number().int().min(1).max(65535),
  label: z.string().max(500).nullable(),
  primary: z.boolean(),
});

const PreviewPortInput = z
  .object({
    port: z.number().int().min(1).max(65535),
    label: z.string().max(500).optional(),
    primary: z.boolean().optional(),
  })
  .strict();

const CoderSettings = z.object({
  url: z.string().max(500).optional(),
  workspace: z.string().max(500).optional(),
  checkout: z.string().max(500).optional(),
  run: z.string().max(500).optional(),
});

export const RepositorySettings = z
  .object({
    object: z.literal('repository_settings'),
    repository_id: Id,
    sandbox_size: z.object({
      setting: SizeSetting.openapi({ description: '`auto`: the detected size, else `standard`.' }),
      detected: z.enum(SANDBOX_SIZES_LIST).nullable().openapi({ description: "Read from the repository's compose files. Null until detected." }),
      detected_reason: z.string().nullable(),
      effective: z.enum(SANDBOX_SIZES_LIST).openapi({ description: 'What a new session gets.' }),
    }),
    preview: z.object({
      target: z.enum(['auto', ...PREVIEW_TARGETS]).openapi({ description: 'Your choice. `auto`: from `.talyn/settings.toml`, else detected.' }),
      ports: z.array(PreviewPort).nullable().openapi({ description: 'Your choice. Null: from the file, else detected.' }),
      coder: CoderSettings.nullable(),
      effective: z.object({
        target: z.enum(PREVIEW_TARGETS).nullable(),
        ports: z.array(PreviewPort),
        source: z.enum(['user', 'file', 'detected', 'none']),
      }),
    }),
    setup_learning: z.boolean().openapi({ description: 'Talyn learns setup steps from sessions and runs them on new sandboxes.' }),
  })
  .openapi('RepositorySettings');

export const UpdateRepositorySettingsBody = z
  .object({
    sandbox_size: SizeSetting.optional(),
    preview: z
      .object({
        target: z.enum(['auto', ...PREVIEW_TARGETS]).optional(),
        ports: z.array(PreviewPortInput).max(16).optional(),
        coder: CoderSettings.strict().optional(),
      })
      .strict()
      .optional(),
    setup_learning: z.boolean().optional(),
  })
  .strict()
  .openapi('UpdateRepositorySettingsRequest');

export const INSTRUCTION_AGENTS = REPOSITORY_INSTRUCTION_AGENTS as unknown as [string, ...string[]];

export const RepositoryInstructions = z
  .object({
    object: z.literal('repository_instructions'),
    repository_id: Id,
    agents: z.enum(INSTRUCTION_AGENTS).openapi({ description: 'Which agents get the text: `claude`, `codex` or `both`.' }),
    body: z.string(),
    bytes: z.number().int(),
    updated_at: Timestamp,
  })
  .openapi('RepositoryInstructions');

export const PutRepositoryInstructionsBody = z
  .object({
    body: z.string().min(1).openapi({ description: `Markdown, at most ${MAX_REPOSITORY_INSTRUCTION_BYTES} bytes of UTF-8.` }),
    agents: z.enum(INSTRUCTION_AGENTS),
  })
  .strict()
  .openapi('PutRepositoryInstructionsRequest');

export const SetupStep = z
  .object({
    id: Id,
    command: z.string(),
    kind: z.string().openapi({ description: 'For example `package_install`, `service` or `database`. New values can appear.' }),
    phase: z.enum(['install', 'start']).openapi({ description: '`install` steps also go into the baked image.' }),
    why: z.string().nullable(),
    source: z.enum(['learned', 'agent']),
    state: z.enum(['waiting', 'live', 'failing', 'reverted']).openapi({
      description: '`waiting`: too few of the repository\'s recent sessions need it, so it does not run (see `state_reason`). `live`: runs on every new box. `failing`: failed on 2 boxes in a row and does not run. `reverted`: a person reverted it.',
    }),
    source_session_id: Id.nullable(),
    seen_count: z.number().int(),
    session_count: z.number().int().openapi({ description: 'The different sessions that needed the step.' }),
    first_seen_at: Timestamp,
    last_seen_at: Timestamp,
    applied_at: Timestamp.nullable().openapi({ description: 'When the step went into the baked image.' }),
    reverted_at: Timestamp.nullable().openapi({ description: 'A person reverted the step. Talyn does not learn it again.' }),
    reverted_reason: z.string().nullable(),
    box_failure_count: z.number().int().openapi({ description: 'Box setups in a row where the step failed.' }),
    box_last_failure: z.string().nullable().openapi({ description: 'The exit code or time limit, and the last line the step printed.' }),
    box_disabled_at: Timestamp.nullable().openapi({ description: 'The step failed on too many boxes and no longer runs.' }),
    box_disabled_reason: z.string().nullable(),
    recent_needed_sessions: z.number().int().optional().openapi({
      description: 'The repository\'s sandbox sessions of the last `window_days` days that needed the step: they ran it, or used what a live step installs.',
    }),
    recent_sessions: z.number().int().optional().openapi({ description: 'The repository\'s sandbox sessions of the last `window_days` days.' }),
    share: z.number().nullable().optional().openapi({ description: '`recent_needed_sessions / recent_sessions`, 0 to 1. Null: no recent sessions.' }),
    heavy: z.boolean().optional().openapi({ description: 'The step installs a browser or a large package set, so it needs a higher share to run.' }),
    state_reason: z.string().optional().openapi({ description: 'Why the step is in its state, for example "Waiting: needed by 2 of 31 sessions in the last 14 days. ..."' }),
    last_duration_ms: z.number().int().nullable().optional().openapi({ description: 'How long the step took in the newest box setup that measured it.' }),
    typical_duration_ms: z.number().int().nullable().optional().openapi({ description: 'A rolling mean of the step\'s time in the box setup.' }),
    measured_boxes: z.number().int().optional().openapi({ description: 'The box setups that measured the step.' }),
  })
  .openapi('SetupStep');

export const SetupTiming = z
  .object({
    total_ms: z.number().int().openapi({ description: 'The whole setup script.' }),
    repository_ms: z.number().int().nullable().openapi({ description: 'The repository\'s own setup command. Null: the repository has none.' }),
    learned_ms: z.number().int().openapi({ description: 'All learned steps together.' }),
    measured_at: Timestamp,
    session_id: Id.nullable(),
  })
  .openapi('SetupTiming');

export const SetupRecipe = z
  .object({
    object: z.literal('setup_recipe'),
    repository_id: Id,
    learning: z.boolean(),
    max_steps: z.number().int(),
    window_days: z.number().int().optional().openapi({ description: 'The window that `recent_sessions` counts sessions in.' }),
    last_setup_timing: SetupTiming.nullable().optional().openapi({ description: 'The times of the newest box setup that ran learned steps.' }),
    steps: z.array(SetupStep),
  })
  .openapi('SetupRecipe');

export const SetupStepParams = z.object({ id: Id, step_id: Id });
