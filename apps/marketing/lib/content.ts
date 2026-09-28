/**
 * Single source of truth for all marketing copy.
 * Edit here to retune the voice without touching component layout.
 */

export const site = {
  name: "Talyn",
  domain: "talyn.dev",
  /** Canonical origin — the apex 308-redirects to www at the Vercel level. */
  url: "https://www.talyn.dev",
  tagline: "Wake up to green PRs.",
  description:
    "Talyn puts every one of your pull requests in one list, worst first, then sends AI agents to fix the failing tests, the clashes, and the review comments \u2014 so your work lands without you babysitting it.",
  githubUrl: "https://github.com/Gilbert09/talyn",
  /** The browser app — same product, nothing to install. */
  appUrl: "https://app.talyn.dev",
  /** Support/contact channel — every Talyn user has a GitHub account. */
  supportUrl: "https://github.com/Gilbert09/talyn/issues",
};

/**
 * Top-level navigation.
 *
 * `href` is written WITHOUT a leading slash and the component prefixes one,
 * which is how the same array holds both a homepage anchor (`#how` → `/#how`)
 * and a real route (`compare` → `/compare`).
 *
 * The Features entry has no `href` of its own in the sense the others do: it
 * is a `group`, and the component draws it as a menu built from
 * `listFeaturePages()` rather than from a list typed out here. A hand-kept
 * copy would be one page behind from the first time somebody forgot.
 */
export interface NavItem {
  label: string;
  /** Path relative to the root, with no leading slash. */
  href: string;
  /** Draw as a menu of the feature pages, headed by a link to `href`. */
  group?: "features";
}

/**
 * Five entries, and the count matters — the desktop bar has a logo and three
 * buttons to fit beside them, and "Download for Windows" is a lot wider than
 * the "Download" it replaced.
 *
 * "Agents" was a sixth and is gone: it pointed at /features/agents, which is
 * already the ninth item in the Features menu directly to its left. It was the
 * only top-level link that duplicated a dropdown entry, so it cost width and
 * bought nothing. The Fleet pitch it was there to promote now leads the hero
 * instead, which is a better place for it than a nav label.
 */
export const nav: NavItem[] = [
  { label: "How it works", href: "#how" },
  { label: "Features", href: "features", group: "features" },
  { label: "Compare", href: "compare" },
  { label: "Pricing", href: "pricing" },
  { label: "FAQ", href: "#faq" },
];

/**
 * The fold, rewritten against thirty days of real numbers rather than taste.
 *
 * Three things the data said, and what each one changed:
 *
 * 1. **The median visitor clicks at 27 seconds**, and 29 of 30 real download
 *    clicks came from the NAV button — the hero got one, all month. So the
 *    hero's job is not to convert. It is to say what this is, who it is for,
 *    and the one thing no competitor can say, inside the time somebody takes
 *    to find the button.
 * 2. **The subhead was 60 words across four sentences.** At 27 seconds that
 *    is not a subhead, it is an essay. Two sentences now.
 * 3. **"It'll merge that PR itself. Overnight included." is gone from the
 *    fold.** It reads as magic to an early adopter and as a hazard to anybody
 *    whose employer owns the repository, and the second group is most of the
 *    market. The claim is still on the page — further down, beside the fact
 *    that nothing merges unless you flagged it. Losing a careful reader in
 *    the first eight seconds costs more than the enthusiast it wins.
 *
 * What did NOT change: the headline. "Wake up to green PRs." is the brand and
 * it passes the only test worth applying to one — prefix it with "Now you
 * can" and it stays both compelling and true.
 */
