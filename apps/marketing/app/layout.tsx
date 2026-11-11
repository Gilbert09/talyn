import type { Metadata, Viewport } from "next";
import { Inter, Space_Grotesk, JetBrains_Mono } from "next/font/google";
import { Suspense } from "react";
import "./globals.css";
import { site } from "@/lib/content";
import { Analytics } from "@/components/analytics/Analytics";

const sans = Inter({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});
const display = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-display",
  display: "swap",
});
const mono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap",
});

// The search title names what Talyn runs and where, in under 60 characters.
// Social cards keep the headline, which reads better as a share.
const title = `${site.name}: run Claude Code and Codex in cloud sandboxes`;
const socialTitle = `${site.name}: keep your coding agents working, even when you aren't`;

export const metadata: Metadata = {
  metadataBase: new URL(site.url),
  title: {
    default: title,
    template: `%s · ${site.name}`,
  },
  description: site.description,
  // NO canonical here, deliberately. Next inherits metadata down the tree, so
  // a root `canonical: "/"` is inherited by every page that does not set its
  // own — which declares that page a duplicate of the home page and asks
  // Google not to index it. That is not hypothetical: Search Console reports
  // /checkout-success under "Alternative page with proper canonical tag" for
  // exactly this reason, and every future landing page would have joined it.
  //
  // With it absent, a page that forgets a canonical simply has none and Google
  // infers self-canonical. The failure mode becomes "no hint" instead of
  // "please de-index me". Each page sets its own; the home page's lives in
  // app/page.tsx.
  keywords: [
    "parallel coding agents",
    "Claude Code in the cloud",
    "Codex cloud sandbox",
    "cloud coding agents",
    "agent workspaces",
    "AI coding sessions",
    "merge queue",
    "AI code review",
    "scheduled AI agents",
  ],
  openGraph: {
    type: "website",
    url: site.url,
    title: socialTitle,
    description: site.description,
    siteName: site.name,
  },
  twitter: {
    card: "summary_large_image",
    title: socialTitle,
    description: site.description,
  },
  icons: {
    icon: [
      { url: "/favicon.svg", type: "image/svg+xml" },
      { url: "/favicon-32x32.png", type: "image/png", sizes: "32x32" },
      { url: "/favicon-16x16.png", type: "image/png", sizes: "16x16" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180" }],
  },
};

export const viewport: Viewport = {
  themeColor: "#f8f5f0",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${sans.variable} ${display.variable} ${mono.variable}`}>
      {/* overflow-x-clip: backstop so one over-wide element can never make
          the whole page horizontally pannable on phones. */}
      <body className="overflow-x-clip font-sans antialiased">
        <Suspense fallback={null}>
          <Analytics />
        </Suspense>
        {children}
      </body>
    </html>
  );
}
