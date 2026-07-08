import { Nav } from "@/components/layout/Nav";
import { Footer } from "@/components/layout/Footer";
import { Hero } from "@/components/sections/Hero";
import { PoweredBy } from "@/components/sections/PoweredBy";
import { Problem } from "@/components/sections/Problem";
import { HowItWorks } from "@/components/sections/HowItWorks";
import { Features } from "@/components/sections/Features";
import { MidCta } from "@/components/sections/MidCta";
import { Providers } from "@/components/sections/Providers";
import { Pricing } from "@/components/sections/Pricing";
import { Beta } from "@/components/sections/Beta";
import { Faq } from "@/components/sections/Faq";
import { FinalCta } from "@/components/sections/FinalCta";

export default function Home() {
  return (
    <>
      <Nav />
      <main>
        <Hero />
        <PoweredBy />
        <Problem />
        <HowItWorks />
        <Features />
        <MidCta />
        {/* WhyTalyn was cut from the homepage: its six cards restated what
            Features + Providers already cover, making the middle of the page
            feel long and repetitive (Lizzie's feedback, Jul 2026). The
            component + `why` copy remain for a future standalone page. */}
        <Providers />
        <Pricing />
        <Beta />
        <Faq />
        <FinalCta />
      </main>
      <Footer />
    </>
  );
}
