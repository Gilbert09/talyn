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
 * Order: what a session is, which agents and whose subscription (the most
 * opened FAQ question), the PR work today's users rely on, why many sessions
 * work, threads, automation, price, the objections, and then the close, so the
 * last ask comes after the questions are answered.
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
        <Providers />
        <PullRequests />
        <Sandboxes />
        <Threads />
        <Automation />
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
