import type { Metadata } from "next";
import { LegalPage } from "@/components/layout/LegalPage";
import { site } from "@/lib/content";

export const metadata: Metadata = {
  title: "Terms of Service",
  description: `The terms for using ${site.name}.`,
  alternates: {
    canonical: "/terms",
  },
};

export default function TermsPage() {
  return (
    <LegalPage title="Terms of Service" updated="July 2026">
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
        to independently verify. Paid plans are available during the beta; these
        beta disclaimers still apply to them.
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
        your own account and subject to their terms. Talyn&apos;s own plans and
        fees (which do not include your provider&apos;s agent-usage costs) are
        described in §5.
      </p>

      <h2>5. Fees, subscriptions &amp; refunds</h2>
      <p>
        Talyn offers a free plan (with usage limits shown in the app — currently
        up to 3 tasks running at once) and a paid &ldquo;Unlimited&rdquo;
        subscription, billed monthly or annually. Current prices and what each
        plan includes are shown in the app and on our{" "}
        <a href="/#pricing">pricing page</a>. We may change plan features,
        limits, or prices; price changes take effect from your next billing
        period and we&apos;ll give reasonable notice.
      </p>
      <p>
        Purchases are processed by our merchant of record,{" "}
        <a href="https://polar.sh">Polar</a> (Polar Software Inc.), which is the
        seller of record for the transaction — your payment details are
        collected by Polar, not by us, and each purchase is also subject to
        Polar&apos;s own terms and privacy policy. Subscriptions{" "}
        <strong>renew automatically</strong> at the end of each billing period
        (monthly or yearly, as selected) until cancelled. You can cancel anytime
        from Settings → Billing in the app or via the billing portal;
        cancellation takes effect at the end of the current billing period, and
        you keep paid features until then.
      </p>
      <p>
        Except where required by law, payments are non-refundable and we do not
        provide credits for partial billing periods. If something has gone wrong
        with a charge, contact us and we&apos;ll work it out. Nothing in these
        Terms limits your statutory rights, including any cooling-off or
        withdrawal rights that apply to you as a consumer.
      </p>

      <h2>6. Acceptable use</h2>
      <ul>
        <li>Don&apos;t use the Service to violate any law or third-party right.</li>
        <li>Don&apos;t disrupt, reverse-engineer, or abuse the Service or its providers.</li>
        <li>
          Don&apos;t access repositories or accounts you aren&apos;t authorized to
          use.
        </li>
      </ul>

      <h2>7. Intellectual property</h2>
      <p>
        We retain all rights in the Service and its branding. You retain all
        rights in your own code and content; nothing here transfers ownership of
        your repositories to us.
      </p>

      <h2>8. Third-party services</h2>
      <p>
        The Service integrates GitHub and your chosen cloud-agent provider, and
        relies on hosting and analytics providers. We are not responsible for
        third-party services, and your use of them is governed by their terms and
        policies.
      </p>

      <h2>9. Disclaimer of warranties</h2>
      <p>
        The Service is provided &ldquo;as is&rdquo; and &ldquo;as available&rdquo;,
        without warranties of any kind, express or implied, including
        merchantability, fitness for a particular purpose, and non-infringement.
        We do not warrant that the Service will be uninterrupted, error-free, or
        that agent-generated changes will be correct.
      </p>

      <h2>10. Limitation of liability</h2>
      <p>
        To the fullest extent permitted by law, we are not liable for any
        indirect, incidental, special, consequential, or punitive damages, or for
        any loss arising from agent-generated changes, merges, or downtime. You
        remain responsible for reviewing what ships.
      </p>

      <h2>11. Indemnification</h2>
      <p>
        You agree to indemnify and hold us harmless from claims arising out of
        your use of the Service, your content, or your violation of these Terms.
      </p>

      <h2>12. Termination</h2>
      <p>
        You may stop using the Service at any time and revoke its access from
        GitHub. We may suspend or terminate access if you breach these Terms or to
        protect the Service. If we terminate your access without cause while you
        have paid subscription time remaining, we&apos;ll refund the unused
        portion.
      </p>

      <h2>13. Changes</h2>
      <p>
        We may update these Terms as Talyn evolves; continued use after a change
        means you accept the updated Terms.
      </p>

      <h2>14. Governing law</h2>
      <p>
        These Terms are governed by the laws of England and Wales, and any
        dispute arising out of or in connection with them is subject to the
        exclusive jurisdiction of the courts of England and Wales.
      </p>

      <h2>15. Contact</h2>
      <p>
        Questions? Reach us on <a href={site.supportUrl}>GitHub</a>.
      </p>
    </LegalPage>
  );
}
