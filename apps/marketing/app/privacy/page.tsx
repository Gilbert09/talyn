import type { Metadata } from "next";
import { LegalPage } from "@/components/layout/LegalPage";
import { site } from "@/lib/content";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description: `How ${site.name} handles your data.`,
  alternates: {
    canonical: "/privacy",
  },
};

export default function PrivacyPage() {
  return (
    <LegalPage title="Privacy Policy" updated="June 2026">
      <p>
        This Privacy Policy explains what information {site.name}
        (&ldquo;Talyn&rdquo;, &ldquo;we&rdquo;, &ldquo;us&rdquo;) collects when you
        use our website and desktop application (together, the
        &ldquo;Service&rdquo;), why we collect it, and the choices you have. By
        using the Service you agree to this policy.
      </p>

      <h2>1. Information we collect</h2>
      <ul>
        <li>
          <strong>Account &amp; GitHub data.</strong> When you sign in with
          GitHub, we process your GitHub identity (e.g. username, avatar, email)
          and the pull-request, repository, branch, and check metadata needed to
          power your dashboard.
        </li>
        <li>
          <strong>Credentials you connect.</strong> Access tokens for GitHub and
          for the cloud-agent provider you choose (e.g. Claude Code, PostHog
          Code) are stored to act on your behalf. We treat them as secrets and
          never display them back in full.
        </li>
        <li>
          <strong>Waitlist email.</strong> If you ask to be notified, we keep
          your email address solely to contact you about availability.
        </li>
        <li>
          <strong>Usage &amp; device data.</strong> Standard analytics — pages
          viewed, clicks (such as &ldquo;Download&rdquo;), approximate location
          derived from IP, browser and device type — collected via PostHog (see
          §4).
        </li>
      </ul>

      <h2>2. How we use your information</h2>
      <ul>
        <li>To provide, operate, and secure the Service.</li>
        <li>
          To dispatch the agent runs and merges you authorize, via GitHub and
          your chosen provider.
        </li>
        <li>To understand product usage and improve Talyn.</li>
        <li>To contact beta and waitlist users about availability and updates.</li>
      </ul>

      <h2>3. Legal bases (EEA/UK)</h2>
      <p>
        Where GDPR/UK GDPR applies, we process personal data under: performance
        of a contract (operating the Service you sign in to), our legitimate
        interests (securing and improving the Service), and consent (waitlist
        email and non-essential analytics, where required).
      </p>

      <h2>4. Analytics &amp; cookies</h2>
      <p>
        We use <a href="https://posthog.com">PostHog</a> for product analytics to
        understand how the site is used. It may set cookies or use similar local
        storage to measure pageviews and interactions. We do not sell your data
        or use it for cross-site advertising. Analytics is disabled entirely when
        no analytics key is configured.
      </p>

      <h2>5. How we share information</h2>
      <p>
        Agent runs execute in your chosen provider&apos;s cloud under your own
        account — Talyn orchestrates them, it does not store or train on your
        source code. We share data only with the services you connect or that we
        rely on to run the Service: <strong>GitHub</strong> (repositories and
        PRs), your <strong>cloud-agent provider</strong>, <strong>PostHog</strong>{" "}
        (analytics), and <strong>Vercel</strong> (website hosting) — or where
        required by law. Your use of those services is also governed by their own
        privacy policies. We do not sell or rent personal data.
      </p>

      <h2>6. Data retention</h2>
      <p>
        We keep personal data only as long as needed for the purposes above or as
        required by law. You can ask us to delete your account data or waitlist
        email at any time (see §8).
      </p>

      <h2>7. Security</h2>
      <p>
        We use reasonable technical and organizational measures to protect your
        data, including encrypted transport and treating connected tokens as
        secrets. No method of transmission or storage is perfectly secure.
      </p>

      <h2>8. Your rights</h2>
      <p>
        Depending on where you live, you may have rights to access, correct,
        delete, export, or restrict processing of your personal data, and to
        withdraw consent. You can revoke Talyn&apos;s GitHub access anytime from
        your GitHub settings, or contact us via{" "}
        <a href={site.supportUrl}>GitHub</a> to exercise any right.
      </p>

      <h2>9. International transfers</h2>
      <p>
        We and our providers may process data in countries other than yours.
        Where required, we rely on appropriate safeguards for such transfers.
      </p>

      <h2>10. Children</h2>
      <p>
        The Service is not directed to anyone under 16, and we do not knowingly
        collect their personal data.
      </p>

      <h2>11. Changes</h2>
      <p>
        We may update this policy as Talyn evolves; material changes will be
        reflected by the date above.
      </p>

      <h2>12. Contact</h2>
      <p>
        Questions or requests? Reach us on{" "}
        <a href={site.supportUrl}>GitHub</a>.
      </p>
    </LegalPage>
  );
}
