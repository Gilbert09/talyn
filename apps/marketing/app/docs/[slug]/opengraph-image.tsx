import { ImageResponse } from "next/og";
import { OgCard, OG_SIZE } from "@/components/og/OgCard";
import { getDoc, listDocs } from "@/lib/docs";

export const size = OG_SIZE;
export const contentType = "image/png";

export function generateStaticParams() {
  return listDocs().map((d) => ({ slug: d.slug }));
}

export default function Image({ params }: { params: { slug: string } }) {
  const doc = getDoc(params.slug);

  return new ImageResponse(
    (
      <OgCard
        eyebrow={doc ? `Docs · ${doc.section}` : "Docs"}
        title={doc?.title ?? "Talyn docs"}
        sub={doc?.description}
        footer="talyn.dev/docs"
      />
    ),
    { ...size }
  );
}
