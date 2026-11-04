import { Nav } from "@/components/layout/Nav";
import { Footer } from "@/components/layout/Footer";
import { Hero } from "@/components/sections/Hero";
import { Proof } from "@/components/sections/Proof";
import { SessionSteps } from "@/components/sections/SessionSteps";
import { Sandboxes } from "@/components/sections/Sandboxes";
import { Threads } from "@/components/sections/Threads";
import { PullRequests } from "@/components/sections/PullRequests";
import { Automation } from "@/components/sections/Automation";
import { Providers } from "@/components/sections/Providers";
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
 * The relaunch home page (November 2026), built around sessions and threads.
 * Order: what a session is, why many of them work, threads, then the PR work
 * that made Talyn's name, automation, the subscription, price, and the close.
 */
export default function Home() {
  return (
    <>
      <Nav />
      <main>
        <Hero />
        {/* Checkable facts, straight after the claim they back. */}
        <Proof />
        <SessionSteps />
        <Sandboxes />
        <Threads />
        <PullRequests />
        <Automation />
        <Providers />
        <PricingBand />
        {/* Carries the #download anchor. */}
        <FinalCta />
        <Faq />
      </main>
      <Footer />
      {/* FAQPage schema is emitted by <Faq /> itself, from the same array it
          renders. */}
      <HomeSchema />
    </>
  );
}
