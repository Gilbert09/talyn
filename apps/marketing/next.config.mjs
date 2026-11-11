/**
 * The repository's star count, read once per build for the nav's Star button.
 * Build time, not page load: GitHub's unauthenticated API allows 60 requests
 * an hour per IP, and the page must not wait on it. Any failure gives "", and
 * the button then shows no number.
 */
async function githubStars() {
  try {
    const res = await fetch("https://api.github.com/repos/Gilbert09/talyn", {
      headers: { Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return "";
    const { stargazers_count: n } = await res.json();
    return Number.isInteger(n) ? String(n) : "";
  } catch {
    return "";
  }
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Inlined into the client bundle at build time by textual substitution, so
  // the client-side Nav decides whether to draw the Writing link from the very
  // same variable the server used to decide whether those routes exist. It is
  // NOT a runtime lookup and cannot be flipped without a rebuild — which is
  // the property we want: see lib/flags.ts.
  env: {
    BLOG_ENABLED: process.env.BLOG_ENABLED ?? "",
    GITHUB_STARS: await githubStars(),
  },
  images: {
    remotePatterns: [{ protocol: "https", hostname: "img.logo.dev" }],
  },
  async redirects() {
    return [
      {
        // The GitHub merge queue comparison predates /compare and is indexed
        // at the site root, so it stays there. This is the URL somebody
        // guesses once the section exists — pointing it at the real page
        // beats a 404 and beats publishing the same words twice.
        source: "/compare/github-merge-queue",
        destination: "/github-merge-queue-alternative",
        permanent: true,
      },
      // The relaunch (November 2026) names sessions and threads. These are
      // the URLs somebody guesses, plus the internal name "workbench".
      { source: "/sessions", destination: "/features/sessions", permanent: false },
      { source: "/threads", destination: "/features/threads", permanent: false },
      { source: "/workbenches", destination: "/features/sessions", permanent: false },
      { source: "/features/workbenches", destination: "/features/sessions", permanent: false },
    ];
  },
};

export default nextConfig;
