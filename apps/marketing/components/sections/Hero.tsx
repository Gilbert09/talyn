"use client";

import { motion } from "framer-motion";
import { Download, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { GridBackground } from "@/components/ui/GridBackground";
import { ScreenshotPlaceholder } from "@/components/ui/ScreenshotPlaceholder";
import { hero } from "@/lib/content";

export function Hero() {
  return (
    <section id="top" className="relative overflow-hidden pt-32 pb-20 sm:pt-40">
      <GridBackground />
      {/* scan-bar glow echoing the app boot screen */}
      <div
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-24 h-px w-[60%] -translate-x-1/2 animate-scan bg-gradient-to-r from-transparent via-clay/40 to-transparent"
      />

      <div className="container relative">
        <motion.div
          initial={{ opacity: 0, y: 18 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.7, ease: [0.21, 0.47, 0.32, 0.98] }}
          className="mx-auto max-w-3xl text-center"
        >
          <div className="mb-6 flex justify-center">
            <Badge dot>{hero.badge}</Badge>
          </div>

          <h1 className="font-display text-5xl font-semibold leading-[1.04] tracking-tight text-ink sm:text-7xl">
            {hero.titleLead}{" "}
            <span className="text-clay">{hero.titleAccent}</span>
          </h1>

          <p className="mx-auto mt-6 max-w-2xl text-lg leading-relaxed text-ink-500">
            {hero.sub}
          </p>

          <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <a href="/#download">
              <Button size="lg">
                <Download className="h-5 w-5" />
                {hero.primaryCta}
              </Button>
            </a>
            <a href="#how">
              <Button variant="secondary" size="lg">
                {hero.secondaryCta}
                <ArrowRight className="h-4 w-4" />
              </Button>
            </a>
          </div>

          <p className="mt-4 font-mono text-xs text-ink-400">{hero.microtrust}</p>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 40, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.9, delay: 0.15, ease: [0.21, 0.47, 0.32, 0.98] }}
          className="relative mx-auto mt-16 max-w-5xl"
        >
          <ScreenshotPlaceholder shot="dashboard" title="Talyn — My PRs" />
        </motion.div>
      </div>
    </section>
  );
}
