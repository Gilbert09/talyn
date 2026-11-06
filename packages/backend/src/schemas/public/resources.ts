import { API_SCOPES, WORKBENCH_EFFORTS } from '@talyn/shared';
import { Id, listOf, PageQuery, QueryBoolean, Timestamp } from './common.js';
import { z } from './zod.js';

/**
 * Request and response schemas of `/v1`. Requests are parsed with these
 * schemas, and the OpenAPI spec is generated from them, so the docs and the
 * validation cannot disagree.
 *
 * Every request object is `.strict()`: an unknown field is a 400 that names
 * it. A typo (`workspaceId` for `workspace_id`) must not be dropped quietly.
 */

// ---------------------------------------------------------------------------
// Me
// ---------------------------------------------------------------------------

export const Me = z
  .object({
    object: z.literal('token'),
    token: z.object({
      id: Id,
      name: z.string(),
      scopes: z.array(z.enum(API_SCOPES)),
      workspace_ids: z.array(Id).nullable().openapi({ description: 'The workspaces this token can reach. Null: all of them.' }),
      expires_at: Timestamp.nullable(),
    }),
    user: z.object({ id: Id, email: z.string() }),
  })
  .openapi('Me');

// ---------------------------------------------------------------------------
// Workspaces and repositories
// ---------------------------------------------------------------------------

export const Workspace = z
  .object({
    object: z.literal('workspace'),
    id: Id,
    name: z.string(),
    created_at: Timestamp,
    updated_at: Timestamp,
  })
  .openapi('Workspace');

export const WorkspaceList = listOf(Workspace, 'WorkspaceList');

export const Repository = z
  .object({
    object: z.literal('repository'),
    id: Id,
    workspace_id: Id,
    full_name: z.string().openapi({ example: 'acme/app' }),
    url: z.string(),
    default_branch: z.string(),
    created_at: Timestamp,
  })
  .openapi('Repository');

export const RepositoryList = listOf(Repository, 'RepositoryList');

export const Team = z.object({
  object: z.literal('team'), id: Id, name: z.string(), my_role: z.enum(['owner', 'admin', 'member']), created_at: Timestamp,
}).openapi('Team');
export const TeamList = listOf(Team, 'TeamList');
export const Space = z.object({
  object: z.literal('space'), id: Id, team_id: Id, name: z.string(), color: z.string().nullable(), created_at: Timestamp,
}).openapi('Space');
export const SpaceList = listOf(Space, 'SpaceList');
export const ListSpacesQuery = z.object({ team_id: Id.optional(), ...PageQuery }).strict();
export const ListSpaceSessionsQuery = z.object(PageQuery).strict();

export const ListWorkspacesQuery = z.object(PageQuery).strict();

export const ListRepositoriesQuery = z
  .object({
    workspace_id: Id.optional().openapi({
      description: 'Required unless the token is bound to exactly one workspace.',
    }),
    ...PageQuery,
  })
  .strict();

export const IdParams = z.object({ id: Id });

// ---------------------------------------------------------------------------
// Sessions and chats
// ---------------------------------------------------------------------------

export const SESSION_STATUSES = ['provisioning', 'ready', 'moving', 'error', 'archived', 'archive_error'] as const;
export const SESSION_KINDS = ['session', 'thread'] as const;
export const CHAT_STATUSES = ['idle', 'running', 'awaiting_input', 'error'] as const;
export const AGENTS = ['claude', 'codex'] as const;

export const Chat = z
  .object({
    object: z.literal('chat'),
    id: Id,
    session_id: Id,
    title: z.string(),
    agent: z.enum(AGENTS),
    model: z.string().nullable(),
    effort: z.enum(WORKBENCH_EFFORTS as [string, ...string[]]).nullable(),
    plan_mode: z.boolean(),
    status: z.enum(CHAT_STATUSES),
    resume_at: Timestamp.nullable(),
    status_message: z.string().nullable(),
    turn_count: z.number().int(),
    queued_message_count: z.number().int().openapi({ description: 'Messages waiting for the running turn to end.' }),
    closed_at: Timestamp.nullable(),
    created_at: Timestamp,
    updated_at: Timestamp,
  })
  .openapi('Chat');

