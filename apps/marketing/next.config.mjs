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
    ];
  },
};

export default nextConfig;
