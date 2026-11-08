import { useEffect, useRef, useState } from 'react';
import type { WorkbenchOps } from '../../lib/workbenchOps';
import { slashCommandFileDescription } from '../../lib/workbenchFormat';

/** A repository rarely has more; past this, the rest show without a description. */
const MAX_FILES = 50;

/**
 * Descriptions of the repository's `.claude` command and skill files, by
 * command name. Each file is read one time per session, when the `/` list
 * first opens.
 */
export function useSlashCommandFileDescriptions(
  ops: WorkbenchOps,
  workbenchId: string,
  files: Record<string, string>,
  enabled: boolean,
): Record<string, string> {
  const [descriptions, setDescriptions] = useState<Record<string, string>>({});
  const requested = useRef(new Set<string>());
  const current = useRef(workbenchId);
  current.current = workbenchId;

  useEffect(() => {
    requested.current = new Set();
    setDescriptions({});
  }, [workbenchId]);

  useEffect(() => {
    if (!enabled || ops.unavailable) return;
    for (const [name, path] of Object.entries(files).slice(0, MAX_FILES)) {
      if (requested.current.has(path)) continue;
      requested.current.add(path);
      ops
        .readFile(path)
        .then((file) => {
          const description = file.binary ? null : slashCommandFileDescription(file.content);
          if (description && current.current === workbenchId) {
            setDescriptions((prev) => ({ ...prev, [name]: description }));
          }
        })
        .catch(() => {});
    }
  }, [enabled, files, ops, workbenchId]);

  return descriptions;
}
