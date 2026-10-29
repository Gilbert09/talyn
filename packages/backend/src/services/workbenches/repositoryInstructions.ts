import { v4 as uuid } from 'uuid';
import { and, asc, eq, ne } from 'drizzle-orm';
import {
  MAX_REPOSITORY_INSTRUCTION_BYTES,
  REPOSITORY_INSTRUCTION_AGENTS,
  repositoryInstructionsTooLargeMessage,
  type PutRepositoryInstructionsInput,
  type RepositoryInstructionAgents,
  type RepositoryInstructions,
  type RepositoryInstructionsSummary,
} from '@talyn/shared';
import { getPoolDbClient, type Database } from '../../db/client.js';
import { repositories, repositoryInstructions as table } from '../../db/schema.js';
import { WorkbenchError } from './errors.js';

/**
 * Instructions a person writes in Talyn for one repository. On the pool: the
 * routes authorise with `requireRepositoryAccess` first, and the turn path has
 * no request. See `instructions.ts` for how they reach the box.
 */

const db = (): Database => getPoolDbClient();

/** Every column but `body`. The list never ships the text. */
export const SUMMARY_COLUMNS = {
  repositoryId: table.repositoryId,
  agents: table.agents,
  bytes: table.bytes,
  updatedAt: table.updatedAt,
} as const;

/** The two columns the turn path reads. */
export const TURN_COLUMNS = { body: table.body, agents: table.agents } as const;

type SummaryRow = Pick<typeof table.$inferSelect, keyof typeof SUMMARY_COLUMNS>;

function toSummary(row: SummaryRow): RepositoryInstructionsSummary {
  return {
    repositoryId: row.repositoryId,
    agents: row.agents as RepositoryInstructionAgents,
    bytes: row.bytes,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function validateRepositoryInstructions(input: Partial<PutRepositoryInstructionsInput> | undefined): {
  body: string;
  agents: RepositoryInstructionAgents;
  bytes: number;
} {
  if (!input || typeof input !== 'object') throw new WorkbenchError('body is required', 400, 'bad_repository_instructions');
  if (typeof input.body !== 'string') throw new WorkbenchError('body must be a string', 400, 'bad_repository_instructions');
  if (!REPOSITORY_INSTRUCTION_AGENTS.includes(input.agents as RepositoryInstructionAgents)) {
    throw new WorkbenchError('agents must be "claude", "codex" or "both"', 400, 'bad_repository_instructions');
  }
  if (!input.body.trim()) {
    throw new WorkbenchError('Write some instructions, or delete them.', 400, 'bad_repository_instructions');
  }
  const bytes = Buffer.byteLength(input.body, 'utf8');
  if (bytes > MAX_REPOSITORY_INSTRUCTION_BYTES) {
    throw new WorkbenchError(repositoryInstructionsTooLargeMessage(bytes), 413, 'repository_instructions_too_large');
  }
  return { body: input.body, agents: input.agents as RepositoryInstructionAgents, bytes };
}

/** The repositories of the workspace that have instructions. No text. */
export async function listRepositoryInstructions(workspaceId: string): Promise<RepositoryInstructionsSummary[]> {
  const rows = await db()
    .select(SUMMARY_COLUMNS)
    .from(table)
    .where(and(eq(table.workspaceId, workspaceId), ne(table.bytes, 0)))
    .orderBy(asc(table.repositoryId));
  return rows.map(toSummary);
}

export async function getRepositoryInstructions(repositoryId: string): Promise<RepositoryInstructions | null> {
  const [row] = await db()
    .select({ ...SUMMARY_COLUMNS, body: table.body })
    .from(table)
    .where(eq(table.repositoryId, repositoryId))
    .limit(1);
  if (!row || row.bytes === 0) return null;
  return { ...toSummary(row), body: row.body };
}

export async function putRepositoryInstructions(
  repositoryId: string,
  input: Partial<PutRepositoryInstructionsInput> | undefined,
): Promise<RepositoryInstructions> {
  const value = validateRepositoryInstructions(input);
  const [repo] = await db()
    .select({ workspaceId: repositories.workspaceId })
    .from(repositories)
    .where(eq(repositories.id, repositoryId))
    .limit(1);
  if (!repo) throw new WorkbenchError('Repository not found', 404, 'repository_not_found');
  const values = { ...value, updatedAt: new Date() };
  const [row] = await db()
    .insert(table)
    .values({ id: uuid(), workspaceId: repo.workspaceId, repositoryId, ...values })
    .onConflictDoUpdate({ target: table.repositoryId, set: values })
    .returning({ ...SUMMARY_COLUMNS });
  return { ...toSummary(row), body: value.body };
}

/** Empties the row rather than deleting it: the next turn takes the files out of the box. */
export async function removeRepositoryInstructions(repositoryId: string): Promise<boolean> {
  const rows = await db()
    .update(table)
    .set({ body: '', bytes: 0, updatedAt: new Date() })
    .where(and(eq(table.repositoryId, repositoryId), ne(table.bytes, 0)))
    .returning({ id: table.id });
  return rows.length > 0;
}

/**
 * What a turn needs: the text when it applies to `agent`, and whether the
 * repository ever had a row (so a removed or retargeted one is cleaned up).
 * Only the two columns the turn uses.
 */
export async function repositoryInstructionsForTurn(
  repositoryId: string,
  agent: 'claude' | 'codex',
): Promise<{ hasRow: boolean; body: string | null }> {
  const [row] = await db()
    .select(TURN_COLUMNS)
    .from(table)
    .where(eq(table.repositoryId, repositoryId))
    .limit(1);
  if (!row) return { hasRow: false, body: null };
  const applies = row.body.trim() !== '' && (row.agents === 'both' || row.agents === agent);
  return { hasRow: true, body: applies ? row.body : null };
}
