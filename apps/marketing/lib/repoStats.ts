/**
 * Facts about the repository, read from GitHub at BUILD time.
 *
 * The site has no testimonials, no customer logos and no user count, because
 * there are no customers to name yet — and inventing any of that would
 * undercut eight comparison pages whose whole credibility rests on citing
 * sources. What it does have is a public repository and a release process,
 * and both are checkable by anyone in about ten seconds.
 *
 * Build time, not request time, deliberately: the numbers move slowly, an
 * unauthenticated GitHub API is rate-limited to 60 requests an hour per IP,
 * and a marketing page that blocks on a third-party call to render a star
 * count has made a boast into a dependency.
 *
 * Every failure returns null and the caller renders nothing. A trust strip
 * that says "— stars" is worse than no trust strip.
 */

const REPO = "Gilbert09/talyn";

export interface RepoStats {
  latestVersion: string | null;
  latestPublishedAt: string | null;
}

const EMPTY: RepoStats = {
  latestVersion: null,
  latestPublishedAt: null,
};

async function getJson<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}${path}`, {
      headers: { Accept: "application/vnd.github+json" },
      // Re-read hourly in dev; in a production build this resolves once and
      // is baked into the HTML.
      next: { revalidate: 3600 },
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export async function getRepoStats(): Promise<RepoStats> {
  const release = await getJson<{ tag_name?: string; published_at?: string }>(
    "/releases/latest"
  );

  return {
    latestVersion:
      typeof release?.tag_name === "string" ? release.tag_name : EMPTY.latestVersion,
    latestPublishedAt:
      typeof release?.published_at === "string"
        ? release.published_at
        : EMPTY.latestPublishedAt,
  };
}

/** "3 hours ago", "yesterday", "6 days ago". Null when the input is unusable. */
export function relativeTime(iso: string | null): string | null {
  if (!iso) return null;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  const hours = Math.floor((Date.now() - then) / 3_600_000);
  if (hours < 0) return null;
  if (hours < 1) return "in the last hour";
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  return null;
}
