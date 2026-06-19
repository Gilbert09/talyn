import { ImageResponse } from "next/og";

export const alt = "Talyn — Drag your PRs to green";
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
            "radial-gradient(900px circle at 30% 0%, #16203a 0%, #050b1c 55%, #030816 100%)",
          color: "white",
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
          <svg width="56" height="56" viewBox="0 0 64 64" fill="none">
            <g
              stroke="#f5b94d"
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
            fontSize: 76,
            fontWeight: 700,
            lineHeight: 1.05,
            letterSpacing: -2,
            display: "flex",
          }}
        >
          Drag your PRs to{" "}
          <span style={{ color: "#f5b94d", marginLeft: 18 }}>green.</span>
        </div>

        <div
          style={{
            marginTop: 28,
            fontSize: 30,
            color: "#aac4f5",
            maxWidth: 900,
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
            color: "#7da2e8",
          }}
        >
          <span>talyn.dev</span>
          <span style={{ color: "#3b5a9a" }}>·</span>
          <span>Free in beta</span>
        </div>
      </div>
    ),
    { ...size }
  );
}
