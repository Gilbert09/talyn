import { Nav } from "@/components/layout/Nav";
import { Footer } from "@/components/layout/Footer";
import { Hero } from "@/components/sections/Hero";
import { Reasons } from "@/components/sections/Reasons";
import { Showcase } from "@/components/sections/Showcase";
import { PricingBand } from "@/components/sections/PricingBand";
import { Faq } from "@/components/sections/Faq";
import { FinalCta } from "@/components/sections/FinalCta";
import { HomeSchema } from "@/components/seo/HomeSchema";
import type { Metadata } from "next";

/** Moved off the root layout: see the note there on inherited canonicals. */
export const metadata: Metadata = {
  alternates: { canonical: "/" },
};

/**
 * The home page, simplified on 2026-11-12. The median visitor leaves after
 * about 24 seconds without scrolling, so the page says why in the hero and the
 * three reasons under it, then gives one row per promise. Every detail lives
 * on a feature page or in the docs.
 */
export default function Home() {
  return (
    <>
      <Nav />
      <main>
        <Hero />
        <Reasons />
        <Showcase />
        <PricingBand />
        <Faq />
        {/* Carries the #download anchor. */}
        <FinalCta />
      </main>
      <Footer />
      {/* FAQPage schema is emitted by <Faq /> itself, from the same array it
          renders. */}
      <HomeSchema />
    </>
  );
}
