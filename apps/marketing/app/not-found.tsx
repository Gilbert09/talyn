import Link from "next/link";
import { Button } from "@/components/ui/button";
import { OwlMark } from "@/components/brand/Logo";
import { GridBackground } from "@/components/ui/GridBackground";

export default function NotFound() {
  return (
    <main className="relative flex min-h-screen flex-col items-center justify-center px-6 text-center">
      <GridBackground />
      <div className="relative">
        <OwlMark className="mx-auto h-16 w-16 animate-blink text-talon-300" />
        <p className="mt-6 font-mono text-xs uppercase tracking-[0.3em] text-talon-300">
          404
        </p>
        <h1 className="mt-3 font-display text-3xl font-semibold text-white sm:text-4xl">
          This branch flew the coop.
        </h1>
        <p className="mx-auto mt-3 max-w-sm text-owl-50/55">
          The page you&apos;re after isn&apos;t on the perch. Let&apos;s get you back to
          the nest.
        </p>
        <Link href="/" className="mt-8 inline-block">
          <Button>Back to home</Button>
        </Link>
      </div>
    </main>
  );
}
