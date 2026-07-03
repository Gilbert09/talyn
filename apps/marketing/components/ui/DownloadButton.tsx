"use client";

import { useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { buttonVariants, type ButtonProps } from "@/components/ui/button";
import { capture } from "@/lib/analytics";
import { cn } from "@/lib/utils";

const REPO = "Gilbert09/talyn";
const RELEASES_URL = `https://github.com/${REPO}/releases`;

type Release = {
  assets?: Array<{ name: string; browser_download_url: string }>;
};

function pickDmg(release: Release | null | undefined): string | null {
  const assets = release?.assets ?? [];
  const arm = assets.find((a) => /arm64.*\.dmg$/i.test(a.name));
  const anyDmg = assets.find((a) => /\.dmg$/i.test(a.name));
  return (arm ?? anyDmg)?.browser_download_url ?? null;
}

/**
 * Resolve the Apple-silicon .dmg to download via the public GitHub API.
 * Prefer the latest STABLE release (`/releases/latest` excludes
 * pre-releases — nightlies ship as pre-releases and shouldn't be a
 * visitor's first install); fall back to the newest release of any kind
 * while no stable tag exists yet, then to null so the caller can open the
 * releases page.
 */
async function resolveLatestDmg(): Promise<string | null> {
  const headers = { Accept: "application/vnd.github+json" };
  try {
    const stable = await fetch(
      `https://api.github.com/repos/${REPO}/releases/latest`,
      { headers }
    );
    if (stable.ok) {
      const url = pickDmg((await stable.json()) as Release);
      if (url) return url;
    }
  } catch {
    /* fall through to the newest-release fallback */
  }
  try {
    const res = await fetch(
      `https://api.github.com/repos/${REPO}/releases?per_page=1`,
      { headers }
    );
    if (!res.ok) return null;
    const releases = (await res.json()) as Release[];
    return pickDmg(releases?.[0]);
  } catch {
    return null;
  }
}

export function DownloadButton({
  children = "Download for Mac",
  size = "lg",
  variant = "primary",
  className,
}: {
  children?: React.ReactNode;
  size?: ButtonProps["size"];
  variant?: ButtonProps["variant"];
  className?: string;
}) {
  const [loading, setLoading] = useState(false);

  const onClick = async () => {
    if (loading) return;
    capture("download_click", { platform: "mac" });
    setLoading(true);
    const url = await resolveLatestDmg();
    // Navigate to the .dmg (triggers download) or the releases page as fallback.
    window.location.href = url ?? RELEASES_URL;
    // Leave the spinner up briefly; the navigation takes over.
    setTimeout(() => setLoading(false), 4000);
  };

  return (
    <button
      onClick={onClick}
      disabled={loading}
      className={cn(buttonVariants({ variant, size }), className)}
    >
      {loading ? (
        <Loader2 className="h-5 w-5 animate-spin" />
      ) : (
        <Download className="h-5 w-5" />
      )}
      {children}
    </button>
  );
}