export const hero = {
  badge: "Public beta",
  titleLead: "Wake up to",
  titleAccent: "green PRs.",
  // Leads with the subscription claim, not the dashboard claim. Every rival
  // has a list of pull requests; none of them runs on the Claude or ChatGPT
  // plan you already pay for.
  sub: "Talyn lists every pull request you have open, worst first, and sends an AI agent at the broken ones to push the fix. It runs on the Claude or ChatGPT subscription you already pay for \u2014 no API key, no second bill.",
  primaryCta: "Download for {platform}",
  secondaryCta: "See how it works",
  webCta: "Open in browser",
  // "For GitHub" is here because a GitLab user could previously read the
  // entire homepage without discovering the product cannot work for them.
  // Better to lose them in eight seconds than after an install.
  microtrust: "For GitHub. macOS, Windows & Linux — or run it in your browser.",
};

export const poweredBy = {
  kicker: "Runs on the plan you already pay for",
  blurb:
    "Talyn conducts the coding agents you already trust — on your own subscription, not a second token bill.",
  // Claude Code was REMOVED as a provider (Session 114 / migration 0050) — it
  // billed metered API credits, and the fleet runs Claude on the workspace's
  // own subscription instead. Do not re-add it here without a registered
  // provider behind it: this section is the promise the download makes.
  //
  // Order matches CLOUD_PROVIDER_ORDER in `@talyn/shared`, which is what the
  // app itself recommends and picks. Keep them the same: a site that leads
  // with one provider and an app that leads with another is the kind of
  // mismatch nobody notices until a new user asks why.
  // The AGENT brands, not the provider names, because this strip's whole claim
  // is "the plan you already pay for" — and what a reader recognises is the
  // Claude and ChatGPT marks, not ours. Which fleet those two run on is the
  // providers section's job, further down.
  logos: [
    { name: "Claude", mark: "claude" as const },
    { name: "ChatGPT", mark: "codex" as const },
    { name: "PostHog Code", mark: "posthog" as const },
  ],
};

export const problem = {
  kicker: "The PR tax",
  title: "Writing the code got fast. Landing it didn't.",
  body: "AI can write the change in minutes. Then the pull request sits there \u2014 a test fails for no obvious reason, someone else's work lands first, a reviewer asks for one small thing \u2014 and the last mile eats your afternoon.",
  pains: [
    {
      title: "The refresh loop",
      body: "Ten GitHub tabs open, hunting for which PR just broke, got a comment, or quietly went out of date.",
    },
    {
      title: "One-line fixes, all afternoon",
      body: "A trivial fix still means pulling the branch down, running everything again, pushing, and waiting. Again.",
    },
    {
      title: "It was fine on Tuesday",
      body: "You approved it Tuesday. It's Thursday, the project moved on, and now it clashes. Back to square one.",
    },
    {
      title: "Watching the robot work",
      body: "You set an AI agent going, then sat there reading its output so you could press merge yourself.",
    },
  ],
};

export const how = {
  kicker: "How it works",
  title: "Three steps from chaos to merged.",
  sub: "Connect once. Talyn handles the loop.",
  steps: [
    {
      n: "01",
      title: "Connect GitHub",
      body: "Sign in with GitHub and pick the projects you work on. Your pull requests show up right away. You only connect an AI agent when you send your first fix \u2014 not before.",
      shot: "onboarding",
    },
    {
      n: "02",
      title: "Talyn watches every PR",
      body: "One live dashboard puts your pull requests in order of what needs you. What's passing, what's broken, who's waiting on you, what's ready to go \u2014 at a glance, in real time.",
      shot: "dashboard",
    },
    {
      n: "03",
      title: "Delegate, or let it auto-fix",
      body: "Hit \"fix this PR\" and an AI agent works out what broke, fixes it, and pushes the fix for you. Run one of your own playbooks on it instead \u2014 a review, a security check. Or stop deciding each time: write a workflow once and Talyn labels, reviews, fixes, and queues every matching PR on its own.",
      shot: "task-running",
    },
  ],
};

