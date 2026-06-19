import { Nav } from "@/components/layout/Nav";
import { Footer } from "@/components/layout/Footer";
import { Hero } from "@/components/sections/Hero";
import { PoweredBy } from "@/components/sections/PoweredBy";
import { Problem } from "@/components/sections/Problem";
import { HowItWorks } from "@/components/sections/HowItWorks";
import { Features } from "@/components/sections/Features";
import { Providers } from "@/components/sections/Providers";
import { WhyTalyn } from "@/components/sections/WhyTalyn";
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
        <Providers />
        <WhyTalyn />
        <Beta />
        <Faq />
        <FinalCta />
      </main>
      <Footer />
    </>
  );
}
