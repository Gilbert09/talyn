/** `owner/name` from an https or ssh GitHub remote URL, or null. */
export function repoFullNameFromRemote(remoteUrl: string): string | null {
  const match = remoteUrl
    .trim()
    .match(
      /^(?:https?:\/\/(?:[^@/]+@)?|ssh:\/\/(?:[^@/]+@)?|git@)github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i,
    );
  return match ? `${match[1]}/${match[2]}` : null;
}

export interface GitRemote {
  name: string;
  url: string;
}

/**
 * The remote to fetch a session's base from: the one whose URL is the
 * session's GitHub repository, else the only remote, else `origin`. Null
 * when the repository has no remote to use.
 */
export function chooseRemote(remotes: GitRemote[], repoFullName?: string): string | null {
  if (repoFullName) {
    const wanted = repoFullName.toLowerCase();
    const hit = remotes.find((remote) => repoFullNameFromRemote(remote.url)?.toLowerCase() === wanted);
    if (hit) return hit.name;
  }
  if (remotes.length === 1) return remotes[0].name;
  return remotes.find((remote) => remote.name === 'origin')?.name ?? null;
}