export const features = [
  {
    id: "dashboard",
    eyebrow: "Mission control",
    title: "Every PR, triaged. No tabs required.",
    // "Needs attention, Mine, and Review" described a three-bucket page the
    // app does not have. Shipped, those are two separate pages — My PRs, with
    // a Needs-attention filter on it, and Reviews (its own entry below) —
    // plus the Merge Queue. Copy that names a layout nobody will find is the
    // kind of small lie a download exposes in the first ten seconds.
    body: "A live dashboard puts every PR you've opened in one list, with a Needs-attention filter that pulls the blocked ones to the front. One glance tells you what's passing, who's waiting, and what won't merge yet.",
    bullets: [
      "Live status across every project you've connected",
      "A Needs-attention filter that puts blockers first",
      "Diffs, checks, and conversation right inside the app",
    ],
    shot: "dashboard",
  },
  {
    id: "reviews",
    eyebrow: "Reviews",
    title: "Every review request, in one list.",
    body: "The PRs waiting on you are scattered across repos and buried in notifications. Talyn keeps them on one page — every open PR where you're a requested reviewer and haven't reviewed yet — and tells you who asked, you directly or one of your teams. Filter to a single team, save the filter, and get on with it.",
    bullets: [
      "Every repo you've connected, one list, nothing to chase",
      "See whether you were asked directly or through a team — and filter by it",
      "Save a filter you use often, per workspace",
      "Run one of your review playbooks on any of them with a cloud agent",
    ],
    shot: "reviews",
  },
  {
    id: "code-review",
    eyebrow: "Code review",
    title: "Code review without the comment spam.",
    // Every claim here is bounded by what the engine actually does. It writes
    // NOTHING to GitHub during a review — that is enforced in the agent's own
    // system prompt, and it is the differentiator, so it leads. Do not add
    // "inline comments": that setting exists in the app and does nothing yet.
    // Do not say it approves or requests changes; it never does either.
    body: "Most AI reviewers announce themselves in your pull request. This one writes nothing to GitHub at all. Several reviewers read the change from different angles — logic, security, reliability, tests — then another pass looks for what they all missed, and a checker throws out everything it cannot stand behind. What is left is a short list in the app.",
    bullets: [
      "Findings live in Talyn — your pull request stays clean",
      "Read from several angles at once, then swept again for what they missed",
      "A checking pass drops the weak ones and records why it dropped them",
      "Tick what is worth fixing and Talyn pushes one commit, not a thread per finding",
    ],
    shot: "code-review",
  },
  {
    id: "delegate",
    eyebrow: "Delegate the drudgery",
    title: "Send a cloud agent. Get back a mergeable PR.",
    body: "Point Talyn at a pull request that's broken or out of date and it sends an AI agent to fix it \u2014 the failing tests, the clashes, the review comments \u2014 pushing the fix straight to your branch. Watch it work live. What comes back is green ticks, ready to merge.",
    bullets: [
      "Fixes failing tests, clashes, and review comments",
      "Watch it work, live, step by step",
      "Green checks back on your existing PR, no new PR to wrangle",
    ],
    shot: "task-running",
  },
  {
    id: "auto-merge",
    eyebrow: "The merge queue",
    title: "A merge queue that lands PRs for you.",
    body: "Flag a PR keep-mergeable and Talyn watches it: the moment it falls behind main, hits a conflict, or goes red, a fix run dispatches automatically. Then the merge queue takes over. It lands your PRs in order the second they're green, rebasing and clearing conflicts along the way, and drains independent PRs concurrently so one slow branch never holds up the rest.",
    bullets: [
      "Lands ready PRs in order, the moment they go green",
      "Rebases and resolves conflicts on the way in, no manual \"update branch\"",
      "Independent PRs merge in parallel; one slow build can't stall the queue",
      "Auto-fixes any PR that falls behind or breaks before it merges",
    ],
    shot: "merge-queue",
  },
  {
    id: "workflows",
    eyebrow: "Workflows",
    title: "Write the rule once. It runs on every PR.",
    body: "A workflow is a rule you set up in the app: when this happens on a pull request, do these things. Label it, pull in a reviewer, post a comment, add it to your list, send an agent to fix it, or drop it straight into the merge queue. It watches every PR in the repos you connect \u2014 including the ones you didn't open \u2014 and it runs whether or not the app is open.",
    bullets: [
      "Triggers on what actually happens: opened, checks failed, review requested, approved, commented, merged",
      "Narrow it with conditions \u2014 this repo, this base branch, this label, this author, drafts or not",
      "Actions that do real work: labels, reviewers, comments, a skill or prompt run, the merge queue",
      "Every run is logged, per rule, so you can see what fired and what it did",
    ],
    shot: "workflows",
  },
  {
    id: "loops",
    eyebrow: "Loops",
    title: "Work that happens on a schedule, not on a trigger.",
    body: "A loop is a prompt you want run again and again: sweep yesterday's failing checks every weekday morning, keep dependencies current every Monday, draft the release notes every Friday at five. Pick a repository, write the prompt, choose when \u2014 and an agent does it on its own, opening a pull request when the work warrants one.",
    bullets: [
      "Say when in plain terms: hourly, daily, weekdays, weekly \u2014 or a cron expression if you want one",
      "Runs in your timezone, so 09:00 means 09:00 to you and stays that way across the clocks changing",
      "Every run is logged with what it did, including the ones it skipped because the last was still going",
      "Start one by hand any time, without waiting for its next turn",
    ],
    shot: "loops",
  },
  {
    id: "skills",
    eyebrow: "Skills",
    title: "Your playbooks, runnable on any PR.",
    body: "Skills are reusable agent playbooks: a security sweep, your team's review checklist, a changelog writer. Talyn finds them everywhere they already live, whether that's committed to the repo, sitting in ~/.claude/skills on your machine, or saved to your workspace. Hit the wand on any PR, pick one, and a cloud agent runs it against that PR, posting the review or pushing the fix.",
    bullets: [
      "Picks up SKILL.md files from the repo, your machine, and your workspace, zero setup",
      "Searchable picker with your most-used skills on top",
      "Output lands on the PR: a single review comment, or commits to the branch",
    ],
    shot: "skill-picker",
  },
];

