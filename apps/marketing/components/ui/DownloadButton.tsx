"use client";

import { useEffect, useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { buttonVariants, type ButtonProps } from "@/components/ui/button";
import { capture } from "@/lib/analytics";
import { cn } from "@/lib/utils";

const REPO = "Gilbert09/talyn";
const RELEASES_URL = `https://github.com/${REPO}/releases`;

/**
 * One download per page, not one per button.
 *
 * MODULE scope on purpose. This started as a `useRef` per component, which
 * stops a double-click on ONE button and nothing else — and the page renders
 * up to seven of these (nav desktop, nav mobile, hero, mid CTA, pricing,
 * final CTA). A client that clicks several of them produces several events
 * from several refs, each of which has only ever seen one click.
 *
 * That is not hypothetical: in the week after the ref shipped the site still
 * recorded 1.8-2.25 `download_click` events per session, the pairs 0-1s
 * apart, and almost every one of those sessions has a replay with zero
 * recorded mouse movement. A shared latch is the only thing that sees both.
 *
 * The 4s reset is the original one and is unchanged: a download usually does
 * NOT unload the page, so a latch that only ever closes would leave every
 * button on the page dead for anyone who stays and wants another.
 */
let downloadLatched = false;

type Release = {
  assets?: Array<{ name: string; browser_download_url: string }>;
};

type PlatformKey = "mac" | "windows" | "linux";

type Platform = {
  key: PlatformKey;
  /** Substituted into the `{platform}` token in CTA copy. */
  label: string;
  /**
   * Asset name patterns, most-preferred first. electron-builder emits
   * `Talyn-<version>-arm64.dmg` / `Talyn Setup <version>.exe` /
   * `Talyn-<version>.AppImage` — see apps/desktop/package.json `build`.
   */
  patterns: RegExp[];
};

const PLATFORMS: Record<PlatformKey, Platform> = {
  // arm64 first: every Mac from 2020+ is Apple Silicon, and the browser can't
  // tell us the CPU. An Intel user who lands on the arm64 build gets a clear
  // "can't be opened" error rather than a silent mis-install, and the
  // releases page (the fallback below) carries both.
  mac: { key: "mac", label: "Mac", patterns: [/arm64.*\.dmg$/i, /\.dmg$/i] },
  windows: { key: "windows", label: "Windows", patterns: [/\.exe$/i] },
  linux: { key: "linux", label: "Linux", patterns: [/\.AppImage$/i] },
};

/**
 * Best-effort client-side OS sniff. Deliberately defaults to Mac: it's the
 * only platform that shipped before this button learned about the others, so
 * an unknown UA behaves exactly as it did before.
 */
export function detectPlatform(): Platform {
  if (typeof navigator === "undefined") return PLATFORMS.mac;
  const ua = `${navigator.userAgent} ${navigator.platform ?? ""}`;
  // Test Windows/Android before Linux — Android UAs contain "Linux".
  if (/Win(dows|32|64)/i.test(ua)) return PLATFORMS.windows;
  if (/Android/i.test(ua)) return PLATFORMS.mac;
  if (/Linux|X11/i.test(ua)) return PLATFORMS.linux;
  return PLATFORMS.mac;
}

/**
 * Is this a phone or a tablet?
 *
 * Separate from {@link detectPlatform}, which answers "which installer" and
 * has no way to say "none of them". 21% of this site's visitors are on iOS or
 * Android, every CTA was offering them a desktop binary, and because the sniff
 * above maps Android to Mac — to keep it out of the Linux branch, since
 * Android UAs contain "Linux" — an Android visitor was specifically offered a
 * .dmg.
 *
 * Coarse on purpose. A false positive costs somebody one extra click to reach
 * the download; a false negative is exactly the status quo.
 */
export function isMobileDevice(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  if (/Android|iPhone|iPod|iPad/i.test(ua)) return true;
  // iPadOS 13+ reports itself as a Macintosh; the touch-point count is the
  // documented way to tell a real Mac from an iPad pretending to be one.
  return /Macintosh/i.test(ua) && (navigator.maxTouchPoints ?? 0) > 1;
}

function pickAsset(
  release: Release | null | undefined,
  platform: Platform
): string | null {
  const assets = release?.assets ?? [];
  for (const pattern of platform.patterns) {
    const hit = assets.find((a) => pattern.test(a.name));
    if (hit) return hit.browser_download_url;
  }
  return null;
}

/**
 * Resolve the installer for `platform` via the public GitHub API. Prefer the
 * latest STABLE release (`/releases/latest` excludes pre-releases — nightlies
 * ship as pre-releases and shouldn't be a visitor's first install); fall back
 * to the newest release of any kind while no stable tag exists yet, then to
 * null so the caller can open the releases page.
 */
/**
 * Budget for BOTH calls together.
 *
 * There was no timeout at all, and the consequence was not a slow download but
 * a dead button: the 4s reset that re-enables it is scheduled only after the
 * `await` resolves, so a hung `api.github.com` left the spinner turning with
 * no way out except a page reload. The API is also rate-limited to 60 requests
 * an hour per IP when unauthenticated, which one office behind one NAT can
 * exhaust — after which every visitor from that building waits for two 403s.
 *
 * Eight seconds because the fallback is good: the releases page lists every
 * artifact for every platform, so giving up early costs one extra click and
 * waiting costs the download.
 */
const RESOLVE_TIMEOUT_MS = 8000;

/** What the resolution actually did, for the `download_resolved` event. */
type ResolveOutcome = "asset" | "releases_page";

async function resolveLatestAsset(
  platform: Platform,
  signal: AbortSignal
): Promise<string | null> {
  const headers = { Accept: "application/vnd.github+json" };
  try {
    const stable = await fetch(
      `https://api.github.com/repos/${REPO}/releases/latest`,
      { headers, signal }
    );
    if (stable.ok) {
      const url = pickAsset((await stable.json()) as Release, platform);
      if (url) return url;
    }
  } catch {
    /* fall through to the newest-release fallback */
  }
  try {
    const res = await fetch(
      `https://api.github.com/repos/${REPO}/releases?per_page=1`,
      { headers, signal }
    );
    if (!res.ok) return null;
    const releases = (await res.json()) as Release[];
    return pickAsset(releases?.[0], platform);
  } catch {
    return null;
  }
}

export function DownloadButton({
  children,
  size = "lg",
  variant = "primary",
  className,
  placement = "unknown",
}: {
  children?: React.ReactNode;
  size?: ButtonProps["size"];
  variant?: ButtonProps["variant"];
  className?: string;
  /** Which CTA this is, for the event. See `placement` in the capture below. */
  placement?: string;
}) {
  const [loading, setLoading] = useState(false);
  // Resolved after mount, never during render: the server has no navigator,
  // so sniffing inline would hydrate-mismatch. Until then every visitor sees
  // the Mac label, which is what the page rendered before this existed.
  const [platform, setPlatform] = useState<Platform>(PLATFORMS.mac);
  useEffect(() => setPlatform(detectPlatform()), []);

  // `loading` is React state, so it is still false in the closure of a second
  // click that lands before the re-render commits — which a double-click
  // always does. That guard therefore never stopped anything, and the event
  // fired twice for roughly three quarters of the people who clicked: 109
  // events from 62 people, every duplicate pair 100-500ms apart. The latch
  // above is written synchronously, so the second click sees it — from any
  // button on the page, which is the part a per-component ref could not do.
  const onClick = async (e: React.MouseEvent) => {
    // Let the browser handle a modified click as an ordinary link: this is an
    // <a> now, so cmd/ctrl/middle-click opens the releases page in a new tab
    // rather than doing nothing at all.
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();

    if (loading || downloadLatched) {
      // The latch stays — it is what stopped the site counting one press
      // twice. But a suppression that leaves no trace is indistinguishable
      // from a press that never happened, and these are exactly the
      // frustrated repeat-clicks worth seeing. Record it and drop it.
      capture("download_click_suppressed", {
        platform: platform.key,
        placement,
        trusted: e.isTrusted,
      });
      return;
    }
    downloadLatched = true;
    capture("download_click", {
      // Which CTA earned it — and what makes a duplicate diagnosable rather
      // than anonymous.
      platform: platform.key,
      placement,
      /**
       * Whether a PERSON pressed this button.
       *
       * `isTrusted` is false for a click a script dispatched with
       * `element.click()`, which is how an email link-protection sandbox
       * activates a page's primary call to action before delivering the mail.
       * Those arrive from datacentre IPs with the campaign's own `utm_content`
       * token, and three of the five recordings we have of them contain a
       * `download_click` and NO recorded click at all — rrweb sees pointer
       * events, and a synthetic click produces none.
       *
       * Not a filter: the event is still captured. A refusal that leaves no
       * trace is how the count became untrustworthy in the first place, and a
       * flag can be corrected later while a dropped event cannot.
       */
      trusted: e.isTrusted,
      /**
       * Seconds from page load to the press. Human dwell is spread; the
       * campaign-tagged presses cluster tightly at 21-30s across different
       * recipients, countries and Chrome versions, which is a render timeout
       * rather than a person deciding.
       */
      seconds_on_page: Math.round(performance.now() / 100) / 10,
    });
    setLoading(true);

    // `download_click` says somebody pressed the button; it says nothing about
    // whether a file arrived, because it fires before any of this runs. A
    // rate-limited visitor dumped on the releases page and a visitor whose
    // installer downloaded cleanly were the same event. They are not now.
    const startedAt = performance.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), RESOLVE_TIMEOUT_MS);
    let url: string | null = null;
    try {
      url = await resolveLatestAsset(platform, controller.signal);
    } finally {
      clearTimeout(timer);
    }
    const outcome: ResolveOutcome = url ? "asset" : "releases_page";
    capture("download_resolved", {
      platform: platform.key,
      placement,
      outcome,
      timed_out: controller.signal.aborted,
      resolve_ms: Math.round(performance.now() - startedAt),
    });

    // Navigate to the installer (triggers download). When there's no asset
    // for this platform — a release that predates cross-platform builds, an
    // OS we don't ship, a rate limit, or the timeout above — fall back to the
    // releases page, which lists every artifact for every platform.
    window.location.href = url ?? RELEASES_URL;
    // Leave the spinner up briefly; the navigation takes over. Reset the ref
    // with it — a download often does NOT unload the page, and a latch that
    // only ever closes would leave the button permanently dead for anyone who
    // stays and tries again.
    setTimeout(() => {
      downloadLatched = false;
      setLoading(false);
    }, 4000);
  };

  // CTA copy lives in lib/content.ts and carries a `{platform}` token so the
  // marketing voice stays in one place while the OS name stays a runtime fact.
  const label =
    typeof children === "string"
      ? children.replace(/\{platform\}/g, platform.label)
      : (children ?? `Download for ${platform.label}`);

  // An <a>, not a <button>. The installer URL is only known after the click,
  // so the href is the releases page — which makes cmd-click, middle-click and
  // "copy link address" do something sensible instead of nothing, and gives
  // the page one crawlable route to the downloads. A plain click is
  // intercepted above and gets the direct asset.
  return (
    <a
      href={RELEASES_URL}
      onClick={onClick}
      aria-disabled={loading || undefined}
      className={cn(buttonVariants({ variant, size }), className)}
    >
      {loading ? (
        <Loader2 className="h-5 w-5 animate-spin" />
      ) : (
        <Download className="h-5 w-5" />
      )}
      {label}
    </a>
  );
}
