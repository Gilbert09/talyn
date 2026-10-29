import { eq, sql } from 'drizzle-orm';
import { normaliseBranchPrefix } from '@talyn/shared';
import { getPoolDbClient } from '../../db/client.js';
import { workbenches, workspaces } from '../../db/schema.js';
import { githubService } from '../github.js';

/** Archived sessions still own their branch names. */
export async function allocateWorkbenchBranch(workspaceId: string, repoFullName: string, base: string): Promise<string> {
  const rows = await getPoolDbClient().select({ branch: workbenches.branch }).from(workbenches)
    .where(eq(workbenches.workspaceId, workspaceId));
  const taken = new Set(rows.map((row) => row.branch));
  const [owner, repo] = repoFullName.split('/');
  const match = /^(.*)-(\d+)$/.exec(base);
  const stem = match ? match[1] : base;
  const start = match ? BigInt(match[2]) : 1n;
  for (let suffix = start; ; suffix++) {
    const candidate = suffix === start ? base : `${stem}-${suffix}`;
    if (!taken.has(candidate) && !await githubService.branchExists(workspaceId, owner, repo, candidate)) return candidate;
  }
}

/** The workspace's prefix for a branch Talyn names, e.g. `tom/`. Empty when unset or no longer valid. */
export async function sessionBranchPrefix(workspaceId: string): Promise<string> {
  const stored = (
    await getPoolDbClient()
      .select({ prefix: sql<string | null>`${workspaces.settings} ->> 'sessionBranchPrefix'` })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1)
  )[0]?.prefix;
  const checked = normaliseBranchPrefix(stored ?? '');
  return checked.ok ? checked.value : '';
}

/** The constraint a unique violation (23505) names, through the driver's `cause` wrapping. */
export function uniqueViolationConstraint(err: unknown): string | undefined {
  let cause: unknown = err;
  let constraint: string | undefined;
  while (cause && typeof cause === 'object') {
    const detail = cause as { code?: string; constraint?: string; constraint_name?: string; cause?: unknown };
    if (detail.code === '23505') constraint = detail.constraint ?? detail.constraint_name;
    cause = detail.cause;
  }
  return constraint;
}
