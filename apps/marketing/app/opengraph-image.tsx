import { ImageResponse } from "next/og";

export const alt = "Talyn — Merge more. Babysit less.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// Branded social card, rendered at build time (no external fonts needed).
export default function OgImage() {
  return new ImageResponse(
    (
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
          <span style={{ fontSize: 34, fontWeight: 700, letterSpacing: -1 }}>
            Talyn
          </span>
        </div>

        <div
          style={{
            marginTop: 40,
            fontSize: 80,
            fontWeight: 700,
            lineHeight: 1.04,
            letterSpacing: -2,
            display: "flex",
          }}
        >
          Merge more.{" "}
          <span style={{ color: "#c25e3a", marginLeft: 18 }}>Babysit less.</span>
        </div>

        <div
          style={{
            marginTop: 28,
            fontSize: 30,
            color: "#5c554a",
            maxWidth: 920,
            lineHeight: 1.4,
          }}
        >
          Cloud agents that fix CI, clear conflicts, and keep every pull request
          mergeable — automatically.
        </div>

        <div
          style={{
            marginTop: 50,
            display: "flex",
            gap: 14,
            fontSize: 22,
            color: "#9a9183",
          }}
        >
          <span>talyn.dev</span>
          <span>·</span>
          <span>Public beta</span>
        </div>
      </div>
    ),
    { ...size }
  );
}
