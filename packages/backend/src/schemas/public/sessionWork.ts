import { PR_TITLE_MAX, SANDBOX_SIZE_SETTINGS, TURN_TIME_CATEGORIES, WORKBENCH_EFFORTS } from '@talyn/shared';
import { Id, listOf, QueryBoolean, Timestamp } from './common.js';
import { AGENTS, Session } from './resources.js';
import { z } from './zod.js';

/**
 * The work inside a session (changes, diff, files, scripts, previews, pull
 * request actions, threads, timing, resize) and the chat extras (rename,
 * close, queue, checkpoints). Request objects are `.strict()`, as in
 * `resources.ts`.
 */

export const SANDBOX_SIZES_LIST = SANDBOX_SIZE_SETTINGS.filter((s) => s !== 'auto') as [string, ...string[]];

/** A path inside the repository. The service refuses `..`, a leading `/` and NUL. */
const RepoPath = z.string().min(1).max(4096);

// ---------------------------------------------------------------------------
// Changes, diff and files
// ---------------------------------------------------------------------------

export const ChangedFile = z
  .object({
    path: z.string(),
    old_path: z.string().nullable().openapi({ description: 'The path on the base side of a rename. Null otherwise.' }),
    status: z.enum(['added', 'modified', 'deleted', 'renamed']),
    added: z.number().int(),
    removed: z.number().int(),
    binary: z.boolean(),
  })
  .openapi('ChangedFile');

const DiffStat = z.object({ added: z.number().int(), removed: z.number().int(), files: z.number().int() }).openapi('DiffStat');

export const SessionChanges = z
  .object({
    object: z.literal('session_changes'),
    session_id: Id,
    files: z.array(ChangedFile).openapi({ description: 'Every change against the merge base: committed, uncommitted and untracked.' }),
    uncommitted: z.array(ChangedFile).openapi({ description: 'Changes not committed yet, untracked files included.' }),
    committed: z.array(ChangedFile).openapi({ description: 'Commits on the branch since the merge base.' }),
    uncommitted_stat: DiffStat,
    committed_stat: DiffStat,
    base_sha: z.string().nullable().openapi({ description: 'The merge-base commit the diff is taken against.' }),
    head_sha: z.string().nullable(),
    snapshot_at: Timestamp.nullable().openapi({
      description: 'Set when the list is the stored copy of a sleeping sandbox: when Talyn took it. Null on a live read.',
    }),
  })
  .openapi('SessionChanges');

export const GetChangesQuery = z
  .object({
    live: QueryBoolean.optional().openapi({
      description: 'Read the sandbox now, and wake it if it sleeps. Default false: a sleeping sandbox answers from its stored copy.',
    }),
  })
  .strict();

export const DIFF_SCOPES = ['combined', 'uncommitted', 'committed'] as const;

const LiveFlag = QueryBoolean.optional().openapi({
  description:
    'Read the sandbox now, and wake it if it sleeps. Default false: a sleeping sandbox answers from the copy Talyn stored, ' +
    'or answers 409 `snapshot_unavailable` when there is none.',
});

const ReadSource = z.enum(['live', 'stored', 'github']).openapi({
  description: '`live`: read from the sandbox now. `stored`: the copy Talyn stored while the sandbox ran. `github`: read from GitHub.',
});

const ReadSnapshotAt = Timestamp.nullable().openapi({
  description: 'When the stored copy was taken. Null on a live read.',
});

export const SessionDiff = z
  .object({
    object: z.literal('diff'),
    session_id: Id,
    path: z.string().nullable().openapi({ description: 'The file the diff is limited to. Null: the whole diff.' }),
    scope: z.enum(DIFF_SCOPES),
    patch: z.string().openapi({ description: 'A unified diff, as `git diff` writes it. Untracked files are diffs against /dev/null.' }),
    source: ReadSource,
    snapshot_at: ReadSnapshotAt,
  })
  .openapi('SessionDiff');

export const GetDiffQuery = z
  .object({
    path: RepoPath.optional().openapi({ description: 'One file only. Default: every changed file.' }),
    scope: z.enum(DIFF_SCOPES).optional().openapi({
      description: '`combined` (default): everything against the merge base. `uncommitted`: against HEAD. `committed`: merge base to HEAD.',
    }),
    live: LiveFlag,
  })
  .strict();

export const FileList = z
  .object({
    object: z.literal('file_list'),
    session_id: Id,
    paths: z.array(z.string()).openapi({ description: 'Tracked and untracked files. Files that git ignores are not listed.' }),
    source: ReadSource,
    snapshot_at: ReadSnapshotAt,
  })
  .openapi('FileList');

export const ListFilesQuery = z.object({ live: LiveFlag }).strict();

export const FileContent = z
  .object({
    object: z.literal('file_content'),
    session_id: Id,
    path: z.string(),
    encoding: z.enum(['utf8', 'base64']).openapi({ description: '`base64` for a binary file.' }),
    content: z.string(),
    source: ReadSource,
    snapshot_at: ReadSnapshotAt,
  })
  .openapi('FileContent');

