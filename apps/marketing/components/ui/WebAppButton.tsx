"use client";

import { ArrowRight } from "lucide-react";
import { Button, type ButtonProps } from "@/components/ui/button";
import { capture } from "@/lib/analytics";
import { site } from "@/lib/content";

/**
 * "Open in browser" — the site's OTHER conversion, finally instrumented.
 *
 * Until now this was a bare `<a href={site.appUrl}>` repeated on every page
 * with three different labels, and nothing captured it. That made the second
 * half of the funnel invisible: 40 people opened the web app last month
 * against 47 on desktop, so roughly half the people who act on this site were
 * taking a path we could not see, count, or attribute to a page.
 *
 * It matters most for one open question. Windows visitors click Download at
 * 10.6%; Mac visitors at 1.5%. The obvious explanation is that Mac users take
 * the browser instead — and without this event that stays a guess.
 *
 * `placement` is required for the same reason it is on DownloadButton: a
 * default would quietly pool every page into one bucket.
 */
export function WebAppButton({
  children = "Open in browser",
  size = "lg",
  variant = "secondary",
  className,
  placement,
  showArrow = true,
}: {
  children?: React.ReactNode;
  size?: ButtonProps["size"];
  variant?: ButtonProps["variant"];
  className?: string;
  placement: string;
  showArrow?: boolean;
}) {
  return (
    <a
      href={site.appUrl}
      className={className}
      // Not preventDefault'd and not awaited: this is an ordinary link and
      // must stay one, so middle-click and cmd-click keep working. capture()
      // is fire-and-forget and posthog-js keeps its queue in localStorage, so
      // an event started here survives the navigation.
      onClick={(e) => capture("open_app_click", { placement, trusted: e.isTrusted })}
    >
      <Button variant={variant} size={size} className={className}>
        {children}
        {showArrow && <ArrowRight className="h-4 w-4" />}
      </Button>
    </a>
  );
}
