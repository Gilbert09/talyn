import {
  MAX_MEMORY_BODY_BYTES,
  MAX_MEMORY_DESCRIPTION_CHARS,
  MAX_MEMORY_NAME_CHARS,
  MEMORY_SCOPES,
  MEMORY_TYPES,
} from '@talyn/shared';
import { Id, listOf, PageQuery, QueryBoolean, Timestamp } from './common.js';
import { z } from './zod.js';

/**
 * Workspace memory: short notes that sessions and people save, so a later
 * session knows what an earlier one learned. The limits are the app's
 * (`workbenchMemory.ts` in `@talyn/shared`); the service checks them again.
 */

const Scope = z.enum(MEMORY_SCOPES as [string, ...string[]]);
const Type = z.enum(MEMORY_TYPES as [string, ...string[]]);

export const Memory = z
  .object({
    object: z.literal('memory'),
    id: Id,
    workspace_id: Id,
    scope: Scope.openapi({ description: '`workspace`: every session. `repository`: sessions on one repository. `thread`: one thread.' }),
    repository_id: Id.nullable(),
    thread_id: Id.nullable(),
    type: Type,
    name: z.string(),
    description: z.string().openapi({ description: 'One line. Sessions see the name and the description in their memory index.' }),
    body: z.string().optional().openapi({ description: 'The note. On single-entry responses, and on lists with `include_body=true`.' }),
    bytes: z.number().int(),
    source: z.object({
      kind: z.enum(['user', 'session', 'auto']),
      session_id: Id.nullable().openapi({ description: 'The session that wrote the entry, for `kind: "session"`.' }),
    }),
    forgotten_at: Timestamp.nullable().openapi({ description: 'Set when the entry was forgotten. Restore it to use it again.' }),
    created_at: Timestamp,
    updated_at: Timestamp,
  })
  .openapi('Memory');

export const MemoryList = listOf(Memory, 'MemoryList');

export const ListMemoriesQuery = z
  .object({
    workspace_id: Id.optional().openapi({ description: 'Required unless the token is bound to exactly one workspace.' }),
    scope: Scope.optional(),
    repository_id: Id.optional().openapi({
      description: 'With `scope`, that repository only. Without it, the entries a session on this repository sees.',
    }),
    thread_id: Id.optional(),
    q: z.string().min(1).max(200).optional().openapi({ description: 'Matches the name, the description or the body.' }),
    include_forgotten: QueryBoolean.optional(),
    include_body: QueryBoolean.optional(),
    ...PageQuery,
  })
  .strict();

const Name = z.string().min(1).max(MAX_MEMORY_NAME_CHARS);
const Description = z.string().min(1).max(MAX_MEMORY_DESCRIPTION_CHARS);
const Body = z.string().min(1).openapi({ description: `At most ${MAX_MEMORY_BODY_BYTES} bytes of UTF-8.` });

export const CreateMemoryBody = z
  .object({
    workspace_id: Id.optional().openapi({ description: 'Required unless the token is bound to exactly one workspace.' }),
    scope: Scope,
    repository_id: Id.optional().openapi({ description: 'Required for `scope: "repository"`.' }),
    thread_id: Id.optional().openapi({ description: 'Required for `scope: "thread"`.' }),
    type: Type,
    name: Name,
    description: Description,
    body: Body,
  })
  .strict()
  .openapi('CreateMemoryRequest');

export const UpdateMemoryBody = z
  .object({
    type: Type.optional(),
    name: Name.optional(),
    description: Description.optional(),
    body: Body.optional(),
  })
  .strict()
  .openapi('UpdateMemoryRequest');
