import { ImageResponse } from "next/og";
import { OgCard, OG_SIZE } from "@/components/og/OgCard";
import { listComparePages, getComparePage } from "@/lib/compare";

export const size = OG_SIZE;
export const contentType = "image/png";

export function generateStaticParams() {
  return listComparePages().map((c) => ({ slug: c.slug }));
}

export default function Image({ params }: { params: { slug: string } }) {
  const page = getComparePage(params.slug);

  return new ImageResponse(
    (
      <OgCard
        eyebrow="Compare"
        title="Talyn vs"
        titleAccent={page?.competitor ?? "the alternatives"}
        sub={page?.description}
        footer="talyn.dev"
      />
    ),
    { ...size }
  );
}
