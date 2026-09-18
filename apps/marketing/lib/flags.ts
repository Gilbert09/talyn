/**
 * Build-time gates for the marketing site.
 *
 * Deliberately NOT the backend's PostHog register
 * (`packages/shared/src/featureFlags.ts`). That register answers "may THIS
 * PERSON see this", resolving env override → PostHog → a per-flag fallback
 * against a Supabase user id. A statically rendered marketing page has no
 * person to ask about and no request to ask during: every page here is
 * generated once at build time and served as a file.
 *
 * It also has to gate more than rendering. A runtime flag cannot keep a URL
 * out of Googlebot's index, out of the sitemap, or out of the hands of anyone
 * who guesses the path — by the time any flag is read the HTML has already
 * shipped. A build-time gate means the route is never generated at all, so
 * the answer to `/blog` is an ordinary 404.
 *
 * Flip it by setting the variable on the Vercel project and redeploying: the
 * workflow runs `vercel pull` before `vercel build`, so the value comes from
 * project settings and no code change is involved. Production and Preview can
 * hold different values.
 */

const TRUTHY = new Set(["1", "true", "on", "yes"]);

function truthy(raw: string | undefined): boolean {
  return TRUTHY.has((raw ?? "").trim().toLowerCase());
}

/**
 * The blog section: the index, every post, the feed, the nav link and the
 * sitemap entries.
 *
 * **Fallback OFF**, and deliberately the opposite polarity to the backend's
 * `workflows` gate, where anything but an explicit `false` reads as on. The
 * asymmetry is the point. Reading a typo as "on" is the safe direction for a
 * released feature and the dangerous one here: a mistyped value that silently
 * publishes a half-written post to a public domain is not undone by fixing the
 * typo, because it has already been fetched, indexed and possibly archived.
 * Off until somebody says otherwise, in exactly those words.
 */
export function isBlogEnabled(): boolean {
  // Written as a literal member access, never `process.env[name]`. Next
  // replaces this TEXTUALLY at build time (via the `env` key in
  // next.config.mjs), which is what lets the client-side Nav read the same
  // value the server used. A computed lookup is invisible to that pass, so it
  // would evaluate to `undefined` in the browser bundle and the link would
  // stay hidden with the flag on — working server, silently wrong nav.
  return truthy(process.env.BLOG_ENABLED);
}

/**
 * Whether posts marked `draft: true` render.
 *
 * Local development only — there is no environment variable for this on
 * purpose. A draft is unfinished writing, and the one place it should be
 * readable is the machine it is being written on. Review drafts with
 * `npm run dev`; a preview deploy is a production build and will not show
 * them.
 */
export function areDraftsVisible(): boolean {
  return process.env.NODE_ENV !== "production";
}