/** Compact CTA band mid-page — the stretch between Features and Pricing had
 *  no action to take without scrolling to the bottom. */
export const midCta = {
  title: "Ready to stop babysitting CI?",
  sub: "Open it in your browser or download the app, connect your repos, and clear the queue tonight.",
  cta: "Download for {platform}",
  secondary: "See pricing",
};

// Headed by the AGENTS, not by our provider names.
//
// This section used to lead with a "Talyn Fleet" card, and readers did not
// know what that was \u2014 which is fatal here, because this is the section that
// answers "what am I signing in with?". Our own brand is the one name on the
// page a visitor has no reason to recognise, and spending the most valuable
// card on it asked them to learn our vocabulary before they could tell whether
// the product was for them. The same argument the PoweredBy strip above
// already makes.
//
// The fleet has not gone anywhere, and it is still the differentiator \u2014 it is
// stated once in `note`, under the grid, as a description rather than a brand.
export const providers = {
  kicker: "Agents",
  title: "No lock-in. Use the agent you already pay for.",
  sub: "Talyn conducts coding agents rather than replacing them. Connect one or both, and switch per task.",
  items: [
    {
      name: "Claude",
      mark: "claude" as const,
      meta: "Runs on your Claude Pro or Max plan",
      body: "Sign in with Claude and every task runs on that subscription. No API key, no metered credits, no second bill for tokens.",
    },
    {
      name: "Codex",
      mark: "codex" as const,
      meta: "Runs on your ChatGPT Plus or Pro plan",
      body: "Sign in with ChatGPT and Talyn hands the work to Codex on your own plan \u2014 same deal, nothing metered on top.",
    },
    {
      name: "PostHog Code",
      mark: "posthog" as const,
      meta: "Runs in your PostHog project",
      body: "Already at PostHog? Connect PostHog Code and it powers the lot \u2014 fixes, clashes, and review replies, end to end.",
    },
  ],
  // The sandbox claim has to survive losing the fleet card: it is the only
  // thing in this section a competitor cannot match by adding a model.
  // Stated once, below the grid, because it is true of both agents.
  note: "Claude and Codex run on Talyn Fleet, our own hardware. Every task gets a fresh virtual machine; your credentials are attached from outside it, so no token is ever inside the machine running your code; and the machine is destroyed when the task ends.",
};

