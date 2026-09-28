import type { Metadata } from "next";
import { Nav } from "@/components/layout/Nav";
import { Footer } from "@/components/layout/Footer";
import { Breadcrumbs } from "@/components/layout/Breadcrumbs";
import { PageCta } from "@/components/layout/PageCta";
import { Prose } from "@/components/ui/Prose";
import { JsonLd, breadcrumbSchema, type Crumb } from "@/components/seo/JsonLd";
import { site } from "@/lib/content";

const title = "Who makes Talyn";
const description =
  "Talyn is built by one person, in public, on the repository it manages. What that means for you, and what it is not ready for yet.";

/**
 * The page that answers "who are you?".
 *
 * Nothing on this site answered it. There was no about page, no team, no
 * company name, no location, no contact address — the only human signal
 * anywhere was a footer line about night owls. For a public-beta tool that
 * asks to sit in your merge path and push commits to your branch, that is a
 * real objection and it had no reply.
 *
 * This is also the honest substitute for social proof. With no customers to
 * name, the strongest available trust signal is being specific about who is
 * behind it and candid about what it cannot do yet — which is the same
 * register the comparison pages already use, and the reason they work.
 */
export const metadata: Metadata = {
  title,
  description,
  alternates: { canonical: "/about" },
  openGraph: {
    type: "website",
    title,
    description,
    url: `${site.url}/about`,
  },
};

const crumbs: Crumb[] = [
  { name: "Talyn", href: "/" },
  { name: "About", href: "/about" },
];

export default function AboutPage() {
  return (
    <>
      <Nav />
      <main className="container max-w-3xl pb-24 pt-28 sm:pt-32">
        <Breadcrumbs crumbs={crumbs} />

        <h1 className="mt-8 font-display text-4xl font-semibold leading-tight tracking-tight text-ink">
          {title}
        </h1>
        <p className="mt-4 text-lg leading-relaxed text-ink-600">{description}</p>

        <Prose className="mt-10">
          <p>
            Talyn is built by Tom Owers. It is not a company with a team behind
            it, and it would be easy to leave that vague on a page like this. It
            is one person, working in public, and you can watch the whole thing
            happen in{" "}
            <a href={site.githubUrl} target="_blank" rel="noreferrer">
              the repository
            </a>
            .
          </p>

          <h2>Why it exists</h2>
          <p>
            Writing code stopped being the slow part. Landing it did not. A
            change that takes twenty minutes to write spends two days being a
            pull request — a test fails for a reason nobody has read yet, the
            base branch moves underneath it, a reviewer asks for one small thing
            on a Friday afternoon. None of that is hard. All of it needs
            somebody present.
          </p>
          <p>
            Talyn is the attempt to hand that stretch to an agent without
            handing over anything else: it does not write your features, it does
            not want your API key, and it does not merge anything you have not
            flagged.
          </p>

          <h2>It is built on itself</h2>
          <p>
            The merge queue drains Talyn&rsquo;s own pull requests. The code
            reviewer reviews its own code. When something on this site says a
            Standard review takes about half an hour, that is a measurement off
            a real run, not a target — and it is published in that shape because
            promising &ldquo;a few minutes&rdquo; is how a feature that is
            working comes to feel broken.
          </p>

          <h2>What it is not ready for</h2>
          <p>
            Worth knowing before you spend an afternoon on it:
          </p>
          <ul>
            <li>
              <strong>GitHub only.</strong> No GitLab, no Bitbucket, and no near-term
              plan for either.
            </li>
            <li>
              <strong>No teams.</strong> Billing is per account, and shared
              workspaces, SSO and admin controls do not exist yet. If your
              company needs to approve a tool before you use it, Talyn probably
              does not clear that bar today.
            </li>
            <li>
              <strong>Windows installs are unsigned.</strong> SmartScreen warns on
              first install. The build is fine; the certificate has not been
              bought.
            </li>
            <li>
              <strong>It is a public beta</strong> and the terms say so. The free
              plan exists so you can find out whether it works for you before
              anybody asks you for a card.
            </li>
          </ul>

          <h2>Getting hold of me</h2>
          <p>
            Bugs, questions and arguments all go to{" "}
            <a href={site.supportUrl} target="_blank" rel="noreferrer">
              GitHub issues
            </a>
            . Everyone who uses Talyn has a GitHub account, so that is one fewer
            account than a support portal, and it keeps the answers where other
            people can find them.
          </p>
        </Prose>

        <PageCta
          placement="about"
          title="The quickest way to judge it is to point it at a red pull request."
          body="Free for three tasks at a time, on the Claude or ChatGPT subscription you already pay for."
        />
      </main>
      <Footer />
      <JsonLd data={breadcrumbSchema(crumbs)} />
    </>
  );
}
