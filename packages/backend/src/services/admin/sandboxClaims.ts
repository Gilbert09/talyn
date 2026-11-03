import { eq, inArray, or, sql } from 'drizzle-orm';
import type { AdminRunClaim, AdminRunKind } from '@talyn/shared';
import { getPoolDbClient } from '../../db/client.js';
import {
  prCodeReviewRuns as reviewRunsTable,
  tasks as tasksTable,
  users as usersTable,
  workbenches as workbenchesTable,
  workspaces as workspacesTable,
} from '../../db/schema.js';

/**
 * Which Talyn row claims a fleet sandbox.
 *
 * Talyn makes three kinds of sandbox id, and each points at a different table:
 *
 *   - `talyn-<task id>[-rN]` (services/selfHosted/executor.ts) is a task run.
 *   - `talyn-wb-<24 hex of the workbench id>[-rN]` (sandboxIdFor) is a session
 *     or a thread. The fleet gateway adds `--<tenant hash>` to a bare box's
 *     name, so the id a host reports is `talyn-wb-...-r5--3542ee`.
 *   - `talyn-rev-<unit id>[-r1]` (codeReview/executor.ts) is a code-review unit.
 *
 * The Runs page used to join only the first kind, so every session box read as
 * an orphan. "Orphan" is the signal that a microVM burns memory for nobody, and
 * a page that shows it on every row teaches an operator to ignore it.
 *
 * The rule here: `orphan` means NO row of any status names the sandbox. A row
 * that names it but is archived, or has moved on to a newer sandbox, makes it
 * `superseded`: a cleanup candidate with an owner, which is a different job.
 */

/** The part of a sandbox id Talyn chose. The gateway adds `--<hash>` to bare boxes. */
export function logicalSandboxId(id: string): string {
  return id.split('--')[0] ?? id;
}

/** `-rN` on the end of an id, or 0. */
export function sandboxIdGeneration(id: string): number {
  const match = /-r(\d+)$/.exec(logicalSandboxId(id));
  return match ? Number(match[1]) : 0;
}

export interface ParsedSandboxId {
  kind: 'task' | 'workbench' | 'review' | 'unknown';
  /** The row key: a task id, a 24-hex workbench prefix, or a review unit id. */
  key: string | null;
  logicalId: string;
  generation: number;
}

export function parseSandboxId(id: string): ParsedSandboxId {
  const logicalId = logicalSandboxId(id);
  const generation = sandboxIdGeneration(id);
  const base = logicalId.replace(/-r\d+$/, '');
  if (base.startsWith('talyn-wb-')) {
    const key = base.slice('talyn-wb-'.length);
    return { kind: 'workbench', key: key || null, logicalId, generation };
  }
  if (base.startsWith('talyn-rev-')) {
    const key = base.slice('talyn-rev-'.length);
    return { kind: 'review', key: key || null, logicalId, generation };
  }
  if (base.startsWith('talyn-')) {
    const key = base.slice('talyn-'.length);
    return { kind: 'task', key: key || null, logicalId, generation };
  }
  return { kind: 'unknown', key: null, logicalId, generation };
}

/** The 24 hex digits of a workbench id that its sandbox id carries. */
export function workbenchShortId(workbenchId: string): string {
  return workbenchId.replace(/-/g, '').slice(0, 24);
}

export interface TaskClaim {
  id: string;
  title: string | null;
  status: string;
  workspaceId: string;
  workspaceName: string | null;
  ownerEmail: string | null;
  remoteRunId: string | null;
  fleetHost: string | null;
  costUsd: number | null;
}

export interface WorkbenchClaim {
  id: string;
  kind: string;
  title: string | null;
  name: string;
  status: string;
  workspaceId: string;
  workspaceName: string | null;
  ownerEmail: string | null;
  repoFullName: string;
  sandboxId: string | null;
  fleetSandboxId: string | null;
  moveSandboxId: string | null;
  keptSandboxIds: string[];
  fleetHost: string | null;
  sandboxSize: string | null;
  archivedAt: Date | null;
}

