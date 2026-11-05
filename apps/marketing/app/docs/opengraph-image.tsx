import { ImageResponse } from "next/og";
import { OgCard, OG_SIZE } from "@/components/og/OgCard";

export const size = OG_SIZE;
export const contentType = "image/png";

export default function Image() {
  return new ImageResponse(
    (
      <OgCard
        eyebrow="Docs"
        title="Talyn documentation"
        sub="Set up Talyn, run sessions, fix and review pull requests, and use the API."
        footer="talyn.dev/docs"
      />
    ),
    { ...size }
  );
}
