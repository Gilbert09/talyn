import { ImageResponse } from "next/og";
import { OgCard, OG_SIZE } from "@/components/og/OgCard";

export const alt = "Everything Talyn does";
export const size = OG_SIZE;
export const contentType = "image/png";

/**
 * Hub pages need their own card even though the root has one.
 *
 * Next only falls back to an ancestor's `opengraph-image` when the page has
 * not declared `openGraph` metadata of its own. These pages set a title and
 * URL there, which suppresses the inherited image and leaves the unfurl with
 * no picture at all. A file here is the fix.
 */
export default function Image() {
  return new ImageResponse(
    (
      <OgCard
        eyebrow="Features"
        title="Everything Talyn"
        titleAccent="does."
        sub="A PR dashboard, code review that stays off your pull request, a merge queue that fixes before it lands, and agents on your own subscription."
      />
    ),
    { ...size }
  );
}
