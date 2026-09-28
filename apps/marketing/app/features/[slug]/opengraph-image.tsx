import { ImageResponse } from "next/og";
import { OgCard, OG_SIZE } from "@/components/og/OgCard";
import { listFeaturePages, getFeaturePage } from "@/lib/features";

export const size = OG_SIZE;
export const contentType = "image/png";

/**
 * One card per feature page, generated at build time.
 *
 * Without this every feature page unfurls in Slack and on X as "Wake up to
 * green PRs." — the root card, inherited. Ten links that all look like the
 * home page is a worse signal than no card at all.
 */
export function generateStaticParams() {
  return listFeaturePages().map((f) => ({ slug: f.slug }));
}

export default function Image({ params }: { params: { slug: string } }) {
  const feature = getFeaturePage(params.slug);

  return new ImageResponse(
    (
      <OgCard
        eyebrow={feature?.eyebrow}
        title={feature?.title ?? "Wake up to green PRs."}
        sub={feature?.description}
        footer="talyn.dev"
      />
    ),
    { ...size }
  );
}