export const why = {
  kicker: "Why Talyn",
  title: "Talyn fixes what other tools only flag.",
  cards: [
    {
      title: "Triage that thinks",
      body: "Every PR ranked by what needs you (blocked, behind, or ready) the moment you open the app.",
    },
    {
      title: "Fixes, not just alerts",
      body: "Other tools tell you CI broke. Talyn sends an agent to fix it and push the checks back to green.",
    },
    {
      title: "Stays green on its own",
      body: "Flag a PR keep-mergeable and Talyn re-fixes it the moment it falls behind or breaks.",
    },
    {
      title: "Work that starts without you",
      body: "Some work is not a reaction to anything \u2014 it just needs doing every morning. Write the prompt once, pick when, and Talyn runs it on a schedule with the app closed.",
    },
    {
      title: "Rules that run themselves",
      body: "Write a workflow once \u2014 when this happens on a PR, do this \u2014 and it fires on every matching pull request in your repos, yours or not, app open or not.",
    },
    {
      title: "Bring your own agent",
      body: "Connect the agent you already trust. No model lock-in, and you can switch per task.",
    },
    {
      title: "A merge queue that lands them",
      body: "Queue your ready PRs and Talyn merges them in order the second they're green, rebasing and clearing conflicts on the way, and landing independent ones in parallel.",
    },
    {
      title: "Built to live in",
      body: "Real diffs, live transcripts, instant triage: the polish of a tool you keep open all day.",
    },
  ],
};

export const pricing = {
  kicker: "Pricing",
  title: "Start free. Upgrade when the queue gets serious.",
  sub: "Talyn is the control tower. Your cloud agents do the flying, billed by the provider you connect. One flat price for the tower.",
  footnote:
    "Prices exclude agent usage: runs execute in your provider's cloud, on your account and credits. Upgrade, manage, or cancel anytime from Settings → Billing in the app.",
  annualBadge: "2 months free",
  tiers: [
    {
      name: "Free",
      priceMonthly: "$0",
      priceAnnual: "$0",
      period: "forever",
      periodAnnualNote: null,
      blurb: "Full mission control, for a calmer queue.",
      features: [
        "The whole PR dashboard, every repo, every workspace",
        "All agent providers, switch per task",
        "Skills, the merge queue & auto-keep-mergeable on any PR you flag",
        "Up to 3 tasks running and 3 PRs queued at once",
        "Up to 3 workflows \u2014 your rules, running on every PR they match",
        "Up to 3 loops \u2014 your prompts, running on the schedule you set",
      ],
      cta: "Download for {platform}",
      highlighted: false,
    },
    {
      name: "Unlimited",
      priceMonthly: "$15",
      priceAnnual: "$12.50",
      period: "/month",
      periodAnnualNote: "billed annually ($150/yr)",
      blurb: "For the weeks when everything ships at once.",
      features: [
        "Everything in Free",
        "Unlimited concurrent tasks",
        "Unlimited PRs in the merge queue",
        "Unlimited workflows, so every rule you want is a rule you can keep",
        "Unlimited loops, so every job worth doing on a schedule can have one",
        "Keep every new PR green automatically, without flagging them one by one",
        "Automation never waits for a slot: merge queue and auto-keep always dispatch",
        "Cancel anytime, in-app",
      ],
      cta: "Download & upgrade in-app",
      highlighted: true,
    },
  ],
};

