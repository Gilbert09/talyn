"use client";

import { useState } from "react";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { finalCta } from "@/lib/content";
import { captureSignup } from "@/lib/analytics";

/** Non-Mac waitlist form (records a `waitlist_signup` event in PostHog).
 *  Lived in the Beta section until that was folded into FinalCta. */
export function EmailCapture() {
  const [email, setEmail] = useState("");
  const [done, setDone] = useState(false);

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!email) return;
    captureSignup(email);
    setDone(true);
  };

  return (
    <form onSubmit={onSubmit} className="mx-auto mt-6 flex max-w-sm flex-col gap-2 sm:flex-row">
      <input
        type="email"
        required
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder={finalCta.emailPlaceholder}
        disabled={done}
        // sm:flex-1 (not flex-1): in the mobile COLUMN layout, flex-basis 0
        // beats h-11 on the vertical axis and squashes the input.
        className="h-11 rounded-xl border border-line-strong bg-white px-4 text-sm text-ink placeholder:text-ink-400 focus:border-clay/50 focus:outline-none focus:ring-2 focus:ring-clay/25 disabled:opacity-60 sm:flex-1"
      />
      <Button type="submit" variant={done ? "secondary" : "primary"} disabled={done}>
        {done ? (
          <>
            <Check className="h-4 w-4 text-status-green" /> You&apos;re on the list
          </>
        ) : (
          finalCta.emailCta
        )}
      </Button>
    </form>
  );
}