export const GetFileQuery = z
  .object({ path: RepoPath.openapi({ description: 'Relative to the repository root.' }), live: LiveFlag })
  .strict();

// ---------------------------------------------------------------------------
// Scripts
// ---------------------------------------------------------------------------

export const SCRIPT_STATUSES = ['running', 'exited', 'not_started'] as const;

export const Script = z
  .object({
    object: z.literal('script'),
    session_id: Id,
    name: z.string().openapi({ description: '`setup`, `run`, `archive`, or the name of a named run script.' }),
    kind: z.enum(['setup', 'run', 'archive']),
    command: z.string().nullable().openapi({ description: 'Null unless the list was read with `live=true`.' }),
    default: z.boolean().nullable().openapi({ description: 'For a run script read with `live=true`: whether `run` starts it. Null otherwise.' }),
    status: z.enum(SCRIPT_STATUSES),
    exit_code: z.number().int().nullable().openapi({ description: 'Null while it runs, before it ran, or when it was stopped.' }),
  })
  .openapi('Script');

export const ScriptList = listOf(Script, 'ScriptList');

export const ListScriptsQuery = z
  .object({
    live: QueryBoolean.optional().openapi({
      description:
        "Also read the session's config from the sandbox, and wake it if it sleeps, to list every script it defines with its command. " +
        'Default false: only the scripts that have run.',
    }),
  })
  .strict();

export const ScriptParams = z.object({
  id: Id,
  name: z.string().min(1).max(200).openapi({ description: 'The script name. `run` starts the default run script.' }),
});

export const ScriptOutput = z
  .object({
    object: z.literal('script_output'),
    session_id: Id,
    name: z.string(),
    status: z.enum(SCRIPT_STATUSES),
    exit_code: z.number().int().nullable(),
    output: z.string().openapi({ description: 'The end of the output, stdout and stderr together, at most 64 KiB.' }),
  })
  .openapi('ScriptOutput');

// ---------------------------------------------------------------------------
// Previews
// ---------------------------------------------------------------------------

export const Preview = z
  .object({
    object: z.literal('preview'),
    session_id: Id,
    port: z.number().int(),
    label: z.string().nullable(),
    primary: z.boolean(),
    origin: z.string().nullable().openapi({
      description: 'The hosted preview origin, once a link was made for this port. A browser needs a link from POST /sessions/{id}/previews to open it.',
    }),
  })
  .openapi('Preview');

export const PreviewList = listOf(Preview, 'PreviewList');

export const CreatePreviewLinkBody = z
  .object({ port: z.number().int().min(1024).max(65535) })
  .strict()
  .openapi('CreatePreviewLinkRequest');

export const PreviewLink = z
  .object({
    object: z.literal('preview_link'),
    session_id: Id,
    port: z.number().int(),
    url: z.string().openapi({ description: 'A one-time sign-in link. Open it in a browser before `expires_at`.' }),
    origin: z.string(),
    expires_at: Timestamp,
  })
  .openapi('PreviewLink');

// ---------------------------------------------------------------------------
// Pull request actions
// ---------------------------------------------------------------------------

export const CreatePullRequestBody = z
  .object({
    title: z.string().min(1).max(PR_TITLE_MAX),
    body: z.string().max(65_536).optional(),
    base: z.string().min(1).max(250).optional().openapi({ description: "Default: the session's base branch." }),
    draft: z.boolean().optional(),
    commit_message: z.string().max(65_536).optional().openapi({ description: 'For the commit of uncommitted changes. Default: the title.' }),
  })
  .strict()
  .openapi('CreatePullRequestRequest');

export const PullRequestReceipt = z
  .object({
    object: z.literal('pull_request_receipt'),
    session_id: Id,
    number: z.number().int(),
    url: z.string(),
    existing: z.boolean().openapi({ description: 'True: a pull request from this branch was already open, and the session is now linked to it.' }),
    session: Session,
  })
  .openapi('PullRequestReceipt');

export const SESSION_ACTIONS = ['fix_checks', 'resolve_conflicts', 'address_review', 'merge'] as const;

export const PromptActionBody = z
  .object({
    chat_id: Id.optional().openapi({ description: 'The chat that gets the prompt. Default: the latest chat, or a new one.' }),
  })
  .strict()
  .openapi('SessionActionRequest');

export const ActionReceipt = z
  .object({
    object: z.literal('action_receipt'),
    session_id: Id,
    action: z.enum(SESSION_ACTIONS),
    chat_id: Id.nullable().openapi({ description: 'The chat that got the prompt. Null for `merge`.' }),
  })
  .openapi('ActionReceipt');

// ---------------------------------------------------------------------------
// Threads
// ---------------------------------------------------------------------------

export const ContinueAsThreadBody = z
  .object({
    agent: z.enum(AGENTS).optional().openapi({ description: "Default: the session's agent." }),
    model: z.string().min(1).max(200).optional(),
    prompt: z.string().min(1).max(100_000).optional().openapi({ description: "Sent after the recap of the session's chat." }),
  })
  .strict()
  .openapi('ContinueAsThreadRequest');

