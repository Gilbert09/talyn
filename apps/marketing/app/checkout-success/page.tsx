import type { Metadata } from "next";
import { Nav } from "@/components/layout/Nav";
import { Footer } from "@/components/layout/Footer";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export const metadata: Metadata = {
  title: "You're on Unlimited",
  description: "Payment complete — head back to Talyn.",
  // Post-checkout landing only — never useful in search results.
  robots: { index: false, follow: false },
};

/**
 * Polar checkout `success_url` target. The desktop app flips to Unlimited on
 * its own (webhook → live push), so this page is purely the landing after
 * payment: confirm, and hand the user back to the app. The button uses the
 * fastowl:// deep link, which focuses (or launches) the installed app —
 * browsers block auto-redirects to custom schemes, so it stays a click.
 */
export default function CheckoutSuccessPage() {
  return (
    <>
      <Nav />
      <main className="container flex max-w-xl flex-col items-center pt-40 pb-32 text-center sm:pt-48">
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-clay/10 text-2xl">
          ⚡
        </div>
        <h1 className="mt-6 font-display text-4xl font-semibold tracking-tight text-ink">
          You&rsquo;re on Unlimited
        </h1>
        <p className="mt-4 text-[15px] leading-relaxed text-ink-600">
          Payment complete — thanks for supporting Talyn. Your plan is active
          and the app picks it up by itself within a few seconds, so there&rsquo;s
          nothing left to do here.
        </p>
        <a
          href="fastowl://checkout-success"
          className={cn(buttonVariants({ variant: "primary", size: "lg" }), "mt-8")}
        >
          Open Talyn
        </a>
        <p className="mt-4 text-sm text-ink-400">
          or just close this tab and switch back to the app.
        </p>
      </main>
      <Footer />
    </>
  );
}
