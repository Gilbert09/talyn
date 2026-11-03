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

// ============================================================================
// The Setup list
// ============================================================================

const RUN_ON = ['image', 'box', 'both'] as const;
const RUN_ON_BOX = ['always', 'moved', 'never'] as const;

export const BoxSetupTiming = z
  .object({
    total_ms: z.number().int().openapi({ description: 'The whole setup script.' }),
    repository_ms: z.number().int().nullable().openapi({ description: "The repository's own setup command. Null: the repository has none." }),
    learned_ms: z.number().int().openapi({ description: 'All setup steps together.' }),
    measured_at: Timestamp,
    session_id: Id.nullable(),
    box_ready_ms: z.number().int().nullable().optional().openapi({ description: 'From the create request until the sandbox was ready.' }),
    checkout_ms: z.number().int().nullable().optional().openapi({ description: 'The checkout of the repository.' }),
    setup_repository_ms: z.number().int().nullable().optional().openapi({ description: "The repository's own setup on the box." }),
    setup_box_steps_ms: z.number().int().nullable().optional().openapi({ description: 'The setup steps that ran on the box.' }),
    layer: z.string().nullable().optional().openapi({ description: 'The image the box started from: `base`, `legacy`, `repo` or `user`.' }),
  })
  .openapi('BoxSetupTiming');

export const SetupListStep = z
  .object({
    id: Id,
    repository_id: Id.nullable().openapi({ description: 'Null: a workspace step.' }),
    position: z.number().int(),
    name: z.string(),
    command: z.string(),
    kind: z.string().openapi({ description: 'For example `apt`, `node`, `service` or `other`. New values can appear.' }),
    run_on: z.enum(RUN_ON).openapi({
      description: '`image`: the step goes into the image. `box`: the step runs on each new box. `both`: the step goes into the image and runs again on each box.',
    }),
    origin: z.enum(['user', 'learned', 'agent']).openapi({ description: '`user`: a person wrote the step. `learned`: Talyn learned it from a session. `agent`: an agent recorded it.' }),
    status: z.enum(['active', 'suggested', 'dismissed', 'disabled']).openapi({
      description: '`active`: the step runs. `suggested`: Talyn learned the step and it does not run until it is accepted. `dismissed`: a person dismissed it, and Talyn does not suggest it again. `disabled`: it failed on too many boxes in a row and does not run until a person retries it.',
    }),
    status_reason: z.string().nullable().openapi({ description: 'Why the step has its status.' }),
    status_changed_at: Timestamp.nullable(),
    accepted_by: z.enum(['person', 'talyn']).nullable().openapi({
      description: '`person`: Talyn never removes the step. `talyn`: the frequency rule accepted it, and Talyn removes it when few sessions need it.',
    }),
    timeout_sec: z.number().int().nullable(),
    box_only_reason: z.string().nullable().openapi({ description: 'The step reads a secret, so it runs only on the box.' }),
    why: z.string().nullable(),
    source_session_id: Id.nullable(),
    seen_count: z.number().int(),
    session_count: z.number().int().openapi({ description: 'The different sessions that needed the step.' }),
    first_seen_at: Timestamp,
    last_seen_at: Timestamp,
    confirmed_at: Timestamp.nullable().openapi({ description: 'When the step was accepted.' }),
    image_applied_at: Timestamp.nullable().openapi({ description: 'When the step went into the image. Null: not yet.' }),
    image_failed_at: Timestamp.nullable().openapi({ description: 'The step failed in an image build. It runs on the box instead.' }),
    image_failure_reason: z.string().nullable(),
    box_failure_count: z.number().int().openapi({ description: 'Box setups in a row where the step failed.' }),
    box_last_failure: z.string().nullable(),
    last_duration_ms: z.number().int().nullable(),
    typical_duration_ms: z.number().int().nullable(),
    measured_boxes: z.number().int(),
    recent_needed_sessions: z.number().int().optional().openapi({ description: 'Learned steps only: the recent sessions that needed the step.' }),
    recent_sessions: z.number().int().optional().openapi({ description: "Learned steps only: the repository's sandbox sessions of the last `window_days` days." }),
    share: z.number().nullable().optional().openapi({ description: '`recent_needed_sessions / recent_sessions`, 0 to 1.' }),
    heavy: z.boolean().optional(),
    verdict_reason: z.string().optional().openapi({ description: "The frequency rule's reason, for a learned step." }),
    created_at: Timestamp,
    updated_at: Timestamp,
  })
  .openapi('SetupListStep');

