import { eq } from 'drizzle-orm';
import { getPoolDbClient } from '../../db/client.js';
import { workbenches } from '../../db/schema.js';
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
