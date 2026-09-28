import type { MockId } from "@/components/mocks/AppMocks";

/**
 * The dedicated feature pages at `/features/<slug>`.
 *
 * Structured TypeScript rather than markdown, and the reason is the mocks.
 * `content/guides/*.md` is the right pipeline for prose — it is what the
 * comparison pages use — but a markdown body cannot place a `<MockWorkflows>`
 * halfway down a section, and the in-app mocks are the strongest visual asset
 * this site has. A feature page that cannot show the feature is a worse page
 * than a slightly more awkward content file.
 *
 * Every claim here is bounded by what the product actually does today. Three
 * rules the copy in `lib/content.ts` learned the hard way and this file
 * inherits:
 *
 *  - **Only generally-available features.** `packages/shared/src/featureFlags.ts`
 *    is the ground truth and `availability` is the field that decides — NOT
 *    `fallback`, which answers the different question of what happens during a
 *    PostHog outage. `loops`, `codeReview`, `mcpServers` and `fleet` all fail
 *    closed and are all generally available. The two genuinely gated flags,
 *    `reviewRankingCandidate` and `reviewRankingExport`, are internal
 *    review-ranking research and appear nowhere below.
 *  - **Describe the shipped layout, not the intended one.** The dashboard is
 *    My PRs with a Needs-attention filter plus a separate Reviews page — not
 *    the three-bucket page an earlier draft of the homepage described.
 *  - **State the caps.** A free-plan limit discovered after download is worse
 *    than one read before it, so `planNote` is on every page that has one.
 */

export interface FeatureSection {
  heading: string;
  paragraphs: string[];
  bullets?: string[];
  mock?: MockId;
}

export interface FeaturePage {
  slug: string;
  /**
   * Short label for the nav and footer. A `title` is written for an `<h1>`,
   * where eight words reads well; in a nav column it wraps to three lines.
   * The same split `lib/guides.ts` makes with `navLabel`.
   */
  navLabel: string;
  /**
   * The kicker above the `<h1>` on the page itself.
   *
   * Deliberately allowed to restate the feature's name — "Workflows" over a
   * heading about workflows reads fine, because the heading is a sentence.
   * It is NOT a subtitle, and using it as one produces the menu that shipped
   * first: "Workflows / Workflows", "Loops / Loops", "Skills / Skills". Use
   * {@link tagline} anywhere the label is already on screen.
   */
  eyebrow: string;
  /**
   * Three to six words that say something the label does not, for the nav
   * menu and anywhere else the name appears directly above it.
   *
   * The test is simple: if it reads as a rephrasing of `navLabel`, it is
   * doing no work and the row would be better with nothing under it.
   */
  tagline: string;
  /** The `<h1>` — a promise, in the product's voice. */
  title: string;
  /**
   * The `<title>` — written for the query, not for the page. The root layout
   * appends " · Talyn", so this must not.
   */
  seoTitle: string;
  /** Meta description and hero standfirst. One job, one sentence or two. */
  description: string;
  heroMock: MockId;
  bullets: string[];
  sections: FeatureSection[];
  faq: Array<{ q: string; a: string }>;
  /** The free-plan cap, if the feature has one. Stated, never buried. */
  planNote?: string;
  /** Sibling feature slugs. */
  related: string[];
  /** Slugs of guides in `content/guides/`. */
  relatedGuides?: string[];
  /** Slugs of comparisons in `content/compare/`. */
  relatedCompare?: string[];
  /** ISO `YYYY-MM-DD`. Drives the sitemap's `lastModified`. */
  updated: string;
}

const UPDATED = "2026-09-28";

