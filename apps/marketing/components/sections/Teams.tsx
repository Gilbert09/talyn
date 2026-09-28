"use client";

import { useState } from "react";
import { Check, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Reveal } from "@/components/ui/Reveal";
import { TeamsEnquiryModal } from "@/components/modals/TeamsEnquiryModal";
import { capture } from "@/lib/analytics";
import { teams } from "@/lib/content";

/**
 * The teams band on /pricing.
 *
 * Sits below the two self-serve tiers rather than beside them as a third
 * card, because it is not a tier — there is no seat billing to buy. Making it
 * a card would put a "Contact us" column next to two real prices, which is
 * the pricing-page failure pattern everybody recognises and resents.
 *
 * `teams_enquiry_opened` fires on the button, separately from
 * `teams_enquiry_submitted` in the modal, so the drop-off between wanting to
 * ask and actually asking is visible. Without both, an empty tile is
 * ambiguous: nobody wanted it, or the form is broken?
 */
export function Teams({ placement = "pricing-teams" }: { placement?: string }) {
  const [open, setOpen] = useState(false);

  return (
    <section id="teams" className="border-t border-line py-20">
      <div className="container">
        <Reveal className="mx-auto max-w-3xl rounded-2xl border border-line bg-white p-8 shadow-soft sm:p-10">
          <div className="flex items-center gap-3">
            <span className="inline-flex rounded-xl border border-line bg-paper-100 p-2">
              <Users className="h-5 w-5 text-clay-600" />
            </span>
            <p className="font-mono text-xs uppercase tracking-[0.2em] text-clay-600">
              {teams.kicker}
            </p>
          </div>

          <h2 className="mt-5 font-display text-2xl font-semibold tracking-tight text-ink sm:text-3xl">
            {teams.title}
          </h2>
          <p className="mt-4 max-w-xl text-[15px] leading-relaxed text-ink-500">
            {teams.body}
          </p>

          <ul className="mt-6 space-y-3">
            {teams.bullets.map((b) => (
              <li key={b} className="flex items-start gap-3 text-sm text-ink-700">
                <span className="mt-0.5 inline-flex rounded-full border border-clay/30 bg-clay/10 p-0.5">
                  <Check className="h-3.5 w-3.5 text-clay-600" />
                </span>
                {b}
              </li>
            ))}
          </ul>

          <Button
            size="md"
            className="mt-7"
            onClick={() => {
              capture("teams_enquiry_opened", { placement });
              setOpen(true);
            }}
          >
            {teams.cta}
          </Button>

          {/* The limitation, on the page rather than in the reply. A team lead
              asks about SSO inside two minutes, and finding out after the
              email exchange wastes both people's time. */}
          <p className="mt-6 max-w-xl text-xs leading-relaxed text-ink-400">
            {teams.caveat}
          </p>
        </Reveal>
      </div>

      <TeamsEnquiryModal
        open={open}
        onClose={() => setOpen(false)}
        placement={placement}
      />
    </section>
  );
}
