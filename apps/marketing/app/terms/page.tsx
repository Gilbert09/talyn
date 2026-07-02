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
        These Terms of Service (&ldquo;Terms&rdquo;) govern your access to and use
        of {site.name} (&ldquo;Talyn&rdquo;, &ldquo;we&rdquo;, &ldquo;us&rdquo;),
        including our website and desktop application (the &ldquo;Service&rdquo;).
        By downloading or using the Service, you agree to these Terms.
      </p>

      <h2>1. Eligibility &amp; acceptance</h2>
      <p>
        You must be at least 16 and able to form a binding contract. If you use
        the Service on behalf of an organization, you represent that you may bind
        it to these Terms.
      </p>

      <h2>2. Beta software</h2>
      <p>
        Talyn is pre-release software provided for evaluation. It may change,
        break, lose data, or be unavailable, and features may be added or removed
        without notice. Do not rely on the beta for anything you can&apos;t afford
        to independently verify.
      </p>

      <h2>3. Your accounts &amp; credentials</h2>
      <p>
        You are responsible for the GitHub and cloud-agent accounts you connect,
        for keeping your credentials secure, and for all activity you authorize
        Talyn to perform — including dispatching agent runs and queuing merges.
        You must have the right to grant Talyn access to the repositories you
        connect.
      </p>

      <h2>4. Cloud agents &amp; costs</h2>
      <p>
        Talyn orchestrates third-party cloud-agent providers (such as Claude Code
        and PostHog Code). Your use of those providers is billed by them under
        your own account and subject to their terms. During the beta, Talyn
        itself is provided free of charge; pricing for general availability will
        be announced before the beta ends.
      </p>

      <h2>5. Acceptable use</h2>
      <ul>
        <li>Don&apos;t use the Service to violate any law or third-party right.</li>
        <li>Don&apos;t disrupt, reverse-engineer, or abuse the Service or its providers.</li>
        <li>
          Don&apos;t access repositories or accounts you aren&apos;t authorized to
          use.
        </li>
      </ul>

      <h2>6. Intellectual property</h2>
      <p>
        We retain all rights in the Service and its branding. You retain all
        rights in your own code and content; nothing here transfers ownership of
        your repositories to us.
      </p>

      <h2>7. Third-party services</h2>
      <p>
        The Service integrates GitHub and your chosen cloud-agent provider, and
        relies on hosting and analytics providers. We are not responsible for
        third-party services, and your use of them is governed by their terms and
        policies.
      </p>

      <h2>8. Disclaimer of warranties</h2>
      <p>
        The Service is provided &ldquo;as is&rdquo; and &ldquo;as available&rdquo;,
        without warranties of any kind, express or implied, including
        merchantability, fitness for a particular purpose, and non-infringement.
        We do not warrant that the Service will be uninterrupted, error-free, or
        that agent-generated changes will be correct.
      </p>

      <h2>9. Limitation of liability</h2>
      <p>
        To the fullest extent permitted by law, we are not liable for any
        indirect, incidental, special, consequential, or punitive damages, or for
        any loss arising from agent-generated changes, merges, or downtime. You
        remain responsible for reviewing what ships.
      </p>

      <h2>10. Indemnification</h2>
      <p>
        You agree to indemnify and hold us harmless from claims arising out of
        your use of the Service, your content, or your violation of these Terms.
      </p>

      <h2>11. Termination</h2>
      <p>
        You may stop using the Service at any time and revoke its access from
        GitHub. We may suspend or terminate access if you breach these Terms or to
        protect the Service.
      </p>

      <h2>12. Changes</h2>
      <p>
        We may update these Terms as Talyn evolves; continued use after a change
        means you accept the updated Terms.
      </p>

      <h2>13. Governing law</h2>
      <p>
        These Terms are governed by the laws of England and Wales, and any
        dispute arising out of or in connection with them is subject to the
        exclusive jurisdiction of the courts of England and Wales.
      </p>

      <h2>14. Contact</h2>
      <p>
        Questions? Email <a href={`mailto:${site.email}`}>{site.email}</a>.
      </p>
    </LegalPage>
  );
}
