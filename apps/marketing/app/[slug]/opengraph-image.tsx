import { ImageResponse } from "next/og";
import { OgCard, OG_SIZE } from "@/components/og/OgCard";
import { listGuides, getGuide } from "@/lib/guides";

export const size = OG_SIZE;
export const contentType = "image/png";

/**
 * A card per guide.
 *
 * The guides have set `openGraph` metadata since they shipped, which stops
 * Next inheriting the root card — so until now every guide unfurled with no
 * image at all. Nobody would notice that from the page itself, which is why
 * it lasted.
 */
export function generateStaticParams() {
  return listGuides().map((g) => ({ slug: g.slug }));
}

export default function Image({ params }: { params: { slug: string } }) {
  const guide = getGuide(params.slug);

  return new ImageResponse(
    (
      <OgCard
        eyebrow="Guide"
        title={guide?.title ?? "Talyn"}
        sub={guide?.description}
      />
    ),
    { ...size }
  );
}