/**
 * The homepage FAQ.
 *
 * Deliberately the GENERAL questions only. It used to carry twelve, six of
 * which were "what are workflows", "what are loops", "what are skills", "how
 * does auto-keep-mergeable work" and two on code review — each of which is
 * now answered at length on that feature's own page, where the answer also
 * becomes `FAQPage` structured data pointing at the page a searcher wants.
 * Repeating them here would be asking Google to choose between two pages
 * answering one question, which it resolves by ranking neither.
 *
 * What stays is what somebody deciding whether to download needs: what it is,
 * what runs it, where the code goes, what it costs, what it runs on.
 */
/**
 * The four questions that stop somebody paying, answered on `/pricing`.
 *
 * Each one came out of auditing what the site already said and finding
 * nothing. They are not the general "what is Talyn" questions — those are on
 * the home page — they are the ones a person asks with a card in their hand:
 * is this priced per person, what is it about to do to my repository, what
 * does it cost me in agent quota, and can I stop it.
 */
export const pricingFaq = [
  {
    q: "Is $15 per person, or per account?",
    a: "Per account. Talyn bills the person who signs in, and the limits — tasks, queued pull requests, workflows, loops — are counted across every workspace that person owns. There are no seats to buy and no per-user maths. There is also no team plan yet: shared workspaces, SSO and admin controls do not exist, so if you need those, Talyn is not ready for you.",
  },
  {
    q: "What does the GitHub App actually get access to?",
    a: "The repositories you pick, and nothing else — you choose them when you install and can change them later. It needs write access to code, because the whole point is that an agent pushes a fix to your branch. It does not need organisation admin, and it works on a personal private repository with no organisation at all. It never force-pushes, and it never touches a branch you have not pointed it at.",
  },
  {
    q: "How much of my Claude or ChatGPT quota will this burn?",
    a: "As much as the work takes — Talyn does not meter or cap it for you, and we would rather say that plainly than pretend it is free. A fix run on a small pull request is a few minutes of agent time; a Deep code review on a large one can be an hour across several sandboxes. The free plan's three-concurrent-task limit is the real brake. If your subscription's quota does run out mid-run, Talyn moves that run to your other connected agent, and remembers so the next one does not waste a machine finding out.",
  },
  {
    q: "Can it merge something without me asking?",
    a: "Only on pull requests you flagged. Auto-keep-mergeable and the merge queue are both opt-in per pull request on every plan — nothing you have not flagged is ever merged, rebased or pushed to. The one setting that changes that is the workspace default that flags every NEW pull request you open automatically, it is part of Unlimited, and it is off unless you switch it on. Everything still goes through GitHub's own merge API, so your branch protection applies exactly as you configured it.",
  },
  {
    q: "Can I cancel, and do I get a refund?",
    a: "Cancel any time from Settings → Billing in the app; you keep Unlimited until the end of the period you have paid for and then drop back to the free plan, which keeps working. Payments are not refundable — Talyn is in public beta and the free plan exists so you can find out whether it works for you before paying anything.",
  },
  {
    q: "What happens if I go over the free limits?",
    a: "Nothing breaks and nothing is charged. A fourth concurrent task is refused with an explanation rather than queued silently, and automation that hits the cap — a merge-queue fix, say — is deferred until a slot frees up rather than dropped. You are never billed for going over, because there is nothing to bill: the free plan has no payment method attached.",
  },
];

