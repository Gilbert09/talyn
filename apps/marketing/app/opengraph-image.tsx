import { ImageResponse } from "next/og";
import { OgCard, OG_SIZE } from "@/components/og/OgCard";

export const alt = "Talyn: keep your coding agents working, even when you aren't.";
export const size = OG_SIZE;
export const contentType = "image/png";

// Branded social card, rendered at build time (no external fonts needed).
// The card body lives in components/og/OgCard so the feature and comparison
// routes render the same thing with their own title.
export default function OgImage() {
  return new ImageResponse(
    (
      <OgCard
        title="Keep your coding agents working"
        titleAccent="even when you aren't."
        sub="Parallel coding sessions in cloud sandboxes, on your Claude or ChatGPT plan. From the first prompt to the merged pull request."
        footer="talyn.dev · Public beta"
      />
    ),
    { ...size }
  );
}
