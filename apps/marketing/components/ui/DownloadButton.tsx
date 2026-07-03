"use client";

import { useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { buttonVariants, type ButtonProps } from "@/components/ui/button";
import { capture } from "@/lib/analytics";
import { cn } from "@/lib/utils";

const REPO = "Gilbert09/talyn";
const RELEASES_URL = `https://github.com/${REPO}/releases`;

/**
 * Resolve the newest release's Apple-silicon .dmg via the public GitHub API.
 * `/releases?per_page=1` (not `/releases/latest`) because every build is
 * currently a pre-release, which `/latest` excludes. Falls back to any .dmg,
 * then to null so the caller can open the releases page.
 */
async function resolveLatestDmg(): Promise<string | null> {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${REPO}/releases?per_page=1`,
      { headers: { Accept: "application/vnd.github+json" } }
    );
    if (!res.ok) return null;
    const releases = (await res.json()) as Array<{
      assets?: Array<{ name: string; browser_download_url: string }>;
    }>;
    const assets = releases?.[0]?.assets ?? [];
    const arm = assets.find((a) => /arm64.*\.dmg$/i.test(a.name));
    const anyDmg = assets.find((a) => /\.dmg$/i.test(a.name));
    return (arm ?? anyDmg)?.browser_download_url ?? null;
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
