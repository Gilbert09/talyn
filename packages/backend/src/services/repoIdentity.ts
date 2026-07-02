// Derive a GitHub owner/repo identity from a repositories.url value.
// The repositories table stores no separate owner column — every consumer
// parses the URL. Keep the regex here so they can't drift.

export interface RepoIdentity {
  owner: string;
  repo: string;
  fullName: string;
}

/** Parse `https://github.com/owner/repo(.git)` / `git@github.com:owner/repo`. */
export function parseRepoUrl(url: string): RepoIdentity | null {
  const match = url.match(/github\.com[/:]([\w-]+)\/([\w.-]+)/);
  if (!match) return null;
  const repo = match[2].replace(/\.git$/, '');
  return { owner: match[1], repo, fullName: `${match[1]}/${repo}` };
}
