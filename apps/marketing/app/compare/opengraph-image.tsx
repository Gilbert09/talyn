import { ImageResponse } from "next/og";
import { OgCard, OG_SIZE } from "@/components/og/OgCard";

export const alt = "Talyn vs the alternatives";
export const size = OG_SIZE;
export const contentType = "image/png";

// See the note in app/features/opengraph-image.tsx on why a hub page needs
// its own card despite the root having one.
export default function Image() {
  return new ImageResponse(
    (
      <OgCard
        eyebrow="Compare"
        title="Talyn vs the"
        titleAccent="alternatives."
        sub="Honest comparisons against the AI reviewers, merge queues and cloud agents people weigh Talyn up against — including when to pick theirs."
      />
    ),
    { ...size }
  );
}