export const faq = [
  {
    q: "What is Talyn, exactly?",
    a: "A desktop app that tracks your GitHub PRs and delegates the routine work (fixing CI, clearing conflicts, replying to reviews) to cloud coding agents that run the loop and push the fix back to your PR. Think mission control for getting PRs to a mergeable state.",
  },
  {
    q: "Which AI agents does it use?",
    a: "You bring your own. Sign in with Claude or ChatGPT and Talyn Fleet runs your tasks on that subscription \u2014 no separate API bill. PostHog Code is supported too, with more providers on the way. Talyn conducts whichever one you connect, and you can switch per task.",
  },
  {
    q: "Where does the work actually happen?",
    a: "On Talyn Fleet, each task runs in its own Firecracker microVM on our hardware, using your agent subscription. The VM reaches your repository and your agent through a proxy that attaches the credentials from outside, so no token is ever inside the machine running the code, and the VM is destroyed when the task ends. With PostHog Code the run happens in their cloud under your account instead. Either way, Talyn is the control surface that kicks it off, streams the progress live, and links the resulting PR back onto your dashboard.",
  },
  {
    q: "Does it work with GitLab or Bitbucket?",
    a: "No. Talyn is GitHub only, and there is no plan to change that soon. It installs as a GitHub App on the repositories you pick, reads their webhooks, and merges through GitHub's own API — none of which has an equivalent we have built elsewhere.",
  },
  {
    q: "Will it merge something without me asking?",
    a: "Only pull requests you flagged. Keeping a pull request mergeable and adding it to the merge queue are both opt-in, one pull request at a time, on every plan — nothing you have not flagged is merged, rebased or pushed to. The one setting that widens that is the workspace default which flags every new pull request you open, it is part of Unlimited, and it is off unless you turn it on. Everything goes through GitHub's merge API, so your branch protection applies exactly as you set it up.",
  },
  {
    q: "Is my code safe?",
    a: "Talyn talks to GitHub and your chosen provider over their official APIs using credentials you supply. The heavy lifting runs in the provider's sandbox under your account, and Talyn never stores your source.",
  },
  {
    q: "What does it cost?",
    a: "The free plan is the full app with up to 3 tasks running, 3 PRs in the merge queue, 3 workflows and 3 loops, plus auto-keep-mergeable on any PR you flag by hand. Unlimited removes all four caps and keeps every new PR you open mergeable automatically, for $15/month (or $150/year, 2 months free), managed entirely in-app with cancel-anytime. Either way you bring your own cloud-agent credits: runs execute under the provider account you connect.",
  },
  {
    q: "What platforms are supported?",
    a: "All of them. There are desktop builds for macOS (Apple silicon), Windows and Linux, and a web app at app.talyn.dev that needs no install at all — same product, same account, your workspaces and PR queue follow you between them. The desktop app adds two things a browser can't: it reads skills from ~/.claude/skills on your machine, and it keeps your session in the OS keychain.",
  },
];

export const finalCta = {
  titleLead: "Stop babysitting CI.",
  titleAccent: "Let the talons out.",
  sub: "In public beta. Bring your own agent. Clear your PR backlog tonight.",
  cta: "Download for {platform}",
};

export const footer = {
  blurb: "Mission control for your GitHub PRs, powered by cloud coding agents.",
  madeBy: "Made by night owls who were tired of babysitting CI.",
  columns: [
    {
      // The per-feature links used to be homepage anchors (`/#workflows`).
      // They now point at the pages, because the anchors survive only as ids
      // on a grid card — a link that lands you on a one-line summary of the
      // thing you clicked is a worse answer than the page about it. The
      // Features column below is generated and carries the full list.
      title: "Product",
      links: [
        { label: "How it works", href: "/#how" },
        { label: "All features", href: "/features" },
        { label: "Compare", href: "/compare" },
        { label: "Pricing", href: "/pricing" },
        { label: "Download", href: "/#download" },
        { label: "Open the web app", href: site.appUrl },
      ],
    },
    {
      title: "Company",
      links: [
        { label: "About", href: "/about" },
        { label: "FAQ", href: "/#faq" },
        { label: "GitHub", href: site.githubUrl },
        { label: "Support", href: site.supportUrl },
      ],
    },
    {
      title: "Legal",
      links: [
        { label: "Privacy", href: "/privacy" },
        { label: "Terms", href: "/terms" },
      ],
    },
  ],
};
