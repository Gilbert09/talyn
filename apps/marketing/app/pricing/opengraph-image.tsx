import { ImageResponse } from "next/og";
import { OgCard, OG_SIZE } from "@/components/og/OgCard";

export const alt = "Talyn pricing";
export const size = OG_SIZE;
export const contentType = "image/png";

// Its own card, for the reason in app/features/opengraph-image.tsx: a page
// that declares `openGraph` metadata stops inheriting the root image, so
// without this the pricing link unfurls with no picture.
export default function Image() {
  return new ImageResponse(
    (
      <OgCard
        eyebrow="Pricing"
        title="Free to start."
        titleAccent="$40 for 200 box-hours."
        sub="Pay for the machines, not the model. Agent runs go on the Claude or ChatGPT subscription you already pay for."
      />
    ),
    { ...size }
  );
}