export const Session = z
  .object({
    object: z.literal('session'),
    id: Id,
    workspace_id: Id,
    kind: z.enum(SESSION_KINDS),
    space_id: Id.nullable(),
    thread_id: Id.nullable().openapi({ description: 'The thread this session belongs to, if any.' }),
    repository_id: Id.nullable().openapi({ description: 'Null for a thread.' }),
    repository_full_name: z.string().nullable(),
    name: z.string(),
    title: z.string().nullable(),
    branch: z.string().nullable().openapi({ description: 'Null for a thread.' }),
    base_branch: z.string().nullable(),
    runtime: z.enum(['sandbox', 'local']).openapi({
      description: 'A `local` session runs in the desktop app. The API lists it read-only; actions on it answer 409 `local_runtime`.',
    }),
    agent: z.enum(AGENTS),
    model: z.string().nullable(),
    status: z.enum(SESSION_STATUSES),
    status_message: z.string().nullable(),
    pull_request_id: Id.nullable(),
    internet_access: z.boolean().nullable().openapi({ description: 'Null: the workspace default.' }),
    auto_create_pr: z.boolean().nullable().openapi({ description: 'Null: the workspace default.' }),
    diff_stat: z
      .object({ added: z.number().int(), removed: z.number().int(), files: z.number().int() })
      .nullable()
      .openapi({ description: 'Null until a diff has been computed once.' }),
    archived_at: Timestamp.nullable(),
    created_at: Timestamp,
    updated_at: Timestamp,
    chats: z.array(Chat).optional().openapi({ description: 'The open chats, oldest first. On single-session responses only.' }),
  })
  .openapi('Session');

export const SessionList = listOf(Session, 'SessionList');
export const SpaceSession = Session.extend({
  space_id: Id,
  creator_github_login: z.string().nullable(),
}).omit({ chats: true }).openapi('SpaceSession');
export const SpaceSessionList = listOf(SpaceSession, 'SpaceSessionList').extend({ hidden_count: z.number().int() }).openapi('SpaceSessionList');

const commaList = <T extends readonly [string, ...string[]]>(values: T, what: string) =>
  z
    .string()
    .transform((raw, ctx) => {
      const items = [...new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))];
      const bad = items.filter((i) => !(values as readonly string[]).includes(i));
      if (items.length === 0 || bad.length > 0) {
        ctx.addIssue({ code: 'custom', message: `must be a comma-separated list of: ${values.join(', ')}` });
        return z.NEVER;
      }
      return items as T[number][];
    })
    .openapi({ type: 'string', description: `Comma-separated ${what}: ${values.join(', ')}.` });

export const ListSessionsQuery = z
  .object({
    workspace_id: Id.optional().openapi({
      description: 'Required unless the token is bound to exactly one workspace.',
    }),
    status: commaList(SESSION_STATUSES, 'statuses').optional(),
    kind: commaList(SESSION_KINDS, 'kinds').optional().openapi({ description: 'Comma-separated kinds. Default `session`.' }),
    include_archived: QueryBoolean.optional().openapi({
      description: 'Include archived sessions. Default false; asking for status `archived` turns it on.',
    }),
    ...PageQuery,
  })
  .strict();

