const KEY_PREFIX = 'talyn-new-workbench-repo:';

/** The repository last used for a new workbench in this Talyn workspace, on this machine. */
export function readLastRepository(workspaceId: string | null): string | null {
  if (!workspaceId) return null;
  try {
    return localStorage.getItem(KEY_PREFIX + workspaceId);
  } catch {
    return null;
  }
}

export function writeLastRepository(workspaceId: string | null, repositoryId: string): void {
  if (!workspaceId) return;
  try {
    localStorage.setItem(KEY_PREFIX + workspaceId, repositoryId);
  } catch {
    // Private mode or a full disk: the default is only a convenience.
  }
}

/** The stored repository when it is still watched, else the first watched one. */
export function defaultRepositoryId(
  workspaceId: string | null,
  repositories: ReadonlyArray<{ id: string }>
): string {
  const last = readLastRepository(workspaceId);
  if (last && repositories.some((r) => r.id === last)) return last;
  return repositories[0]?.id ?? '';
}