const SetupListLimits = z.object({
  image_max_steps: z.number().int(),
  image_total_sec: z.number().int(),
  max_hosts: z.number().int(),
  max_user_steps: z.number().int(),
  step_max_sec: z.number().int(),
});

export const RepositorySetup = z
  .object({
    object: z.literal('repository_setup'),
    repository_id: Id,
    learning: z.boolean().openapi({ description: 'Talyn learns setup steps from sessions and suggests them.' }),
    window_days: z.number().int(),
    max_learned_steps: z.number().int(),
    limits: SetupListLimits,
    repo_setup: z.object({
      command: z.string().nullable().openapi({ description: "The repository's own setup command, as the newest box read it." }),
      source: z.string().nullable(),
      read_at: Timestamp.nullable(),
      run_on_box: z.enum(RUN_ON_BOX).openapi({ description: '`moved`: only when the checkout is not the commit of the image.' }),
    }),
    steps: z.array(SetupListStep).openapi({ description: 'The steps in order. Dismissed steps come last.' }),
    hosts: z.array(z.string()).openapi({ description: 'Extra hosts that the image build can reach.' }),
    image: z
      .object({
        layer: z.string().nullable(),
        repo_commit: z.string().nullable(),
        repo_layer_pending: z.boolean().nullable(),
        user_layer_pending: z.boolean().nullable(),
        repo_setup_ok: z.boolean().nullable(),
        applied_step_ids: z.array(Id),
        checked_at: Timestamp,
        session_id: Id.nullable(),
      })
      .nullable()
      .openapi({ description: 'What the newest box of the repository was told about its images.' }),
    last_setup_timing: BoxSetupTiming.nullable(),
    timing_history: z.array(BoxSetupTiming).openapi({ description: 'The newest box setups, newest first.' }),
  })
  .openapi('RepositorySetup');

const SetupListStepInput = z
  .object({
    id: Id.optional().openapi({ description: 'An existing step. No id: a new step of your own.' }),
    name: z.string().min(1).max(128),
    command: z.string().optional().openapi({ description: 'Required for a new step. The command of a learned step cannot change.' }),
    run_on: z.enum(RUN_ON),
    timeout_sec: z.number().int().nullable().optional(),
  })
  .strict();

export const PutRepositorySetupBody = z
  .object({
    steps: z.array(SetupListStepInput).optional().openapi({
      description: 'The whole list in its new order. Your own step that is not in the list is deleted. A learned step that is not in the list keeps its status and goes last: to remove it, dismiss it.',
    }),
    run_on_box: z.enum(RUN_ON_BOX).optional(),
    hosts: z.array(z.string()).optional(),
    learning: z.boolean().optional(),
  })
  .strict()
  .openapi('PutRepositorySetupRequest');

const SandboxDotfiles = z.object({
  slug: z.string().openapi({ description: '`owner/name`.' }),
  ref: z.string().openapi({ description: 'A branch, tag or commit. Empty: the default branch.' }),
  install: z.string().nullable().openapi({ description: 'The install command. Null: Talyn looks for a known install script.' }),
});

export const WorkspaceSandboxSetup = z
  .object({
    object: z.literal('workspace_sandbox_setup'),
    workspace_id: Id,
    dotfiles: SandboxDotfiles.nullable(),
    hosts: z.array(z.string()),
    steps: z.array(SetupListStep).openapi({ description: "The workspace's steps. They go before each repository's steps." }),
    limits: SetupListLimits,
  })
  .openapi('WorkspaceSandboxSetup');

export const PutWorkspaceSandboxSetupBody = z
  .object({
    dotfiles: z
      .object({ slug: z.string(), ref: z.string().optional(), install: z.string().nullable().optional() })
      .strict()
      .nullable()
      .optional()
      .openapi({ description: 'Null: no dotfiles.' }),
    hosts: z.array(z.string()).optional(),
    steps: z.array(SetupListStepInput).optional().openapi({ description: 'The whole list in its new order. A step that is not in the list is deleted.' }),
  })
  .strict()
  .openapi('PutWorkspaceSandboxSetupRequest');