export interface ReviewClaim {
  id: string;
  lens: string;
  kind: string;
  status: string;
  settled: boolean;
  workspaceId: string;
  workspaceName: string | null;
  ownerEmail: string | null;
  host: string | null;
}

export interface SandboxClaims {
  tasks: Map<string, TaskClaim>;
  /** By the 24-hex short id. More than one row can share a prefix only in theory. */
  workbenches: WorkbenchClaim[];
  reviews: Map<string, ReviewClaim>;
}

export interface SandboxClassification {
  kind: AdminRunKind;
  claim: AdminRunClaim;
  supersededReason: string | null;
  task: TaskClaim | null;
  workbench: WorkbenchClaim | null;
  review: ReviewClaim | null;
}

function orphan(kind: AdminRunKind): SandboxClassification {
  return { kind, claim: 'orphan', supersededReason: null, task: null, workbench: null, review: null };
}

/**
 * Classify one sandbox against the rows that could claim it. Pure, so every
 * rule is pinned by a test without a fleet or a database.
 */
export function classifySandbox(sandboxId: string, claims: SandboxClaims): SandboxClassification {
  const parsed = parseSandboxId(sandboxId);
  switch (parsed.kind) {
    case 'task':
      return classifyTask(parsed, claims);
    case 'workbench':
      return classifyWorkbench(sandboxId, parsed, claims);
    case 'review': {
      const review = parsed.key ? claims.reviews.get(parsed.key) : undefined;
      if (!review) return orphan('review');
      return {
        kind: 'review',
        claim: review.settled ? 'superseded' : 'active',
        supersededReason: review.settled ? 'The review unit has finished' : null,
        task: null,
        workbench: null,
        review,
      };
    }
    default:
      return orphan('unknown');
  }
}

function classifyTask(
  parsed: ParsedSandboxId,
  claims: SandboxClaims,
): SandboxClassification {
  const task = parsed.key ? claims.tasks.get(parsed.key) : undefined;
  if (!task) return orphan('task');
  const current = task.remoteRunId ?? `talyn-${task.id}`;
  const base = { kind: 'task' as const, task, workbench: null, review: null };
  if (logicalSandboxId(current) === parsed.logicalId) {
    return { ...base, claim: 'active', supersededReason: null };
  }
  if (sandboxIdGeneration(current) > parsed.generation) {
    return { ...base, claim: 'superseded', supersededReason: `The task was retried as ${current}` };
  }
  return { ...base, claim: 'superseded', supersededReason: `The task's current run is ${current}` };
}

function classifyWorkbench(
  sandboxId: string,
  parsed: ParsedSandboxId,
  claims: SandboxClaims,
): SandboxClassification {
  const rows = claims.workbenches.filter(
    (row) =>
      (parsed.key !== null && workbenchShortId(row.id) === parsed.key) ||
      (row.sandboxId !== null && logicalSandboxId(row.sandboxId) === parsed.logicalId) ||
      row.fleetSandboxId === sandboxId,
  );
  if (rows.length === 0) return orphan('session');

  const kindOf = (row: WorkbenchClaim): AdminRunKind => (row.kind === 'thread' ? 'thread' : 'session');
  const result = (
    row: WorkbenchClaim,
    claim: AdminRunClaim,
    supersededReason: string | null,
  ): SandboxClassification => ({
    kind: kindOf(row),
    claim,
    supersededReason,
    task: null,
    workbench: row,
    review: null,
  });

  const current = rows.find(
    (row) =>
      !row.archivedAt &&
      ((row.sandboxId !== null && logicalSandboxId(row.sandboxId) === parsed.logicalId) ||
        row.fleetSandboxId === sandboxId ||
        (row.status === 'moving' &&
          row.moveSandboxId !== null &&
          logicalSandboxId(row.moveSandboxId) === parsed.logicalId)),
  );
  if (current) return result(current, 'active', null);

  const kept = rows.find((row) =>
    row.keptSandboxIds.some((id) => id === sandboxId || logicalSandboxId(id) === parsed.logicalId),
  );
  if (kept) {
    return result(kept, 'superseded', 'Kept because its hibernated copy could not be restored');
  }

  const owner = rows[0]!;
  if (owner.archivedAt) {
    return result(owner, 'superseded', `The ${kindOf(owner)} is archived`);
  }
  if (owner.sandboxId && sandboxIdGeneration(owner.sandboxId) > parsed.generation) {
    return result(owner, 'superseded', `The ${kindOf(owner)} moved to ${logicalSandboxId(owner.sandboxId)}`);
  }
  return result(owner, 'superseded', `Not the ${kindOf(owner)}'s current sandbox (a move that did not finish)`);
}

