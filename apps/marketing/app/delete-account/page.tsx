import type { Metadata } from "next";
import { LegalPage } from "@/components/layout/LegalPage";

export const metadata: Metadata = {
  title: "Delete your Talyn account",
  description: "How to delete your Talyn account and data.",
  alternates: {
    canonical: "/delete-account",
  },
};

export default function DeleteAccountPage() {
  return (
    <LegalPage title="Delete your Talyn account" updated="November 2026">
      <h2>Delete it yourself</h2>
      <p>
        In the Talyn mobile app, open Settings → Delete account. The desktop and
        web apps do not have this option yet, so email us as described below.
      </p>

      <h2>If you cannot sign in</h2>
      <p>
        Email <a href="mailto:owerstom@googlemail.com?subject=Delete%20my%20Talyn%20account">owerstom@googlemail.com</a> from
        the email address on your GitHub account. Use the subject
        &ldquo;Delete my Talyn account&rdquo;. We delete the account within 30 days
        and reply when it is done.
      </p>

      <h2>What is deleted</h2>
      <p>
        We delete your Talyn account and the workspaces you own. This removes
        their sessions, tasks, pull request data, settings, connected
        integrations, and stored credentials. We also remove your mobile
        notification registrations.
      </p>

      <h2>What can remain</h2>
      <p>
        Account deletion removes owned workspaces. Backups, billing records,
        and external provider records can remain. Polar keeps billing records
        as merchant of record. Backups remain until they expire. GitHub, Slack,
        Anthropic, and OpenAI can keep their records. Analytics already sent to
        PostHog can remain.
      </p>

      <p>
        Read our <a href="/privacy">Privacy Policy</a> for more information.
      </p>
    </LegalPage>
  );
}
