import { ImageResponse } from "next/og";
import { OgCard, OG_SIZE } from "@/components/og/OgCard";
import { isBlogEnabled } from "@/lib/flags";
import { listPosts, getPost } from "@/lib/posts";

export const size = OG_SIZE;
export const contentType = "image/png";

/**
 * Gated exactly like the post route it belongs to: with the blog off this
 * generates nothing, so there is no image URL to guess at either.
 */
export function generateStaticParams() {
  if (!isBlogEnabled()) return [];
  return listPosts().map((p) => ({ slug: p.slug }));
}

export default function Image({ params }: { params: { slug: string } }) {
  const post = isBlogEnabled() ? getPost(params.slug) : null;

  return new ImageResponse(
    (
      <OgCard
        eyebrow="Writing"
        title={post?.title ?? "Talyn"}
        sub={post?.description}
      />
    ),
    { ...size }
  );
}