// ============================================================================
// Loading the rows
// ============================================================================

/** Only the columns the classification and the row need. `settings` stays in Postgres. */
export const WORKBENCH_CLAIM_COLUMNS = {
  id: workbenchesTable.id,
  kind: workbenchesTable.kind,
  title: workbenchesTable.title,
  name: workbenchesTable.name,
  status: workbenchesTable.status,
  workspaceId: workbenchesTable.workspaceId,
  repoFullName: workbenchesTable.repoFullName,
  sandboxId: workbenchesTable.sandboxId,
  fleetHost: workbenchesTable.fleetHost,
  archivedAt: workbenchesTable.archivedAt,
  fleetSandboxId: sql<string | null>`${workbenchesTable.settings} ->> 'fleetSandboxId'`.as('fleet_sandbox_id'),
  moveSandboxId: sql<string | null>`${workbenchesTable.settings} ->> 'moveSandboxId'`.as('move_sandbox_id'),
  keptSandboxIds: sql<unknown>`${workbenchesTable.settings} -> 'keptSandboxIds'`.as('kept_sandbox_ids'),
  sandboxSize: sql<string | null>`${workbenchesTable.settings} ->> 'sandboxSize'`.as('sandbox_size'),
  workspaceName: workspacesTable.name,
  ownerEmail: usersTable.email,
} as const;

export const TASK_CLAIM_COLUMNS = {
  id: tasksTable.id,
  title: tasksTable.title,
  status: tasksTable.status,
  workspaceId: tasksTable.workspaceId,
  remoteRunId: sql<string | null>`${tasksTable.metadata} -> 'cloudTask' ->> 'remoteRunId'`.as('remote_run_id'),
  fleetHost: sql<string | null>`${tasksTable.metadata} -> 'cloudTask' -> 'extra' ->> 'host'`.as('fleet_host'),
  costUsd: sql<number | null>`(${tasksTable.metadata} -> 'cloudTask' -> 'extra' ->> 'costUsd')::double precision`.as(
    'cost_usd',
  ),
  workspaceName: workspacesTable.name,
  ownerEmail: usersTable.email,
} as const;

export const REVIEW_CLAIM_COLUMNS = {
  id: reviewRunsTable.id,
  lens: reviewRunsTable.lens,
  kind: reviewRunsTable.kind,
  status: reviewRunsTable.status,
  settledAt: reviewRunsTable.settledAt,
  host: reviewRunsTable.host,
  workspaceId: reviewRunsTable.workspaceId,
  workspaceName: workspacesTable.name,
  ownerEmail: usersTable.email,
} as const;

/** The workbench lookup, exported so the egress test can render it without a database. */
export function workbenchClaimQuery(shorts: string[], logicalIds: string[]) {
  return getPoolDbClient()
    .select(WORKBENCH_CLAIM_COLUMNS)
    .from(workbenchesTable)
    .innerJoin(workspacesTable, eq(workbenchesTable.workspaceId, workspacesTable.id))
    .innerJoin(usersTable, eq(workspacesTable.ownerId, usersTable.id))
    .where(
      or(
        inArray(sql`left(replace(${workbenchesTable.id}, '-', ''), 24)`, shorts.length ? shorts : ['']),
        inArray(sql`split_part(${workbenchesTable.sandboxId}, '--', 1)`, logicalIds.length ? logicalIds : ['']),
      ),
    );
}

