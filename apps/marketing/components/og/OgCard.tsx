/**
 * The shared social card body.
 *
 * Lifted out of `app/opengraph-image.tsx` so the feature and comparison
 * routes can render the same card with their own title instead of every page
 * on the site sharing one image that says "Wake up to green PRs."
 *
 * Three constraints this file has to respect, all of them satori's rather
 * than React's:
 *   - plain function, no hooks, no `"use client"` — it runs in the image
 *     renderer, not in a browser;
 *   - inline styles only, no Tailwind — satori does not see the stylesheet;
 *   - every element with more than one child needs an explicit
 *     `display: "flex"`, which is why several of these look redundant.
 *
 * No external fonts, matching the original: a webfont fetch at build time is
 * a build that fails when somebody else's CDN does.
 */

export const OG_SIZE = { width: 1200, height: 630 };

function OwlMark() {
  return (
    <svg width="56" height="56" viewBox="0 0 64 64" fill="none">
      <g
        stroke="#c25e3a"
        strokeWidth={3.4}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M18 22 C 21 10 43 10 46 22" />
        <path d="M16 25 C 11 33 11 46 18 53" />
        <path d="M48 25 C 53 33 53 46 46 53" />
        <circle cx="25.5" cy="30" r="4.4" />
        <circle cx="38.5" cy="30" r="4.4" />
        <path d="M29 37 L 32 43 L 35 37" />
        <path d="M27 49 Q 32 52 37 49" />
      </g>
    </svg>
  );
}

export function OgCard({
  eyebrow,
  title,
  titleAccent,
  sub,
  footer = "talyn.dev",
}: {
  /** Small line above the title — the section, usually. */
  eyebrow?: string;
  title: string;
  /** Trailing clause painted clay. The home card's "green PRs." */
  titleAccent?: string;
  sub?: string;
  footer?: string;
}) {
  // A long title at 80px overflows 1200×630 and satori clips rather than
  // wraps down. Step the size instead of truncating: a cut-off headline in a
  // Slack unfurl reads as a broken page.
  const length = title.length + (titleAccent?.length ?? 0);
  const titleSize = length > 58 ? 54 : length > 38 ? 66 : 80;

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        padding: "80px",
        background:
          "radial-gradient(900px circle at 28% 0%, #ffffff 0%, #f8f5f0 55%, #f2ede5 100%)",
        color: "#23201b",
        fontFamily: "sans-serif",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
        <OwlMark />
        <span style={{ fontSize: 34, fontWeight: 700, letterSpacing: -1 }}>
          Talyn
        </span>
        {eyebrow && (
          <span
            style={{
              fontSize: 22,
              color: "#9a9183",
              letterSpacing: 2,
              textTransform: "uppercase",
              marginLeft: 8,
            }}
          >
            {eyebrow}
          </span>
        )}
      </div>

      <div
        style={{
          marginTop: 40,
          fontSize: titleSize,
          fontWeight: 700,
          lineHeight: 1.06,
          letterSpacing: -2,
          display: "flex",
          flexWrap: "wrap",
          maxWidth: 1000,
        }}
      >
        {title}
        {titleAccent && (
          <span style={{ color: "#c25e3a", marginLeft: 18 }}>{titleAccent}</span>
        )}
      </div>

      {sub && (
        <div
          style={{
            marginTop: 28,
            fontSize: 30,
            color: "#5c554a",
            maxWidth: 920,
            lineHeight: 1.4,
            display: "flex",
          }}
        >
          {sub}
        </div>
      )}

      <div
        style={{
          marginTop: 50,
          display: "flex",
          gap: 14,
          fontSize: 22,
          color: "#9a9183",
        }}
      >
        <span>{footer}</span>
      </div>
    </div>
  );
}
