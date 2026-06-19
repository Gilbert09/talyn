import type { Metadata } from "next";
import { LegalPage } from "@/components/layout/LegalPage";
import { site } from "@/lib/content";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description: `How ${site.name} handles your data.`,
};

export default function PrivacyPage() {
  return (
    <LegalPage title="Privacy Policy" updated="June 2026">
      <p>
        This policy explains what {site.name} (&ldquo;Talyn&rdquo;, &ldquo;we&rdquo;)
        collects, why, and what we do with it. Talyn is beta software and this policy
        will evolve as the product does — material changes will be reflected by the date
        above.
      </p>

      <h2>What we collect</h2>
      <ul>
        <li>
          <strong>Account &amp; GitHub data.</strong> When you sign in with GitHub, we
          process your GitHub identity and the pull-request, repository, and check
          metadata needed to power your dashboard.
        </li>
        <li>
          <strong>Credentials you connect.</strong> Tokens for GitHub and your chosen
          cloud-agent provider (e.g. Claude Code, PostHog Code) are stored to dispatch
          work on your behalf. We treat these as secrets and never display them back in
          full.
        </li>
        <li>
          <strong>Waitlist email.</strong> If you ask to be notified, we keep your email
          address solely to tell you about availability.
        </li>
        <li>
          <strong>Diagnostics.</strong> Basic, privacy-preserving operational data
          (timings, error counts) to keep the app healthy. We do not sell your data.
        </li>
      </ul>

      <h2>What we don&apos;t do</h2>
      <p>
        Agent runs execute in your provider&apos;s cloud under your own account — Talyn
        orchestrates them, it doesn&apos;t store or train on your source code. We
        don&apos;t sell or rent your personal data, and we don&apos;t share it except
        with the providers you explicitly connect, or where required by law.
      </p>

      <h2>Third parties</h2>
      <p>
        Talyn talks to GitHub and the cloud-agent provider(s) you connect over their
        official APIs. Your use of those services is also governed by their own privacy
        policies. The marketing site is hosted on Vercel.
      </p>

      <h2>Your choices</h2>
      <p>
        You can disconnect a provider, revoke Talyn&apos;s GitHub access at any time from
        your GitHub settings, or ask us to delete your waitlist email and account data by
        emailing{" "}
        <a href={`mailto:${site.email}`}>{site.email}</a>.
      </p>

      <h2>Contact</h2>
      <p>
        Questions about privacy? Reach us at{" "}
        <a href={`mailto:${site.email}`}>{site.email}</a>.
      </p>
    </LegalPage>
  );
}
