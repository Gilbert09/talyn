import { SectionHeading } from "@/components/ui/SectionHeading";
import { FaqAccordion } from "@/components/sections/FaqAccordion";
import { JsonLd, faqSchema } from "@/components/seo/JsonLd";
import { faq } from "@/lib/content";

/**
 * The homepage FAQ.
 *
 * A server component now — the open/closed state moved into `FaqAccordion`,
 * which is what lets this one also emit `FAQPage` schema from the very same
 * array the accordion renders. Google requires the answer to be visible on
 * the page, so deriving both from one list is the only way they cannot drift.
 */
export function Faq() {
  return (
    <section id="faq" className="border-t border-line bg-paper-100 py-24">
      <div className="container">
        <SectionHeading kicker="FAQ" title="Questions, answered." />
        <FaqAccordion items={faq} className="mx-auto mt-12 max-w-2xl" />
      </div>
      <JsonLd data={faqSchema(faq)} />
    </section>
  );
}
