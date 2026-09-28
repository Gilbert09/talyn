import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The long-form prose shell, once.
 *
 * This class block used to be written out three times — byte-identically in
 * `app/[slug]/page.tsx` and `app/blog/[slug]/page.tsx`, and as a subset in
 * `components/layout/LegalPage.tsx`. Every new markdown surface copied it
 * again, so a typography fix landed on whichever pages the author happened to
 * remember. Compare pages would have made it four.
 *
 * Legal pages gain the table/code/blockquote rules they never used. That is
 * harmless — an arbitrary variant with no matching element emits nothing —
 * and it is the point: the next page that does use a table gets it right
 * without anybody noticing it had to.
 */
export function Prose({
  html,
  children,
  as: Tag = "div",
  className,
}: {
  /** Rendered markdown. Mutually exclusive with `children`. */
  html?: string;
  children?: ReactNode;
  as?: "div" | "article" | "section";
  className?: string;
}) {
  const classes = cn(
    `
      space-y-5 leading-relaxed text-ink-600
      [&_h2]:mt-10 [&_h2]:font-display [&_h2]:text-xl [&_h2]:font-semibold [&_h2]:text-ink
      [&_h3]:mt-8 [&_h3]:font-display [&_h3]:text-lg [&_h3]:font-semibold [&_h3]:text-ink
      [&_p]:text-[15px]
      [&_ul]:list-disc [&_ul]:space-y-2 [&_ul]:pl-6 [&_ul]:text-[15px]
      [&_ol]:list-decimal [&_ol]:space-y-2 [&_ol]:pl-6 [&_ol]:text-[15px]
      [&_a]:text-clay-600 [&_a]:underline [&_a]:underline-offset-2
      [&_strong]:font-semibold [&_strong]:text-ink
      [&_blockquote]:border-l-2 [&_blockquote]:border-line [&_blockquote]:pl-4 [&_blockquote]:text-ink-400
      [&_code]:rounded [&_code]:bg-ink/[0.05] [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[13px]
      [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:border [&_pre]:border-line [&_pre]:bg-ink/[0.03] [&_pre]:p-4
      [&_pre_code]:bg-transparent [&_pre_code]:p-0
      [&_table]:block [&_table]:overflow-x-auto [&_table]:text-[14px]
      [&_th]:border-b [&_th]:border-line [&_th]:px-3 [&_th]:py-2 [&_th]:text-left [&_th]:font-semibold [&_th]:text-ink
      [&_td]:border-b [&_td]:border-line [&_td]:px-3 [&_td]:py-2 [&_td]:align-top
    `,
    className
  );

  if (html !== undefined) {
    return <Tag className={classes} dangerouslySetInnerHTML={{ __html: html }} />;
  }
  return <Tag className={classes}>{children}</Tag>;
}
