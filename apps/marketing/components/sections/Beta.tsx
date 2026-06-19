"use client";

import { useState } from "react";
import { Download, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { GridBackground } from "@/components/ui/GridBackground";
import { Reveal } from "@/components/ui/Reveal";
import { beta } from "@/lib/content";

function EmailCapture() {
  const [email, setEmail] = useState("");
  const [done, setDone] = useState(false);

  // Placeholder handler — wire to Resend / Loops / a form endpoint at launch.
  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!email) return;
    setDone(true);
  };

  return (
    <form onSubmit={onSubmit} className="mx-auto mt-6 flex max-w-sm flex-col gap-2 sm:flex-row">
      <input
        type="email"
        required
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder={beta.emailPlaceholder}
        disabled={done}
        className="h-11 flex-1 rounded-xl border border-line-strong bg-white px-4 text-sm text-ink placeholder:text-ink-400 focus:border-clay/50 focus:outline-none focus:ring-2 focus:ring-clay/25 disabled:opacity-60"
      />
      <Button type="submit" variant={done ? "secondary" : "primary"} disabled={done}>
        {done ? (
          <>
            <Check className="h-4 w-4 text-status-green" /> You&apos;re on the list
          </>
        ) : (
          beta.emailCta
        )}
      </Button>
    </form>
  );
}

export function Beta() {
  return (
    <section id="download" className="relative overflow-hidden py-24">
      <GridBackground />
      <div className="container relative">
        <Reveal className="mx-auto max-w-2xl rounded-3xl border border-line-strong bg-white p-10 text-center shadow-frame sm:p-14">
          <div className="mb-5 flex justify-center">
            <Badge dot>{beta.badge}</Badge>
          </div>
          <h2 className="font-display text-3xl font-semibold tracking-tight text-ink sm:text-4xl">
            {beta.title}
          </h2>
          <p className="mx-auto mt-4 max-w-lg text-ink-500">{beta.body}</p>

          <div className="mt-8 flex justify-center">
            <a href="#download">
              <Button size="lg">
                <Download className="h-5 w-5" />
                {beta.cta}
              </Button>
            </a>
          </div>

          <div className="mt-8 border-t border-line pt-6">
            <p className="text-sm text-ink-500">{beta.emailLabel}</p>
            <EmailCapture />
          </div>
        </Reveal>
      </div>
    </section>
  );
}