// ---------------------------------------------------------------------------
// Timing, resize and readiness
// ---------------------------------------------------------------------------

const TimeBucket = z.object({ ms: z.number().int(), count: z.number().int() });

export const SessionTiming = z
  .object({
    object: z.literal('session_timing'),
    session_id: Id,
    turns: z.number().int(),
    wall_ms: z.number().int(),
    tool_ms: z.number().int().openapi({ description: 'Wall time covered by at least one tool call.' }),
    model_ms: z.number().int().openapi({ description: 'Wall time that no tool call covers.' }),
    calls: z.number().int(),
    categories: z.record(z.enum(TURN_TIME_CATEGORIES), TimeBucket).openapi({ description: 'Sums per category. Parallel calls can add up to more than the wall time.' }),
    slowest: z.array(
      z.object({
        category: z.enum(TURN_TIME_CATEGORIES),
        name: z.string(),
        command: z.string().nullable().openapi({ description: 'Shortened, with secrets replaced by `***`.' }),
        ms: z.number().int(),
        is_error: z.boolean(),
      }),
    ),
    recent_turns: z
      .array(
        z.object({
          chat_id: Id,
          turn: z.number().int(),
          wall_ms: z.number().int(),
          tool_ms: z.number().int(),
          model_ms: z.number().int(),
          calls: z.number().int(),
          at: Timestamp,
        }),
      )
      .openapi({ description: 'Newest first.' }),
  })
  .openapi('SessionTiming');

export const ResizeSessionBody = z
  .object({
    size: z.enum(SANDBOX_SIZES_LIST),
    reason: z.string().max(500).optional().openapi({ description: 'Why, in one sentence. The transcript shows it.' }),
    remember_for_repository: z.boolean().optional().openapi({ description: 'Also use this size for new sessions on the repository.' }),
    continue_with: z.string().min(1).max(100_000).optional().openapi({
      description: 'A message for the chat. The next turn starts on the new sandbox.',
    }),
  })
  .strict()
  .openapi('ResizeSessionRequest');

export const ResizeReceipt = z
  .object({
    object: z.literal('resize_receipt'),
    session_id: Id,
    outcome: z.enum(['unchanged', 'after_turn', 'moving']).openapi({
      description: '`moving`: the move started. `after_turn`: it starts when the running turn ends. `unchanged`: the sandbox has this size.',
    }),
    size: z.enum(SANDBOX_SIZES_LIST),
    remembered_for_repository: z.boolean(),
    continued: z.boolean().openapi({ description: 'The `continue_with` message went to a chat.' }),
  })
  .openapi('ResizeReceipt');

const ReadinessReason = z.object({ code: z.string(), message: z.string() });

export const SessionReadiness = z
  .object({
    object: z.literal('session_readiness'),
    workspace_id: Id,
    ok: z.boolean().openapi({ description: 'True when this workspace can start a sandbox session now.' }),
    reasons: z.array(ReadinessReason),
    agents: z.object({
      claude: z.object({ ok: z.boolean(), reason: ReadinessReason.nullable() }),
      codex: z.object({ ok: z.boolean(), reason: ReadinessReason.nullable() }),
    }),
  })
  .openapi('SessionReadiness');

// ---------------------------------------------------------------------------
// Chats: rename, queue, checkpoints
// ---------------------------------------------------------------------------

export const UpdateChatBody = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    agent: z.enum(['claude', 'codex']).optional().openapi({
      description: 'Stops a running turn, then continues the chat with this agent.',
    }),
    model: z.string().max(200).nullable().optional().openapi({ description: "Null: the session's model." }),
    effort: z.enum(WORKBENCH_EFFORTS as [string, ...string[]]).nullable().optional(),
    plan_mode: z.boolean().optional(),
  })
  .strict()
  .openapi('UpdateChatRequest');

export const QueuedMessage = z
  .object({
    object: z.literal('queued_message'),
    id: Id,
    chat_id: Id,
    text: z.string(),
    model: z.string().nullable(),
    effort: z.string().nullable(),
    plan_mode: z.boolean().nullable(),
    attachment_count: z.number().int(),
    origin: z.enum(['user', 'talyn']).openapi({ description: '`talyn`: Talyn wrote it, e.g. to wake a thread.' }),
    queued_at: Timestamp,
  })
  .openapi('QueuedMessage');

export const QueuedMessageList = listOf(QueuedMessage, 'QueuedMessageList');

export const QueuedMessageParams = z.object({ id: Id, message_id: Id });

export const Checkpoint = z
  .object({
    object: z.literal('checkpoint'),
    chat_id: Id,
    turn: z.number().int().openapi({ description: 'Restoring it puts the files back as they were before this turn.' }),
    sha: z.string(),
    created_at: Timestamp,
  })
  .openapi('Checkpoint');

export const CheckpointList = listOf(Checkpoint, 'CheckpointList');

export const CheckpointParams = z.object({ id: Id, turn: z.coerce.number().int().min(0) });