/**
 * Every Talyn row that could claim one of these sandboxes, in three queries
 * whatever the number of sandboxes. A table scan of `workbenches` for the
 * prefix match: the table is small, and the id carries only 24 of the uuid's
 * 32 hex digits, so there is no exact key to index on.
 */
export async function loadSandboxClaims(sandboxIds: string[]): Promise<SandboxClaims> {
  const parsed = sandboxIds.map(parseSandboxId);
  const taskIds = [...new Set(parsed.filter((p) => p.kind === 'task' && p.key).map((p) => p.key!))];
  const shorts = [...new Set(parsed.filter((p) => p.kind === 'workbench' && p.key).map((p) => p.key!))];
  const wbLogical = [...new Set(parsed.filter((p) => p.kind === 'workbench').map((p) => p.logicalId))];
  const reviewIds = [...new Set(parsed.filter((p) => p.kind === 'review' && p.key).map((p) => p.key!))];
  const db = getPoolDbClient();

  const [taskRows, workbenchRows, reviewRows] = await Promise.all([
    taskIds.length
      ? db
          .select(TASK_CLAIM_COLUMNS)
          .from(tasksTable)
          .innerJoin(workspacesTable, eq(tasksTable.workspaceId, workspacesTable.id))
          .innerJoin(usersTable, eq(workspacesTable.ownerId, usersTable.id))
          .where(inArray(tasksTable.id, taskIds))
      : Promise.resolve([]),
    shorts.length || wbLogical.length ? workbenchClaimQuery(shorts, wbLogical) : Promise.resolve([]),
    reviewIds.length
      ? db
          .select(REVIEW_CLAIM_COLUMNS)
          .from(reviewRunsTable)
          .innerJoin(workspacesTable, eq(reviewRunsTable.workspaceId, workspacesTable.id))
          .innerJoin(usersTable, eq(workspacesTable.ownerId, usersTable.id))
          .where(inArray(reviewRunsTable.id, reviewIds))
      : Promise.resolve([]),
  ]);

  return {
    tasks: new Map(
      taskRows.map((row) => [
        row.id,
        {
          id: row.id,
          title: row.title ?? null,
          status: row.status,
          workspaceId: row.workspaceId,
          workspaceName: row.workspaceName ?? null,
          ownerEmail: row.ownerEmail ?? null,
          remoteRunId: row.remoteRunId ?? null,
          fleetHost: row.fleetHost ?? null,
          costUsd: row.costUsd == null ? null : Number(row.costUsd),
        },
      ]),
    ),
    workbenches: workbenchRows.map((row) => ({
      id: row.id,
      kind: row.kind,
      title: row.title ?? null,
      name: row.name,
      status: row.status,
      workspaceId: row.workspaceId,
      workspaceName: row.workspaceName ?? null,
      ownerEmail: row.ownerEmail ?? null,
      repoFullName: row.repoFullName,
      sandboxId: row.sandboxId ?? null,
      fleetSandboxId: row.fleetSandboxId ?? null,
      moveSandboxId: row.moveSandboxId ?? null,
      keptSandboxIds: stringArray(row.keptSandboxIds),
      fleetHost: row.fleetHost ?? null,
      sandboxSize: row.sandboxSize ?? null,
      archivedAt: row.archivedAt ?? null,
    })),
    reviews: new Map(
      reviewRows.map((row) => [
        row.id,
        {
          id: row.id,
          lens: row.lens,
          kind: row.kind,
          status: row.status,
          settled: row.settledAt != null,
          workspaceId: row.workspaceId,
          workspaceName: row.workspaceName ?? null,
          ownerEmail: row.ownerEmail ?? null,
          host: row.host ?? null,
        },
      ]),
    ),
  };
}

/** A jsonb array of strings, as postgres-js or pglite hands it back. */
function stringArray(raw: unknown): string[] {
  const value = typeof raw === 'string' ? safeParse(raw) : raw;
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
