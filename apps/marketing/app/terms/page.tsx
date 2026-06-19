import type { Metadata } from "next";
import { LegalPage } from "@/components/layout/LegalPage";
import { site } from "@/lib/content";

export const metadata: Metadata = {
  title: "Terms of Service",
  description: `The terms for using ${site.name}.`,
};

export default function TermsPage() {
  return (
    <LegalPage title="Terms of Service" updated="June 2026">
      <p>
        These terms govern your use of {site.name} (&ldquo;Talyn&rdquo;). Talyn is in
        public beta and provided on an evolving basis. By downloading or using it, you
        agree to what follows.
      </p>

      <h2>Beta software</h2>
      <p>
        Talyn is pre-release software. It may change, break, or be unavailable, and
        features can be added or removed without notice. We&apos;d genuinely love your
        feedback while we get to 1.0 — but please don&apos;t rely on the beta for
        anything you can&apos;t afford to double-check.
      </p>

      <h2>Your accounts and credentials</h2>
      <p>
        You&apos;re responsible for the GitHub and cloud-agent accounts you connect, for
        keeping your credentials secure, and for the actions you authorize Talyn to take
        on your behalf — including dispatching agent runs and queuing merges. You must
        have the right to grant Talyn access to the repositories you connect.
      </p>

      <h2>Cloud agents &amp; costs</h2>
      <p>
        Talyn conducts third-party cloud-agent providers (such as Claude Code and PostHog
        Code). Usage of those providers is billed by them under your own account and
        subject to their terms. During the beta, Talyn itself is provided free of charge;
        pricing for general availability will be announced before the beta ends.
      </p>

      <h2>Acceptable use</h2>
      <ul>
        <li>Don&apos;t use Talyn to violate any law or third-party rights.</li>
        <li>Don&apos;t attempt to disrupt, reverse-engineer, or abuse the service.</li>
        <li>
          Don&apos;t use it to access repositories or accounts you aren&apos;t authorized
          to use.
        </li>
      </ul>

      <h2>No warranty &amp; liability</h2>
      <p>
        Talyn is provided &ldquo;as is&rdquo;, without warranties of any kind. To the
        fullest extent permitted by law, we are not liable for any indirect or
        consequential damages, or for any loss arising from agent-generated changes,
        merges, or downtime. You remain responsible for reviewing what ships.
      </p>

      <h2>Changes &amp; contact</h2>
      <p>
        We may update these terms as Talyn evolves; continued use means you accept the
        current version. Questions? Email{" "}
        <a href={`mailto:${site.email}`}>{site.email}</a>.
      </p>
    </LegalPage>
  );
}
