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
    source_session_id: Id.nullable(),
    seen_count: z.number().int(),
    first_seen_at: Timestamp,
    last_seen_at: Timestamp,
    applied_at: Timestamp.nullable().openapi({ description: 'When the step went into the baked image.' }),
    reverted_at: Timestamp.nullable().openapi({ description: 'A person reverted the step. Talyn does not learn it again.' }),
    reverted_reason: z.string().nullable(),
  })
  .openapi('SetupStep');

export const SetupRecipe = z
  .object({
    object: z.literal('setup_recipe'),
    repository_id: Id,
    learning: z.boolean(),
    max_steps: z.number().int(),
    steps: z.array(SetupStep),
  })
  .openapi('SetupRecipe');

export const SetupStepParams = z.object({ id: Id, step_id: Id });
