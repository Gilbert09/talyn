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
};

export default nextConfig;
