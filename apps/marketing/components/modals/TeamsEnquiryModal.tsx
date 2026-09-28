"use client";

import { useEffect, useId, useRef, useState } from "react";
import { X, Loader2, Check, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { captureWithDelivery, capture } from "@/lib/analytics";
import { site, teams } from "@/lib/content";
import { cn } from "@/lib/utils";

/**
 * The teams enquiry form.
 *
 * Three fields, and the count is the design. A form's completion rate falls
 * roughly 10–25% between three fields and six, and every extra question here
 * would be one I could ask in the reply instead. Email is required because
 * without it there is no conversation; team size is required because it is
 * the only thing that changes what I would say back; everything else is
 * optional.
 *
 * **The submission goes to PostHog and nowhere else.** Tom's call, and it is
 * the thing this component has to be careful about, because the site already
 * deleted a form for getting it wrong: the old waitlist answered "You're on
 * the list" while the address went into an event property and no list at all.
 * So the success state is only shown when PostHog actually accepted the
 * event. If it did not — ad blocker, blocked host, script never loaded — the
 * form says so and points at GitHub issues, which is already the published
 * support channel and needs no new address on the site.
 */

type State = "form" | "sending" | "sent" | "failed";

const TEAM_SIZES = ["2–5", "6–15", "16–50", "50+"] as const;

export function TeamsEnquiryModal({
  open,
  onClose,
  placement,
}: {
  open: boolean;
  onClose: () => void;
  /** Which button opened it, so the tile can attribute enquiries to a surface. */
  placement: string;
}) {
  const [state, setState] = useState<State>("form");
  const [email, setEmail] = useState("");
  const [size, setSize] = useState<string>("");
  const [note, setNote] = useState("");
  const [touched, setTouched] = useState(false);

  const titleId = useId();
  const emailId = useId();
  const sizeId = useId();
  const noteId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const firstFieldRef = useRef<HTMLInputElement>(null);
  // Whoever had focus before the dialog opened, so it can go back there.
  const restoreRef = useRef<HTMLElement | null>(null);

  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());

  useEffect(() => {
    if (!open) return;
    restoreRef.current = document.activeElement as HTMLElement | null;
    setState("form");
    setTouched(false);
    // Focus the first field rather than the dialog: this is a short form and
    // the first thing anybody does is type.
    const t = setTimeout(() => firstFieldRef.current?.focus(), 50);

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key !== "Tab") return;
      // Keep Tab inside the dialog. Without this the next Tab lands on the
      // page behind it, which for a screen reader is the dialog silently
      // ceasing to exist.
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      if (!focusable?.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      restoreRef.current?.focus?.();
      clearTimeout(t);
    };
  }, [open, onClose]);

  if (!open) return null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (!emailValid || !size) return;
    setState("sending");

    const ok = await captureWithDelivery("teams_enquiry_submitted", {
      // The email is the point of the form — it is what makes a reply
      // possible. It is an event property and never an identify() call: see
      // the note in lib/analytics.ts on why identifying here would break the
      // app's own person merge. Declared in the privacy policy §1.
      work_email: email.trim(),
      team_size: size,
      note: note.trim() || undefined,
      note_length: note.trim().length,
      placement,
    });

    setState(ok ? "sent" : "failed");
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-end justify-center overflow-y-auto bg-ink/30 p-4 backdrop-blur-sm sm:items-center"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="relative w-full max-w-lg rounded-2xl border border-line bg-paper p-6 shadow-frame sm:p-8"
      >
        <button
          onClick={onClose}
          aria-label="Close"
          className="absolute right-4 top-4 rounded-lg p-1.5 text-ink-400 transition-colors hover:bg-ink/[0.04] hover:text-ink"
        >
          <X className="h-4 w-4" />
        </button>

        {state === "sent" ? (
          <div className="py-4 text-center">
            <span className="mx-auto mb-4 inline-flex rounded-full border border-clay/30 bg-clay/10 p-2.5">
              <Check className="h-5 w-5 text-clay-600" />
            </span>
            <h2 id={titleId} className="font-display text-xl font-semibold text-ink">
              {teams.sentTitle}
            </h2>
            <p className="mx-auto mt-2 max-w-sm text-[15px] leading-relaxed text-ink-500">
              {teams.sentBody} <strong className="text-ink">{email.trim()}</strong>.
            </p>
            <Button variant="secondary" size="md" className="mt-6" onClick={onClose}>
              Close
            </Button>
          </div>
        ) : state === "failed" ? (
          <div className="py-4 text-center">
            <span className="mx-auto mb-4 inline-flex rounded-full border border-status-amber/30 bg-status-amber/10 p-2.5">
              <AlertTriangle className="h-5 w-5 text-status-amber" />
            </span>
            <h2 id={titleId} className="font-display text-xl font-semibold text-ink">
              {teams.failedTitle}
            </h2>
            {/* Deliberately NOT a thank-you. The enquiry did not get through,
                and saying otherwise is the exact failure the waitlist form was
                removed for. GitHub issues is already the support channel, so
                the way out costs no new address on the site. */}
            <p className="mx-auto mt-2 max-w-sm text-[15px] leading-relaxed text-ink-500">
              {teams.failedBody}
            </p>
            <div className="mt-6 flex flex-wrap justify-center gap-2">
              <a
                href={site.supportUrl}
                target="_blank"
                rel="noreferrer"
                onClick={() => capture("teams_enquiry_fallback_used", { placement })}
              >
                <Button size="md">Open a GitHub issue</Button>
              </a>
              <Button variant="secondary" size="md" onClick={onClose}>
                Close
              </Button>
            </div>
          </div>
        ) : (
          <form onSubmit={submit} noValidate>
            <h2 id={titleId} className="font-display text-xl font-semibold text-ink">
              {teams.modalTitle}
            </h2>
            <p className="mt-2 text-[15px] leading-relaxed text-ink-500">
              {teams.modalBody}
            </p>

            <div className="mt-6 space-y-4">
              <div>
                <label
                  htmlFor={emailId}
                  className="block text-sm font-medium text-ink"
                >
                  Work email
                </label>
                <input
                  ref={firstFieldRef}
                  id={emailId}
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  onBlur={() => setTouched(true)}
                  aria-invalid={touched && !emailValid}
                  aria-describedby={touched && !emailValid ? `${emailId}-err` : undefined}
                  className={cn(
                    "mt-1.5 w-full rounded-xl border bg-white px-3.5 py-2.5 text-sm text-ink outline-none transition-colors placeholder:text-ink-400 focus:border-clay",
                    touched && !emailValid ? "border-status-red" : "border-line-strong"
                  )}
                  placeholder="you@company.com"
                />
                {touched && !emailValid && (
                  <p id={`${emailId}-err`} className="mt-1.5 text-xs text-status-red">
                    Enter an email address I can reply to, like you@company.com.
                  </p>
                )}
              </div>

              <div>
                <label htmlFor={sizeId} className="block text-sm font-medium text-ink">
                  How many people
                </label>
                <div
                  id={sizeId}
                  role="radiogroup"
                  aria-label="How many people"
                  className="mt-1.5 flex flex-wrap gap-2"
                >
                  {TEAM_SIZES.map((s) => (
                    <button
                      key={s}
                      type="button"
                      role="radio"
                      aria-checked={size === s}
                      onClick={() => setSize(s)}
                      className={cn(
                        "rounded-xl border px-3.5 py-2 text-sm transition-colors",
                        size === s
                          ? "border-clay bg-clay text-white"
                          : "border-line-strong bg-white text-ink-600 hover:border-clay/50"
                      )}
                    >
                      {s}
                    </button>
                  ))}
                </div>
                {touched && !size && (
                  <p className="mt-1.5 text-xs text-status-red">Pick a rough size.</p>
                )}
              </div>

              <div>
                <label htmlFor={noteId} className="block text-sm font-medium text-ink">
                  Anything else{" "}
                  <span className="font-normal text-ink-400">(optional)</span>
                </label>
                <textarea
                  id={noteId}
                  rows={3}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  className="mt-1.5 w-full resize-y rounded-xl border border-line-strong bg-white px-3.5 py-2.5 text-sm text-ink outline-none transition-colors placeholder:text-ink-400 focus:border-clay"
                  placeholder="What you're using now, which repos, anything that would help."
                />
              </div>
            </div>

            <Button
              type="submit"
              size="md"
              className="mt-6 w-full"
              disabled={state === "sending"}
            >
              {state === "sending" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : null}
              {teams.modalCta}
            </Button>
            <p className="mt-3 text-center text-xs leading-relaxed text-ink-400">
              {teams.modalFootnote}
            </p>
          </form>
        )}
      </div>
    </div>
  );
}