export const FEATURE_PAGES: FeaturePage[] = [
  {
    slug: "pr-dashboard",
    navLabel: "PR dashboard",
    eyebrow: "Mission control",
    tagline: "Every PR, worst first",
    title: "Every pull request, triaged. No tabs required.",
    seoTitle: "GitHub pull request dashboard — every PR in one list",
    description:
      "One live list of every pull request you have open, across every repository you connect, with the blocked ones pulled to the front. Diffs, checks and conversation without leaving the app.",
    heroMock: "dashboard",
    bullets: [
      "Live status across every repository and workspace you connect",
      "A Needs-attention filter that puts the blocked ones first",
      "Diffs, the check breakdown, and the conversation in one view",
      "Updates arrive over a websocket, so the list is current without a refresh",
    ],
    sections: [
      {
        heading: "The problem is not that GitHub is bad. It is that there is one of you and forty pull requests.",
        paragraphs: [
          "GitHub shows you a pull request very well. What it does not do is tell you which of yours needs you right now. The notifications inbox mixes a failing build into the same stream as a thumbs-up reaction. The pull request list sorts by when something was last touched, which is not the same as how much trouble it is in. So the working pattern becomes ten open tabs and a refresh key.",
          "Talyn answers a narrower question: of everything you have open, what is blocked, and what is ready. That is one list, ordered by how much it needs you, and it is the first thing on screen when you open the app.",
        ],
        mock: "dashboard",
      },
      {
        heading: "What Needs attention actually means",
        paragraphs: [
          "The filter is not a guess. A pull request is in the Needs-attention set because something concrete is true of it: a required check is failing, the branch has fallen behind its base, there is a merge conflict, a reviewer has asked for changes, or it has been approved and nothing has merged it. Each of those is a fact Talyn reads from GitHub, not a score it invented.",
          "That matters because a ranked list you do not trust is a list you stop reading. If a pull request is near the top, you can see the reason on the row.",
        ],
        bullets: [
          "Required checks failing",
          "Behind the base branch, or conflicting with it",
          "Changes requested, and not yet addressed",
          "Approved and green, and still sitting there",
        ],
      },
      {
        heading: "The whole pull request, without the round trip",
        paragraphs: [
          "Opening a row gives you the diff, the full check breakdown with the failing job's output, the review conversation, and the current review state. You can read what broke and decide what to do about it in the same place you noticed it.",
          "From there the actions are the rest of Talyn: send an agent to fix it, run one of your own playbooks against it, ask for a code review, or drop it into the merge queue if it is simply ready.",
        ],
        mock: "pr-detail",
      },
      {
        heading: "How it stays current",
        paragraphs: [
          "Talyn is a GitHub App, so the primary signal is webhooks — a push, a check completing, a review landing, all arrive as they happen and go straight to the open app over a websocket. A reconciliation pass runs behind that as a safety net, because a webhook that never arrives is a state that never updates, and a dashboard that is quietly stale is worse than no dashboard.",
          "The practical result: you do not refresh. A check that goes red goes red on your screen.",
        ],
      },
      {
        heading: "It runs where you are",
        paragraphs: [
          "There are desktop builds for macOS, Windows and Linux, and a browser app at app.talyn.dev that needs no install. Same account, same workspaces, same queue. The desktop app adds two things a browser cannot do: it reads skills from `~/.claude/skills` on your machine, and it keeps your session in the OS keychain.",
          "Two honest caveats on the downloads. The Windows installer is not yet code-signed, so SmartScreen will warn you on first install until we buy an EV certificate. And the download button offers the Apple-silicon build on a Mac — if you are on an Intel Mac, take the x64 build from the releases page instead.",
        ],
      },
    ],
    faq: [
      {
        q: "Does Talyn need admin access to my organisation?",
        a: "No. It is a GitHub App you install on the repositories you choose, and it works on a personal private repository with no organisation at all. You pick the repositories during onboarding and can change them later.",
      },
      {
        q: "Does it show pull requests I did not open?",
        a: "Your own pull requests are the main list. Review requests — every open pull request where you are a requested reviewer and have not reviewed yet — live on their own page. Workflows act on every pull request in a connected repository, including ones you did not open.",
      },
      {
        q: "Does Talyn store my source code?",
        a: "No. It talks to GitHub over the official API with credentials you supply, and the agent runs happen in a sandbox that clones the repository itself and is destroyed when the task ends.",
      },
    ],
    related: ["reviews", "fix-pull-requests", "merge-queue"],
    relatedGuides: ["claude-code-pull-requests"],
    relatedCompare: ["graphite", "conductor"],
    updated: UPDATED,
  },

  {
    slug: "code-review",
    navLabel: "Code review",
    eyebrow: "Code review",
    tagline: "Findings in the app, not on your PR",
    title: "Code review without the comment spam.",
    seoTitle: "AI code review that does not comment on your pull request",
    description:
      "Most AI reviewers announce themselves in your pull request. This one writes nothing to GitHub at all. Several reviewers read the change from different angles, a checking pass throws out what it cannot stand behind, and what is left is a short list in the app.",
    heroMock: "code-review",
    bullets: [
      "Findings live in Talyn — your pull request stays clean",
      "Read from several angles at once, then swept again for what they missed",
      "A checking pass drops the weak ones and records why it dropped them",
      "Tick what is worth fixing and Talyn pushes one commit, not a thread per finding",
    ],
    sections: [
      {
        heading: "The thing it does not do is the point",
        paragraphs: [
          "An AI reviewer that comments on your pull request has made a decision on your behalf: that its output is worth your teammates' attention. Most of the time it is not. The finding that turns out to be wrong is still there in the thread, and somebody has to reply to it, and the next reviewer scrolls past forty collapsed comments to reach the two that a human wrote.",
          "Talyn's review writes nothing to GitHub. No comments, no approval, no requested changes. That is enforced in the reviewing agent's own system prompt, not left to its judgement. The findings appear in Talyn, and the pull request looks exactly as it did before you asked.",
          "There is one thing it can put on GitHub, and only after you have asked it to fix something: a single short summary comment saying what it changed and what it left. That is off unless you turn it on.",
        ],
        mock: "code-review",
      },
      {
        heading: "Several readers, then somebody checking their work",
        paragraphs: [
          "A single pass over a diff finds the obvious things and misses the rest, because one reader with one prompt has one set of concerns. So a review runs several reviewers over the same change, each looking for something different — logic, security, reliability, tests, operability — and none of them aware of what the others found.",
          "Then two more passes. A sweep reads every reviewer's output together and looks for what they all missed, which is the largest amount of context the pipeline ever assembles. And a judging pass goes through the candidate findings and throws out everything it cannot stand behind.",
          "The judge is the part that decides whether the feature is useful. On the first real review it ran, it kept one finding out of six. A reviewer that surfaces six things when one is real has not saved you any time.",
        ],
        bullets: [
          "Reviewers who disagree are shown as reviewers who disagree — you see which lenses raised a finding",
          "Two reviewers reaching the same conclusion is recorded as agreement, not duplicated as two findings",
          "A rejected finding keeps the judge's reason, so the pass that drops most of them is auditable",
        ],
      },
      {
        heading: "How long it takes, honestly",
        paragraphs: [
          "Depth is a choice you make per review, and it is a real trade rather than a slider with no meaning behind it. Quick runs one reviewer and skips the sweep and the judge. Standard — the default — runs several reviewers plus both passes. Deep adds more reviewers, reads a large pull request in chunks, and uses the strongest model your connected subscription has.",
          "The numbers are measured, not aspirational. Quick is usually under ten minutes. Standard typically takes about half an hour. Deep can take an hour or more on a large pull request. We publish those because promising 'a few minutes' is how a feature that is working comes to feel broken.",
        ],
      },
      {
        heading: "Fixing is one commit, not a thread",
        paragraphs: [
          "Tick the findings that are worth acting on and Talyn sends an agent to make those changes and push a single commit to the branch. Not a suggestion per finding for you to click through — one commit, with the work done.",
          "There is an automatic version, and it is off by default and deliberately narrow. It will only act on a finding the judge confirmed, at or above a severity floor that defaults to blockers only, and whose quoted anchor was verified against the actual file. Each of those bounds comes from the first real review we ran, where the one finding that survived judging quoted code that was not at the line it named.",
        ],
      },
      {
        heading: "It can block a merge, if you want it to",
        paragraphs: [
          "If a review turns up a blocker — blocker severity, confirmed by the judging pass, on a review of the current head, not dismissed — the merge queue parks the pull request rather than landing it. Dismiss the finding, land a fix, or push a new commit and the queue picks it up again.",
          "Nothing about this touches your branch protection rules. It is Talyn declining to press merge, not Talyn overriding GitHub.",
        ],
      },
    ],
    faq: [
      {
        q: "Does the code review comment on my pull requests?",
        a: "No. A review writes nothing to your pull request — no comments, no approval, no requested changes. The findings appear in Talyn, grouped by how much they matter, each one saying which reviewers raised it and what it is about. You tick the ones worth fixing and Talyn pushes a single commit. The only thing it can put on GitHub is one short summary comment after a fix, saying what it changed and what it left, and that is off unless you turn it on.",
      },
      {
        q: "How long does a code review take?",
        a: "It depends how deeply you ask it to look. Quick is usually under ten minutes. Standard — the default — typically takes about half an hour, because several reviewers read the change in parallel and then a further pass goes back over the whole thing. Deep can take an hour or more on a large pull request. You pick the depth per review, so a small change does not have to wait for the thorough treatment.",
      },
      {
        q: "What happens if one of the reviewers fails?",
        a: "The review continues with what the others found. Refusing to show four good findings because a fifth agent timed out would be worse than useless. A review only fails outright when a whole phase produced nothing.",
      },
      {
        q: "Will it flag the same thing twice?",
        a: "No. Two reviewers finding the same problem is recorded as agreement on one finding, with both reviewers named. Cross-lens agreement is the strongest confidence signal the pipeline produces, so it is shown rather than collapsed.",
      },
      {
        q: "What does a review cost on the free plan?",
        a: "The free plan includes one review cycle. Reviewing a pull request on demand is available on any plan; having every new pull request reviewed automatically is part of Unlimited. Either way the run happens on the agent subscription you connect, so there is no separate token bill from us.",
      },
    ],
    planNote:
      "Free plan: one review cycle. Reviewing a pull request by hand is available on any plan; reviewing every new one automatically is part of Unlimited.",
    related: ["fix-pull-requests", "merge-queue", "skills"],
    relatedCompare: ["coderabbit", "greptile", "graphite"],
    updated: UPDATED,
  },

  {
    slug: "merge-queue",
    navLabel: "Merge queue",
    eyebrow: "The merge queue",
    tagline: "Fixes it, then lands it",
    title: "A merge queue that lands pull requests for you.",
    seoTitle: "A merge queue that fixes pull requests instead of ejecting them",
    description:
      "Flag a pull request keep-mergeable and Talyn watches it. The moment it falls behind, conflicts, or goes red, an agent fixes it. Then the queue lands it in order, the second it is green. No organisation, no admin, no Enterprise plan.",
    heroMock: "merge-queue",
    bullets: [
      "Lands ready pull requests in order, the moment they go green",
      "Rebases and clears conflicts on the way in — no manual \"update branch\"",
      "Independent pull requests merge in parallel; one slow build cannot stall the queue",
      "Auto-fixes anything that falls behind or breaks before it merges",
    ],
    sections: [
      {
        heading: "The gap between approved and merged",
        paragraphs: [
          "A pull request is approved on Tuesday. On Thursday the base branch has moved, the branch is behind, a test that passes on main fails on this diff, and the thing you already agreed to ship needs another afternoon. Nothing went wrong; time passed.",
          "A merge queue is the standard answer, and GitHub's is good. The catch is eligibility — it wants an organisation and, historically, a plan most people reading this do not have — and its behaviour when something fails is to eject the pull request back to you. That is correct for a queue whose job is to protect the base branch. It is not much help to the person now holding a broken branch.",
        ],
        mock: "merge-queue",
      },
      {
        heading: "Fix first, then merge",
        paragraphs: [
          "Talyn's queue does the fixing. When an entry falls behind its base it takes GitHub's free server-side 'Update branch' where that will work, and only spends an agent run when there is an actual conflict to resolve. When a check fails it dispatches a fix run, which pushes to the existing branch — no new pull request to reconcile.",
          "Entries that do not depend on one another drain concurrently, so one slow test suite does not hold up four unrelated changes. Stacked pull requests are handled bottom-up, and a native GitHub stack is handed over at the top rung rather than fought with.",
        ],
        bullets: [
          "Behind the base with no conflict → GitHub's own Update branch, free and instant",
          "An actual conflict → an agent resolves it and pushes",
          "A failing check → a fix run, on the same branch",
          "Green and approved → merged, in order",
        ],
      },
      {
        heading: "It gives up on evidence, not on a timer",
        paragraphs: [
          "The hard part of an automated queue is knowing when to stop. Retrying forever burns your agent subscription on a problem no agent can solve. Stopping after N attempts stops on work that was making progress.",
          "So the queue records a signature of what is currently blocking an entry. If it tries a fix and the same blocker comes back unchanged, that attempt achieved nothing and the entry parks. If a different blocker appears, that is progress — the first thing got fixed — and it keeps going. The unit is 'did anything change', not 'how many goes have we had'.",
          "It also parks, rather than retries, when an agent explicitly stands down: some gates need a person, and a run that says so is recorded as needing a human rather than as a crash.",
        ],
      },
      {
        heading: "Keep-mergeable: the part that runs overnight",
        paragraphs: [
          "Flagging a pull request keep-mergeable puts a watcher on it. It does not wait for you to notice that main moved — the moment the branch falls behind, hits a conflict, or a check goes red, the fix dispatches. When it is green again the queue lands it.",
          "This is the feature behind 'wake up to green PRs', and it is the one to try first. Flagging pull requests one at a time is free. Having every new pull request you open flagged automatically is part of Unlimited.",
        ],
      },
      {
        heading: "What it does not do",
        paragraphs: [
          "No speculative batch testing — it does not build hypothetical merge combinations ahead of time the way a large-scale queue does. No file-overlap analysis to decide which pull requests can be batched. And it cannot bypass your branch protection: if a required check or a required reviewer is missing, the queue waits, exactly as you configured GitHub to make it.",
          "If you already run GitHub's merge queue on a repository, Talyn detects the external gate and arms GitHub auto-merge instead of trying to merge around it.",
        ],
      },
    ],
    faq: [
      {
        q: "Do I need a GitHub organisation or an Enterprise plan?",
        a: "No. Talyn merges through the ordinary GitHub pull request merge API as a GitHub App you install, so it works on a personal private repository with no organisation and no admin rights.",
      },
      {
        q: "How does auto-keep-mergeable work?",
        a: "Flag a pull request and Talyn watches it. The moment it goes out of date, clashes with someone else's work, or a test starts failing, Talyn sends an agent to fix it. Once it is green again, the merge queue lands it in order. Flagging pull requests one at a time is free; having every new one flagged automatically is an Unlimited feature.",
      },
      {
        q: "Can it merge something that has not been approved?",
        a: "Only if your branch protection allows it. The queue presses merge through the normal API, so every required check and required review still applies. It cannot override rules you have set.",
      },
      {
        q: "What happens if an agent cannot fix the problem?",
        a: "The entry parks with the reason recorded, and it re-arms on its own if what is blocking it changes — a new commit, a different failure, a resolved conflict. It does not sit there retrying the same failed fix.",
      },
    ],
    planNote:
      "Free plan: three pull requests in the queue at once. The workspace default that keeps every new pull request green automatically is part of Unlimited.",
    related: ["fix-pull-requests", "pr-dashboard", "workflows"],
    relatedGuides: ["keep-pr-up-to-date", "github-merge-queue-alternative"],
    relatedCompare: ["mergify", "graphite"],
    updated: UPDATED,
  },

  {
    slug: "fix-pull-requests",
    navLabel: "Fix a PR with an agent",
    eyebrow: "Delegate the drudgery",
    tagline: "Failing tests, conflicts, review comments",
    title: "Send a cloud agent. Get back a mergeable pull request.",
    seoTitle: "Fix failing CI and merge conflicts with an AI agent",
    description:
      "Point Talyn at a pull request that is broken or out of date and an agent works out what went wrong, fixes it, and pushes to your existing branch. Watch it work, step by step. What comes back is green checks.",
    heroMock: "task-running",
    bullets: [
      "Fixes failing tests, conflicts, and review comments",
      "Pushes to your existing branch — no second pull request to reconcile",
      "Watch the run live, step by step",
      "Runs on the Claude or ChatGPT subscription you already pay for",
    ],
    sections: [
      {
        heading: "The fix is small. The loop around it is not.",
        paragraphs: [
          "A test fails on CI and passes locally. A reviewer asks for one rename. Main moved and now there is a conflict in a file you did not touch. None of these are hard. What they cost is the loop: pull the branch, reproduce it, change one thing, push, wait eleven minutes for CI, find out you were wrong.",
          "Talyn hands that loop to an agent. You press fix on the row; it clones the branch in a sandbox, reads the failing job's output, works out what is wrong, makes the change, and pushes to the same branch. Your pull request goes green in place.",
        ],
        mock: "task-running",
      },
      {
        heading: "You can watch, but you do not have to",
        paragraphs: [
          "The run streams into the app as it happens — the commands, the files it touched, the reasoning. That matters the first few times, when you are deciding whether to trust it, and it matters again when something goes strangely.",
          "After that, the point is not to watch. The merge queue and keep-mergeable exist so that the common cases never need you at all: something breaks, a fix dispatches, the pull request lands, and the first you hear of it is that it merged.",
        ],
      },
      {
        heading: "Three kinds of work",
        paragraphs: [
          "Fixing a pull request is one of three things you can send. A review response reads the conversation and addresses what reviewers actually asked for. And a freeform task takes a prompt and a repository and opens a pull request of its own.",
        ],
        bullets: [
          "Fix this pull request — failing checks, conflicts, a branch that fell behind",
          "Respond to review — read the thread, make the changes, push",
          "Do this thing — a prompt against a repository, which opens its own pull request",
        ],
      },
      {
        heading: "When it stops, it says why",
        paragraphs: [
          "Some things an agent should not decide. A merge gate that your repository's policy says a human must clear. A credential the sandbox does not have. A product question with two defensible answers.",
          "A run that stops for one of those reasons is recorded as needing a human, with the agent's own explanation, and it is deliberately not recorded as a failure. The difference matters: a failure is indistinguishable from a crash, and both of Talyn's retry loops will stand down on a stated refusal rather than spending three more runs discovering the same thing.",
        ],
      },
      {
        heading: "Where the run actually happens",
        paragraphs: [
          "On Talyn Fleet, each task gets its own Firecracker microVM on our hardware, running on your Claude or ChatGPT subscription. The credentials are attached by a proxy outside the machine, so no token is ever inside the box running your code, and the machine is destroyed when the task ends. With PostHog Code the run happens in their cloud under your own account instead.",
        ],
      },
    ],
    faq: [
      {
        q: "Does it open a new pull request, or fix the one I have?",
        a: "It pushes to the existing branch. There is no second pull request to reconcile, and your review history stays in one place.",
      },
      {
        q: "Which model does it use?",
        a: "Whichever agent subscription you connect. Sign in with Claude and it runs Claude on your Pro or Max plan; sign in with ChatGPT and it runs Codex on your Plus or Pro plan. You can pick per task, and the model you choose determines the vendor.",
      },
      {
        q: "How many can I run at once?",
        a: "Three on the free plan, counted across all your workspaces. Unlimited removes the cap. Automation that hits the cap — a merge-queue fix, say — is deferred server-side rather than dropped.",
      },
      {
        q: "Can it push to someone else's branch?",
        a: "Only where GitHub lets it, which is the usual maintainer-edit permission on a fork or a branch in a repository it has access to. Talyn does not work around branch permissions.",
      },
    ],
    planNote: "Free plan: three tasks running at once, across all your workspaces.",
    related: ["merge-queue", "agents", "code-review"],
    relatedGuides: ["fix-failing-github-actions-with-ai"],
    relatedCompare: ["devin", "cursor-background-agents"],
    updated: UPDATED,
  },

  {
    slug: "workflows",
    navLabel: "Workflows",
    eyebrow: "Workflows",
    tagline: "Rules that run themselves",
    title: "Write the rule once. It runs on every pull request.",
    seoTitle: "GitHub pull request automation without writing YAML",
    description:
      "When this happens on a pull request, do these things. Label it, request a reviewer, post a comment, send an agent to fix it, or drop it in the merge queue. It watches every pull request in your repositories — including ones you did not open — and it runs with the app closed.",
    heroMock: "workflows",
    bullets: [
      "Triggers on what actually happens: opened, checks failed, review requested, approved, commented, merged",
      "Narrow it with conditions — this repository, this base branch, this label, this author, drafts or not",
      "Actions that do real work: labels, reviewers, comments, a skill or prompt run, the merge queue",
      "Every run is logged, per rule, so you can see what fired and what it did",
    ],
    sections: [
      {
        heading: "The decision you keep making",
        paragraphs: [
          "Every time a pull request touches the migrations directory you add the database reviewer. Every time CI fails on a dependency bump you send an agent at it. Every time something is approved and green you queue it. None of these are decisions any more — they are a rule you are executing by hand because nowhere holds it.",
          "A workflow is that rule, written down once, in the app. No YAML, nothing committed to the repository, and nothing that needs the app to be open.",
        ],
        mock: "workflows",
      },
      {
        heading: "It reads the event, not your list",
        paragraphs: [
          "A workflow fires off the GitHub webhook payload, not off Talyn's own list of tracked pull requests. That is a deliberate design choice and it is what makes the feature worth having: a rule applies to every pull request in a repository you have connected, including ones you did not open and ones nobody has looked at yet.",
          "Where the event does not carry a fact — an issue comment payload describes an issue, so it has no base branch — a condition on that fact fails rather than quietly passing. A gate that passes when it cannot see is not a gate.",
        ],
      },
      {
        heading: "What a rule can do",
        paragraphs: [
          "The actions are the things you would otherwise do by hand, plus the things only Talyn can do.",
        ],
        bullets: [
          "Add labels, request reviewers, set assignees",
          "Post a comment, with the pull request's own details interpolated",
          "Add it to My PRs, so it shows up on your dashboard",
          "Run one of your skills, or a freeform prompt, as a cloud agent task",
          "Add it to the merge queue",
        ],
      },
      {
        heading: "The guards, because automation that loops is expensive",
        paragraphs: [
          "Two of them. Talyn ignores events its own GitHub App produced, so a rule that adds a label does not then fire on the label it just added. And each pull request has a ceiling on how many workflow runs it can trigger in an hour, defaulting to five, with the refusal announced once rather than silently.",
          "A rate-limited action is parked and retried when the limit clears, not lost — and the retry re-runs only the actions that had not already succeeded, so a rule whose comment posted and whose label was gated does not comment twice.",
        ],
      },
      {
        heading: "Merging is the queue, deliberately",
        paragraphs: [
          "The merge action adds the pull request to Talyn's merge queue rather than calling merge directly. A direct merge on a gated base branch just fails, and a rule that fails silently once a week is worse than no rule. Going through the queue means the pull request waits properly, gets fixed if it breaks, and lands when it is genuinely ready.",
        ],
      },
    ],
    faq: [
      {
        q: "What are workflows?",
        a: "Rules you set up once that run on their own: when this happens on a pull request, do these things. Pick the trigger, narrow it with conditions, and pick the actions. They watch every pull request in the repositories you connect, including ones you did not open, and they keep running with the app closed.",
      },
      {
        q: "Do they need anything committed to my repository?",
        a: "No. A workflow lives in Talyn, not in your repository. There is no YAML file, nothing to review, and turning one off does not need a pull request.",
      },
      {
        q: "Can a workflow run one of my skills?",
        a: "Yes, as long as the skill is one the backend can read — committed in the repository or saved to your workspace. Skills that only exist in ~/.claude/skills on your machine are refused when you save the rule, because the server cannot see your disk.",
      },
      {
        q: "Does disabling a workflow free up a slot on the free plan?",
        a: "No. The cap counts rules you have defined, not rules that are switched on, because counting only the enabled ones would make the cap a toggle — keep twelve, run three, swap whenever. Deleting a workflow frees the slot.",
      },
    ],
    planNote:
      "Free plan: three workflows. The cap counts rules you have defined, not the ones that are enabled.",
    related: ["loops", "merge-queue", "skills"],
    relatedCompare: ["mergify"],
    updated: UPDATED,
  },

  {
    slug: "loops",
    navLabel: "Loops",
    eyebrow: "Loops",
    tagline: "Prompts on a schedule",
    title: "Work that happens on a schedule, not on a trigger.",
    seoTitle: "Run an AI coding agent on a schedule, on your own repository",
    description:
      "A prompt, a repository, an agent, and a time. Sweep yesterday's failing checks every weekday morning. Keep dependencies current every Monday. Draft the release notes every Friday at five. It opens a pull request when the work warrants one.",
    heroMock: "loops",
    bullets: [
      "Say when in plain terms — hourly, daily, weekdays, weekly — or a cron expression if you want one",
      "Runs in your timezone, so 09:00 stays 09:00 when the clocks change",
      "Every run is logged, including the ones skipped because the last was still going",
      "Start one by hand any time, without waiting for its next turn",
    ],
    sections: [
      {
        heading: "Not everything is a reaction",
        paragraphs: [
          "A workflow fires because something happened. A loop fires because it is Monday. That sounds like a small distinction and it is the whole difference between automation that keeps up with you and automation that does the work nobody ever gets to.",
          "The dependency bump nobody schedules. The flaky test sweep everyone agrees is worth doing. The release notes somebody writes on a Friday afternoon from the commit log. Each one is a prompt you could write in a minute and will not run consistently for a year.",
        ],
        mock: "loops",
      },
      {
        heading: "A loop is four choices",
        paragraphs: [
          "The repository, the prompt, the agent and model, and the schedule. That is the whole editor. When it fires, it creates an ordinary cloud task — the same kind the fix button creates — so the transcript, the pull request link and the plan limits all work exactly as they do everywhere else. What loops add is the clock.",
        ],
        bullets: [
          "Hourly, daily, weekdays, weekly — or a raw cron expression",
          "Your timezone, correctly, including across daylight saving",
          "Pick the agent per loop: Claude, Codex, or PostHog Code",
          "Choose what happens if the last run is still going — skip is the default",
        ],
      },
      {
        heading: "Missed occurrences fire once, not six times",
        paragraphs: [
          "If Talyn is down or deploying when a loop is due, it catches up — once — and then carries on from now. It does not replay every occurrence it missed, because six near-identical tasks at once is not what anybody wanted, and on a free plan it would be one run and five refusals.",
          "Re-enabling a loop you switched off is a resume, not a backfill. It starts from the next occurrence.",
        ],
      },
      {
        heading: "The internet switch, off by default",
        paragraphs: [
          "A loop's sandbox normally reaches its repository and its agent's API and nothing else. That is not a limitation we ran into; it is deliberate. A prompt that has just read untrusted pull request text should not have a route out to post it somewhere.",
          "Some jobs genuinely need the web — checking an upstream changelog, reading an advisory. So internet access is a per-loop switch, off unless you turn it on, and the posture travels with the task rather than the loop, so a run that is retried later gets the setting it was created with. The choice is offered as 'Repository only' or 'Allow the internet'; you never have to think about routing tables. It is available on Talyn Fleet only.",
        ],
      },
      {
        heading: "When the subscription runs out",
        paragraphs: [
          "A scheduled run that fires at 3am and hits an exhausted monthly quota should not just fail. If your Claude subscription is spent, Talyn moves that run to your Codex subscription if you have one, and then to PostHog Code. The exhaustion is remembered, so the next loop does not boot a machine to learn the same thing, and it is cleared by proof — a successful run, a fresh sign-in, or the vendor's own stated reset time.",
          "A rate limit is treated differently and deliberately: that clears by waiting, and moving off it would spend money to avoid a short pause.",
        ],
      },
    ],
    faq: [
      {
        q: "What are loops?",
        a: "Prompts that run on a schedule instead of waiting for something to happen. Pick a repository, write what you want done, and say when — hourly, daily, weekdays, weekly, or a cron expression — and an agent runs it on its own, opening a pull request when the work warrants one.",
      },
      {
        q: "Do schedules survive the clocks changing?",
        a: "Yes. Schedules run in your own timezone, so 09:00 daily stays 09:00 to you across daylight saving. That is the one part of scheduling nobody hand-rolls correctly, so Talyn does not.",
      },
      {
        q: "What if a run is still going when the next one is due?",
        a: "That is a per-loop setting, and skipping is the default — the skipped occurrence is recorded in the history rather than silently dropped. It is also what makes a tight schedule self-limiting, which is why there is no minimum interval.",
      },
      {
        q: "Does the free plan's three-loop cap count runs?",
        a: "No, it counts schedules. Each firing creates an ordinary cloud task, which is bounded by the three-active-tasks cap instead. The two caps compose rather than overlap.",
      },
    ],
    planNote:
      "Free plan: three loops. The cap counts schedules, not runs — each firing is an ordinary task and counts against the task limit.",
    related: ["workflows", "fix-pull-requests", "agents"],
    updated: UPDATED,
  },

  {
    slug: "skills",
    navLabel: "Skills",
    eyebrow: "Skills",
    tagline: "Your playbooks, on any PR",
    title: "Your playbooks, runnable on any pull request.",
    seoTitle: "Run your Claude SKILL.md playbooks against a pull request",
    description:
      "A security sweep, your team's review checklist, a changelog writer. Talyn finds the skills you already have — in the repository, in ~/.claude/skills, or saved to your workspace — and runs one against any pull request with a click.",
    heroMock: "skill-picker",
    bullets: [
      "Picks up SKILL.md files from the repository, your machine, and your workspace",
      "Searchable picker with your most-used skills on top",
      "Output lands on the pull request: one review comment, or commits to the branch",
      "The same format Claude Code uses — if you have skills, they already work",
    ],
    sections: [
      {
        heading: "You have written the instructions already",
        paragraphs: [
          "Most teams have a review checklist. Somebody has written down what to look for in a migration, or what a good changelog entry contains, or the six things that have caused an incident before. It lives in a wiki page nobody opens, or in one person's head.",
          "A skill is that written down in the standard SKILL.md format — the one Claude Code uses — and made runnable. Pick a pull request, pick a skill, and a cloud agent follows the playbook against that change.",
        ],
        mock: "skill-picker",
      },
      {
        heading: "Three places, no setup",
        paragraphs: [
          "Talyn looks for skills where they already are rather than asking you to import them. Committed in the repository, so the whole team gets them and they version with the code. Sitting in `~/.claude/skills` on your machine, which is where yours probably already are. Or saved to your workspace, for the ones that are not repository-specific and are not just yours.",
          "One caveat worth knowing before you rely on it: reading `~/.claude/skills` needs the desktop app, because the browser cannot see your disk. Skills used by a workflow or a loop have to be repository or workspace ones for the same reason — those run on the server, with the app closed.",
        ],
        bullets: [
          "In the repository — versioned with the code, shared with the team",
          "In ~/.claude/skills — desktop app only",
          "Saved to the workspace — shared, and reachable by workflows and loops",
        ],
      },
      {
        heading: "What comes back",
        paragraphs: [
          "It depends what the skill asks for. A review-shaped skill posts a single review comment on the pull request. A fix-shaped skill commits to the branch. Either way it is one artefact, not a running commentary — the same restraint the code review feature is built around.",
          "Skills compose with the rest of Talyn: a workflow can run one automatically when a pull request opens, and a loop can run one on a schedule.",
        ],
      },
    ],
    faq: [
      {
        q: "What are skills?",
        a: "Saved instructions you can re-run — a review checklist, a security pass, a changelog writer. Write one once and run it on any pull request with a click. Talyn finds the ones already in your project or on your machine, in the standard SKILL.md format, so if you use Claude Code you likely have some already.",
      },
      {
        q: "Do I have to write them in a special format?",
        a: "No, it is the standard SKILL.md format. A skill is a markdown file with some frontmatter. Nothing about it is Talyn-specific, and skills you write for Talyn work in Claude Code too.",
      },
      {
        q: "Can a workflow or a loop run a skill?",
        a: "Yes, as long as it is a repository or workspace skill. A skill that only exists in ~/.claude/skills is refused when you save the rule, because the backend genuinely cannot read your machine — a rule that failed silently at 3am would be worse than one that refuses while you are looking at it.",
      },
    ],
    planNote:
      "Free plan: skills themselves are uncapped. Running one is an ordinary cloud task, so the three-concurrent-task limit is the brake.",
    related: ["code-review", "workflows", "fix-pull-requests"],
    relatedGuides: ["claude-code-pull-requests"],
    updated: UPDATED,
  },

  {
    slug: "reviews",
    navLabel: "Review requests",
    eyebrow: "Reviews",
    tagline: "Everything waiting on you",
    title: "Every review request, in one list.",
    seoTitle: "One list of every GitHub pull request waiting on your review",
    description:
      "The pull requests waiting on you are scattered across repositories and buried in notifications. Talyn keeps them on one page, tells you whether you were asked directly or through a team, and lets you save the filter you use.",
    heroMock: "reviews",
    bullets: [
      "Every repository you have connected, one list, nothing to chase",
      "See whether you were asked directly or through a team — and filter by it",
      "Save a filter you use often, per workspace",
      "Run one of your review playbooks on any of them with a cloud agent",
    ],
    sections: [
      {
        heading: "Review requests do not have a home",
        paragraphs: [
          "GitHub will tell you that you have been added as a reviewer. It tells you in the same notifications inbox as everything else, once, and then the information decays. The search that finds them all requires you to remember the syntax, and it does not distinguish between the pull request somebody assigned to you personally and the fifty your team is nominally on.",
          "Talyn keeps one page: every open pull request where you are a requested reviewer and have not reviewed yet, across every repository you have connected.",
        ],
        mock: "reviews",
      },
      {
        // The ordering, and what it is careful NOT to claim.
        //
        // Priority is the default sort and generally available
        // (`reviewPriority`, fallback true). What is NOT established is that
        // any learned model beats a plain newest-request-first sort:
        // docs/REVIEW_RANKING.md has the validation-selected CatBoost tying
        // request recency exactly (85.53% vs 85.53%) on the replay, says "no
        // new model qualifies for production", and warns in terms against
        // claiming a gain from those numbers. The candidate model behind
        // `reviewRankingCandidate` is `availability: 'gated'`.
        //
        // So: no accuracy claim, no "smart", no "AI ranking". What these
        // sections describe instead is the part that is shipped and provable
        // — the four bands from `PR_PRIORITY_GATE_RANK`, the named terms
        // inside one, and a reason on every row.
        //
        // The per-viewer term IS real and shipped and is described, bounded
        // exactly as the code bounds it: `learnedCap` 12, deliberately under
        // the age ramp's 16 so affinity cannot bury a row forever; installed
        // only past `REVIEW_RANK_MIN_EVENTS` (150) AND a measured held-out
        // lift. That is a different thing from the gated pooled candidate,
        // which is the one the research could not separate from recency.
        heading: "The order explains itself",
        paragraphs: [
          "The default sort is Priority, and the thing to know about it is that it is not a mystery score. Every row carries a chip saying why it is where it is — \"Asked directly\", \"Waited 3d\", \"All checks green\", \"Unblocks others\", \"Draft\", \"Conflicts\". Hover it and you get the full arithmetic, every term with its points. If you disagree with a placement you can see exactly what caused it, which is the difference between a ranked list you keep using and one you quietly stop reading.",
          "Underneath, the list is cut into four bands before anything is scored. Pull requests that other work is stacked on, or that are queued to merge, come first — somebody besides the author is waiting on those. Then everything you could simply review. Then the ones where the ball is back with the author: conflicts, failing checks, changes already requested, because reviewing those now duplicates work they are already doing. Last, the ones that are not ready — drafts, and anything an agent is mid-way through pushing to.",
          "The bands are a hard partition, and that is the point. Scoring inside a band can never promote a draft above a pull request that needs nothing but your approval, which is exactly what a single additive score does the first time forty small nudges add up.",
        ],
        bullets: [
          "Blocking others — something is stacked on it, or it is queued to merge",
          "Actionable — you could review it right now",
          "Waiting on the author — conflicts, failing checks, changes requested",
          "Not ready — a draft, or an agent is pushing to it",
        ],
      },
      {
        heading: "What moves a pull request up, and what is capped",
        paragraphs: [
          "Inside a band the ordering is ordinary arithmetic on things that are true right now. All checks green, everyone else has approved and only you are left, a human put your name on it rather than a team, the diff is small, you asked for changes and were re-requested — each of those is worth points, and each is nameable, which is why the chip can say one word. Machine-authored pull requests are pushed down hardest of anything that is not a band.",
          "Waiting counts too, and it stops counting on purpose. The wait bonus climbs for about five days, holds to a fortnight, then drops away — because an ever-growing age bonus turns the list into a graveyard sorted by neglect, where the thing nobody will ever review is permanently first.",
          "There is a personal term, and it is deliberately small. Talyn learns who you actually review, whose pull requests you tend to be reciprocated on, and which parts of the tree you know — from your own review history, per workspace. It only switches on after about 150 reviews, and only if it measurably beats the default on your own held-out history; until then everyone gets the same hand-set starting point. It is capped at twelve points, which is below the maximum the waiting bonus can reach, and that gap is the whole safety argument: familiarity can reorder your queue but can never bury something indefinitely.",
        ],
        bullets: [
          "Green checks, last approval outstanding, asked directly, small diff, re-review",
          "Down-weighted: bot authors, unresolved threads somebody else opened, checks still running, very large diffs",
          "A waiting bonus that peaks and then decays, so neglect cannot pin a row to the top",
          "A personal term capped below the waiting bonus, off until it is proven on your own history",
        ],
      },
      {
        heading: "It never reads your code",
        paragraphs: [
          "The ranker cannot see a pull request title, its description, its diff, or a single comment. The complete list of what it is allowed to look at is structural: draft or not, author, when it was created, mergeable state, what is blocking it, the review decision, check counts, how many threads are unresolved and who opened them, how many lines changed, whether you were asked directly or through a team, and the top-level directories touched.",
          "That is not an oversight, it is the design. Ordering that depends on what a pull request says is ordering you cannot predict and cannot argue with — and it would mean shipping your code somewhere to sort a list.",
        ],
      },
      {
        heading: "Who asked matters",
        paragraphs: [
          "Being named as a reviewer and being in a team that was named are different requests with different urgency, and a list that treats them the same is a list you learn to ignore. Talyn shows which it was, and lets you filter to one team when you are doing a review round for a specific area.",
          "A filter you use every morning can be saved, per workspace, so it is one click rather than four.",
        ],
        bullets: [
          "Requested of you directly",
          "Requested of a team you are in — and which team",
          "Filter to one team, and save the filter",
        ],
      },
      {
        heading: "Reviewing from the list",
        paragraphs: [
          "Opening a row gives you the diff, the checks and the conversation without a round trip to the browser. From there you can run one of your own review playbooks against it as a cloud agent task, or run a full code review whose findings stay in the app rather than landing as comments on somebody else's pull request.",
        ],
      },
    ],
    faq: [
      {
        q: "Does it show pull requests I have already reviewed?",
        a: "No. The list is what is still waiting on you — open pull requests where you are a requested reviewer and have not reviewed yet. Once you review, it leaves the list.",
      },
      {
        q: "Does it cover pull requests outside my own repositories?",
        a: "It covers every repository you have connected to the workspace. If you are asked to review in a repository Talyn is not installed on, it will not appear.",
      },
      {
        q: "Can I review without leaving Talyn?",
        a: "You can read the diff, the checks and the conversation in the app, and run an agent review against it. Submitting the review itself still happens on GitHub.",
      },
      {
        q: "How is the Priority order decided?",
        a: "By live state, not by guessing. The list is cut into four bands — blocking others, actionable, waiting on the author, not ready — and only then finely ordered inside each band by things like whether you were asked directly, how long it has waited, and whether the checks are green. Every row shows a chip naming the reason it is where it is.",
      },
      {
        q: "Does it learn from me?",
        a: "A little, late, and within a hard ceiling. Talyn notices whose pull requests you review, who reviews yours, and which directories you know, from your own history in that workspace. It only switches on after about 150 reviews and only if it beats the default on your own held-out history, and it is capped below the waiting bonus so familiarity can reorder your queue but never bury anything indefinitely. Until then you get the same starting point as everyone else.",
      },
      {
        q: "Can it see my code?",
        a: "No. The ranker never reads a pull request's title, description, diff or comments. It looks only at structural facts — draft state, checks, review decision, unresolved thread counts, lines changed, who requested you, and the top-level directories touched.",
      },
      {
        q: "What if I just want newest first?",
        a: "Then use it. The sort control cycles Newest, Oldest and Priority, and it remembers what you picked. Priority is the default because most people leave it on, not because the other two are hidden.",
      },
    ],
    planNote:
      "Free plan: the Reviews list is uncapped. Running an agent against one of them is an ordinary task and counts toward the three-task limit.",
    related: ["pr-dashboard", "code-review", "skills"],
    updated: UPDATED,
  },

  {
    slug: "agents",
    navLabel: "Agents & Talyn Fleet",
    eyebrow: "Agents",
    tagline: "Your own Claude or ChatGPT plan",
    title: "No lock-in. Use the agent you already pay for.",
    seoTitle: "Run Claude or Codex on your own subscription, in a sandbox",
    description:
      "Sign in with Claude or ChatGPT and every task runs on that subscription — no API key, no metered credits, no second bill for tokens. Each task gets a fresh microVM, and the credentials are attached from outside it.",
    heroMock: "onboarding",
    bullets: [
      "Runs on your Claude Pro or Max plan, or your ChatGPT Plus or Pro plan",
      "A fresh Firecracker microVM per task, destroyed when the task ends",
      "Credentials attached by a proxy outside the machine — no token inside the box running your code",
      "Switch agent per task; PostHog Code is supported too",
    ],
    sections: [
      {
        heading: "You are already paying for a coding agent",
        paragraphs: [
          "Most tools in this space resell you inference. You connect an API key, or you buy their credits, and every run is a second bill on top of the Claude or ChatGPT subscription you already have sitting idle most of the day.",
          "Talyn conducts agents rather than replacing them. You sign in with Claude or with ChatGPT, and the work runs on that plan. There is one flat price for Talyn and nothing metered on top of it.",
        ],
        mock: "onboarding",
      },
      {
        heading: "Talyn Fleet: where the work happens",
        paragraphs: [
          "Claude and Codex tasks run on Talyn Fleet — Firecracker microVMs on our own hardware. Every task gets a fresh machine, and the machine is destroyed when the task ends.",
          "The credential handling is the part worth understanding, because it is the bit that is genuinely different. Your subscription token is never placed inside the sandbox. The machine talks to a proxy, and the proxy attaches the credential on the way out. So an agent that reads a hostile repository and decides to exfiltrate your token has nothing in its environment to find.",
          "The egress route table is built per task from the model you picked, which means a Codex run has no network route to Anthropic's API at all, and vice versa. Not a policy — no route.",
        ],
      },
      {
        heading: "Picking an agent is picking a model",
        paragraphs: [
          "There is no separate 'which vendor' field, deliberately. You choose a model, and the model determines the vendor, the credential and the routing. A second field would be a second source of truth that could disagree with the first.",
          "You can set a workspace default, or choose 'ask every time' and pick per task from the row itself.",
        ],
        bullets: [
          "Claude — on your Claude Pro or Max plan",
          "Codex — on your ChatGPT Plus or Pro plan",
          "PostHog Code — in your own PostHog project",
        ],
      },
      {
        heading: "What happens when a plan runs out",
        paragraphs: [
          "A monthly quota that is spent is a different problem from a credential that is broken, and Talyn treats them differently. A revoked or expired grant fails visibly and asks you to reconnect, because somebody who chose to run on their own subscription should not be quietly moved onto metered credits to fix it.",
          "An exhausted quota is just the month running out, and the work is still wanted — so that run moves to your other subscription if you have one, and then to PostHog Code. Each hop is recorded on the task. The exhaustion is remembered so the next task does not boot a machine to discover the same thing, and the hold clears on the vendor's own stated reset time, a successful run, or a fresh sign-in.",
        ],
      },
      {
        heading: "What we do not offer",
        paragraphs: [
          "Claude Code is not a provider. It was one, and it was removed: it billed metered API credits, which is the opposite of what this page is about. Running Claude on the fleet, on your own subscription, is what replaced it.",
          "Codex Cloud is deferred — OpenAI ships no server-to-server API for it, only a CLI and a GitHub mention flow. Running Codex on the fleet works and is a different thing.",
          "And the fleet is finite hardware. It paces itself, and it spills to the fall-back provider when it is full, but nobody should read this page as a promise of unlimited parallelism.",
        ],
      },
    ],
    faq: [
      {
        q: "Which AI agents does Talyn use?",
        a: "You bring your own. Sign in with Claude or ChatGPT and Talyn Fleet runs your tasks on that subscription — no separate API bill. PostHog Code is supported too. Talyn conducts whichever one you connect, and you can switch per task.",
      },
      {
        q: "Where does the work actually happen?",
        a: "On Talyn Fleet, each task runs in its own Firecracker microVM on our hardware, using your agent subscription. The VM reaches your repository and your agent through a proxy that attaches the credentials from outside, so no token is ever inside the machine running the code, and the VM is destroyed when the task ends. With PostHog Code the run happens in their cloud under your account instead.",
      },
      {
        q: "Do I need an API key?",
        a: "No. You sign in with Claude or with ChatGPT and Talyn uses that subscription. An API key would mean metered credits, which is the bill this is designed to avoid.",
      },
      {
        q: "Is my code safe?",
        a: "Talyn talks to GitHub and your chosen provider over their official APIs using credentials you supply. The run happens in a sandbox that is destroyed afterwards, your subscription token is never inside it, and Talyn never stores your source.",
      },
    ],
    planNote:
      "Free plan: connect as many providers as you like — the cap is on tasks running at once, never on agents connected.",
    related: ["fix-pull-requests", "mcp-servers", "loops"],
    relatedCompare: ["devin", "codex-cloud", "cursor-background-agents"],
    updated: UPDATED,
  },

  {
    slug: "mcp-servers",
    navLabel: "MCP servers",
    eyebrow: "MCP servers",
    tagline: "Linear, Sentry, Supabase, your own",
    title: "Give the agent your tools, not your keys.",
    seoTitle: "Connect MCP servers to a cloud coding agent, safely",
    description:
      "Connect Linear, Sentry, Supabase or your own MCP server and every fleet run can use it. Talyn holds the credential and attaches it per request from outside the sandbox, so the agent never sees a token it could leak.",
    heroMock: "task-running",
    bullets: [
      "Linear, Sentry, Supabase, Stripe, or any remote MCP server you run",
      "The credential stays with Talyn — the sandbox gets a plain URL with no token on it",
      "A per-server tool allow-list, so a server can be connected without being fully exposed",
      "Uncapped on every plan, including free",
    ],
    sections: [
      {
        heading: "An agent fixing a bug should be able to read the bug",
        paragraphs: [
          "A run that is responding to a review comment referencing a Linear ticket, or fixing a crash that has a Sentry issue, is working with one hand tied behind its back if it cannot open either. MCP is the standard answer to that, and connecting one to a cloud sandbox is where it usually gets uncomfortable.",
          "The uncomfortable part is the credential. Handing your Linear API key to a machine that is about to check out a repository and execute code from it is a bet on that code being friendly.",
        ],
      },
      {
        heading: "Talyn holds the credential, and the sandbox never does",
        paragraphs: [
          "The guest is configured with a plain URL that carries no token at all. When the agent calls a tool, the request goes to the host's proxy, and the proxy attaches the secret on the way out. An agent that has just read a hostile repository and decided to exfiltrate your Linear key has nothing in its environment to find.",
          "This is the same shape as how your Claude or ChatGPT subscription token is handled on the fleet, and for the same reason. There is exactly one function in the codebase that decrypts a stored MCP secret, and it runs on the host.",
        ],
        mock: "task-running",
      },
      {
        heading: "Per-server tool allow-lists, and no arbitrary caps",
        paragraphs: [
          "Some servers expose a lot of tools, and not all of them should be reachable from a coding agent. So each connected server can carry an allow-list: exactly these tools, nothing else.",
          "What there is not is a cap on how many servers a run may use, or how many tools a server may expose. Those were considered and dropped — they were round numbers with no reasoning behind them, and the allow-list gives you the same saving as a deliberate choice rather than an arbitrary ceiling. The one limit that stays is a 64-character tool name, because that is a hard provider limit and an over-long name fails the whole request rather than one call.",
        ],
        bullets: [
          "All tools, a chosen subset, or none — three distinct states, and none of them is guessed",
          "Remote streamable HTTP servers, over HTTPS",
          "OAuth servers connect with PKCE; API-key servers store the key sealed",
        ],
      },
      {
        heading: "Free on every plan, deliberately",
        paragraphs: [
          "Tasks, queued pull requests, workflows and loops all have a free-plan cap. MCP servers do not, on any plan. A connected server costs nothing until a run uses one, and what a run costs is already bounded by the task cap — so charging for the connection would be charging twice for the same thing.",
        ],
      },
      {
        heading: "Fleet only",
        paragraphs: [
          "This works on Talyn Fleet, which is where the proxy that holds your credentials lives. PostHog Code has no equivalent, so the option is hidden there and refused by the API if something asks anyway.",
        ],
      },
    ],
    faq: [
      {
        q: "Which MCP servers can I connect?",
        a: "Any remote streamable HTTP server over HTTPS — Linear, Sentry, Supabase, Stripe, or one you run yourself. There is a catalogue of common ones to save you finding the URL. Local stdio servers are not supported, because the sandbox is not your machine.",
      },
      {
        q: "Can the agent see my API key?",
        a: "No. The sandbox is given a plain URL with no credential on it, and the host's proxy attaches the secret per request from outside the machine. That is the whole design.",
      },
      {
        q: "Can I limit which tools a server exposes?",
        a: "Yes, per server. Leave it unset for all tools, choose a subset, or choose none. Those are three genuinely different states and Talyn does not collapse them — reading an empty list as 'all' would make 'run this with no tools' the one thing you could not ask for.",
      },
      {
        q: "Does this cost anything on the free plan?",
        a: "No, and there is no cap. A connected server spends nothing until a run uses it, and the run is already bounded by the task limit.",
      },
      {
        q: "Does it work with PostHog Code?",
        a: "No, it is Talyn Fleet only. The credential-attaching proxy is part of the fleet.",
      },
    ],
    related: ["agents", "fix-pull-requests", "loops"],
    updated: UPDATED,
  },
];

export function listFeaturePages(): FeaturePage[] {
  return FEATURE_PAGES;
}

export function getFeaturePage(slug: string): FeaturePage | null {
  return FEATURE_PAGES.find((f) => f.slug === slug) ?? null;
}

/**
 * Resolve a page's `related` slugs, dropping any that do not exist.
 *
 * The same forgiving lookup `relatedGuides()` does in `lib/guides.ts`: a
 * typo'd slug leaves a shorter list rather than breaking the build, because
 * these are navigational garnish and not the page.
 */
export function relatedFeaturePages(page: FeaturePage): FeaturePage[] {
  return page.related
    .map((slug) => getFeaturePage(slug))
    .filter((f): f is FeaturePage => Boolean(f) && f!.slug !== page.slug);
}
