import type {
  WorkbenchInstructionCandidate,
  WorkbenchInstructionFile,
  WorkbenchLocalBridge,
} from '@talyn/shared';
import { api } from './api';

/**
 * "Your instructions": the files on this Mac, merged with what the workspace
 * has stored, and the quiet re-upload of switched-on files that changed here.
 */

export type InstructionStatus = 'off' | 'synced' | 'changed' | 'missing';

export interface InstructionRow {
  key: string;
  local: WorkbenchInstructionCandidate | null;
  stored: WorkbenchInstructionFile | null;
  enabled: boolean;
  status: InstructionStatus;
}

export function instructionStatus(
  local: WorkbenchInstructionCandidate | null,
  stored: WorkbenchInstructionFile | null,
): InstructionStatus {
  if (!local) return 'missing';
  if (!stored?.enabled) return 'off';
  return stored.contentHash === local.hash ? 'synced' : 'changed';
}

/** One row per local file, then one per stored file that is not on this Mac. */
export function mergeInstructionRows(
  local: WorkbenchInstructionCandidate[],
  stored: WorkbenchInstructionFile[],
): InstructionRow[] {
  const byKey = new Map(stored.map((s) => [s.key, s]));
  const rows: InstructionRow[] = local.map((l) => {
    const s = byKey.get(l.key) ?? null;
    return { key: l.key, local: l, stored: s, enabled: Boolean(s?.enabled), status: instructionStatus(l, s) };
  });
  const seen = new Set(local.map((l) => l.key));
  for (const s of stored) {
    if (!seen.has(s.key)) rows.push({ key: s.key, local: null, stored: s, enabled: s.enabled, status: 'missing' });
  }
  return rows;
}

export function uploadInstructionFile(
  workspaceId: string,
  local: WorkbenchInstructionCandidate,
  enabled: boolean,
): Promise<WorkbenchInstructionFile> {
  return api.workbenches.instructions.put({
    workspaceId,
    file: {
      key: local.key,
      agent: local.agent,
      target: local.target,
      repoFullName: local.repoFullName ?? null,
      sourcePath: local.displayPath,
      ...(enabled ? { content: local.content } : {}),
      enabled,
    },
  });
}

/** Upload every switched-on file whose content changed on this Mac. Returns the stored list afterwards. */
export async function uploadChangedInstructionFiles(
  workspaceId: string,
  local: WorkbenchInstructionCandidate[],
  stored: WorkbenchInstructionFile[],
): Promise<{ stored: WorkbenchInstructionFile[]; failed: number }> {
  const byKey = new Map(local.map((l) => [l.key, l]));
  let failed = 0;
  const next = await Promise.all(
    stored.map(async (s) => {
      const l = byKey.get(s.key);
      if (!s.enabled || !l || l.hash === s.contentHash) return s;
      try {
        return await uploadInstructionFile(workspaceId, l, true);
      } catch {
        failed++;
        return s;
      }
    }),
  );
  return { stored: next, failed };
}

/** Read this Mac's files and the stored list, then upload what changed. */
export async function syncChangedInstructionFiles(
  workspaceId: string,
  bridge: Pick<WorkbenchLocalBridge, 'instructionFiles'>,
): Promise<{ local: WorkbenchInstructionCandidate[]; stored: WorkbenchInstructionFile[]; failed: number }> {
  if (!bridge.instructionFiles) return { local: [], stored: [], failed: 0 };
  const [local, stored] = await Promise.all([
    bridge.instructionFiles(),
    api.workbenches.instructions.list(workspaceId),
  ]);
  return { local, ...(await uploadChangedInstructionFiles(workspaceId, local, stored)) };
}
