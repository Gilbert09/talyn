import { ImageResponse } from "next/og";
import { OgCard, OG_SIZE } from "@/components/og/OgCard";

export const alt = "Talyn — Wake up to green PRs.";
export const size = OG_SIZE;
export const contentType = "image/png";

// Branded social card, rendered at build time (no external fonts needed).
// The card body lives in components/og/OgCard so the feature and comparison
// routes render the same thing with their own title.
export default function OgImage() {
  return new ImageResponse(
    (
      <OgCard
        title="Wake up to"
        titleAccent="green PRs."
        sub="Cloud agents that fix CI, clear conflicts, and land your pull requests while you sleep."
        footer="talyn.dev · Public beta"
      />
    ),
    { ...size }
  );
}