export const CreateSessionBody = z
  .object({
    workspace_id: Id.optional().openapi({ description: 'Required unless space_id is set or the token is bound to one workspace.' }),
    space_id: Id.optional().openapi({ description: 'Start in this space. Requires spaces:write and uses your home workspace.' }),
    repository_full_name: z.string().min(3).max(200).optional().openapi({ description: 'Repository owner/name in the space. Use when no repository_id exists in your workspaces.' }),
    kind: z.enum(SESSION_KINDS).optional().openapi({ description: 'Default `session`. A thread takes no repository or branch.' }),
    repository_id: Id.optional().openapi({ description: 'Required for a session unless space_id and repository_full_name are set.' }),
    agent: z.enum(AGENTS),
    model: z.string().min(1).max(200).optional(),
    prompt: z.string().min(1).max(100_000).optional().openapi({ description: 'The first message. The agent starts on it when the sandbox is ready.' }),
    name: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{0,62}$/)
      .optional()
      .openapi({ description: 'Lowercase letters, digits and hyphens. Default: made from the prompt.' }),
    base_branch: z.string().min(1).max(250).optional(),
    branch: z.string().min(1).max(250).optional().openapi({ description: 'An existing branch to work on. Default: a new branch.' }),
    pull_request_id: Id.optional().openapi({ description: "Start from this pull request's head branch and link the session to it." }),
    thread_id: Id.optional().openapi({ description: 'Put the new session in this thread.' }),
    internet_access: z.boolean().optional(),
    auto_create_pr: z.boolean().optional(),
  })
  .strict()
  .openapi('CreateSessionRequest');

export const CreateChatBody = z
  .object({
    title: z.string().min(1).max(200).optional(),
    model: z.string().min(1).max(200).optional(),
    effort: z.enum(WORKBENCH_EFFORTS as [string, ...string[]]).optional(),
    plan_mode: z.boolean().optional(),
  })
  .strict()
  .openapi('CreateChatRequest');

export const SendMessageBody = z
  .object({
    text: z.string().min(1).max(100_000),
    model: z.string().min(1).max(200).optional().openapi({ description: 'For this turn only.' }),
    effort: z.enum(WORKBENCH_EFFORTS as [string, ...string[]]).optional().openapi({ description: 'For this turn only.' }),
    plan_mode: z.boolean().optional(),
  })
  .strict()
  .openapi('SendMessageRequest');

export const MessageReceipt = z
  .object({
    object: z.literal('message_receipt'),
    chat_id: Id,
    queued: z.boolean().openapi({
      description: 'True: the message waits behind a running turn or for the sandbox. False: the turn started now.',
    }),
  })
  .openapi('MessageReceipt');

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export const DEFAULT_EVENT_PAGE = 500;
export const MAX_EVENT_PAGE = 2000;

export const Event = z
  .object({
    object: z.literal('event'),
    chat_id: Id,
    seq: z.number().int().openapi({ description: 'Position in the chat. Gap-free and increasing.' }),
    turn: z.number().int(),
    type: z.string().openapi({ example: 'assistant' }),
    data: z.record(z.unknown()).openapi({
      description:
        "The agent event, in Claude Code's stream-json format. Codex output is converted to the same format. New fields can appear.",
    }),
  })
  .openapi('Event');

export const EventPage = z
  .object({
    object: z.literal('list'),
    data: z.array(Event),
    has_more: z.boolean().openapi({ description: 'More events exist in the direction you paged.' }),
    first_seq: z.number().int().nullable(),
    last_seq: z.number().int().nullable().openapi({ description: 'Pass as `after` for the next page forward.' }),
  })
  .openapi('EventPage');

export const ListEventsQuery = z
  .object({
    after: z.coerce.number().int().min(0).optional().openapi({ description: 'Events with a greater `seq`, oldest first. Default 0.' }),
    before: z
      .union([z.literal('latest'), z.coerce.number().int().min(1)])
      .optional()
      .openapi({
        type: 'string',
        description: '`latest` for the newest page, or a `seq` for the page before it. Returned oldest first, whole turns only.',
      }),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(MAX_EVENT_PAGE)
      .default(DEFAULT_EVENT_PAGE)
      .openapi({ description: `Events per page, 1 to ${MAX_EVENT_PAGE}. Default ${DEFAULT_EVENT_PAGE}.` }),
  })
  .strict();

export const StreamEventsQuery = z
  .object({
    after: z.coerce.number().int().min(0).optional().openapi({
      description: 'Start after this `seq`. The `Last-Event-ID` header wins when both are sent.',
    }),
  })
  .strict();

export const EmptyQuery = z.object({}).strict();
