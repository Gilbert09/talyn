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

export const nav = [
  { label: "How it works", href: "#how" },
  { label: "Features", href: "#features" },
  { label: "Providers", href: "#providers" },
  { label: "Pricing", href: "#pricing" },
  { label: "FAQ", href: "#faq" },
];

export const hero = {
  badge: "Public beta",
  titleLead: "Wake up to",
  titleAccent: "green PRs.",
  sub: "Half your pull requests are failing, out of date, or waiting on someone. Talyn puts them all in one list, worst first, and sends an AI agent to fix them \u2014 you pick the PR, it does the work. Trust it with one and it'll merge that PR itself, the moment it's ready. Overnight included.",
  primaryCta: "Download for {platform}",
  secondaryCta: "See how it works",
  webCta: "Open in browser",
  microtrust: "macOS, Windows & Linux — or run it in your browser",
};

export const poweredBy = {
  kicker: "Bring your own agent",
  blurb:
    "Talyn conducts the coding agents you already trust.",
  // Claude Code was REMOVED as a provider (Session 114 / migration 0050) — it
  // billed metered API credits, and the fleet runs Claude on the workspace's
  // own subscription instead. Do not re-add it here without a registered
  // provider behind it: this section is the promise the download makes.
  logos: [{ name: "PostHog Code", mark: "posthog" as const }],
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
      body: "Hit \"fix this PR\" and an AI agent works out what broke, fixes it, and pushes the fix for you. Run one of your own playbooks on it instead \u2014 a review, a security check. Or hand a PR over entirely and Talyn fixes it the moment anything breaks.",
      shot: "task-running",
    },
  ],
};

export const features = [
  {
    id: "dashboard",
    eyebrow: "Mission control",
    title: "Every PR, triaged. No tabs required.",
    body: "A live dashboard sorts your work into Needs attention, Mine, and Review, so the pull request that's actually blocking you is always at the top. One glance tells you what's passing, who's waiting, and what won't merge yet.",
    bullets: [
      "Live status across every project you've connected",
      "A Needs-attention list that puts blockers first",
      "Diffs, checks, and conversation right inside the app",
    ],
    shot: "dashboard",
    flip: false,
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
    flip: true,
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
    flip: false,
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
    flip: true,
  },
  {
    id: "context",
    eyebrow: "Full context, zero tabs",
    title: "Know what's blocking. Know what's ready.",
    body: "See the diff, the check breakdown, the conversation, and the review state for any PR without leaving Talyn. The ones that are good to go go straight into the merge queue.",
    bullets: [
      "Diffs, checks, and conversation in one view",
      "Live review + CI state at a glance",
      "Queue the ready ones straight to merge",
    ],
    shot: "pr-detail",
    flip: false,
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

export const providers = {
  kicker: "Providers",
  title: "No lock-in. Use the agent you trust.",
  sub: "Talyn conducts cloud coding agents rather than replacing them. Use the one you already pay for, and switch per task.",
  items: [
    {
      name: "PostHog Code",
      mark: "posthog" as const,
      body: "Connect PostHog Code and it powers the lot \u2014 fixes, clashes, and review replies, end to end.",
    },
    {
      name: "More on the way",
      mark: "soon" as const,
      body: "Every provider is a self-contained module behind one clean interface, so the next agent slots in without touching your workflow.",
    },
  ],
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
        "Keep every new PR green automatically, without flagging them one by one",
        "Automation never waits for a slot: merge queue and auto-keep always dispatch",
        "Cancel anytime, in-app",
      ],
      cta: "Download & upgrade in-app",
      highlighted: true,
    },
  ],
};

export const faq = [
  {
    q: "What is Talyn, exactly?",
    a: "A desktop app that tracks your GitHub PRs and delegates the routine work (fixing CI, clearing conflicts, replying to reviews) to cloud coding agents that run the loop and push the fix back to your PR. Think mission control for getting PRs to a mergeable state.",
  },
  {
    q: "Which AI agents does it use?",
    a: "You bring your own. PostHog Code is supported today, with more providers on the way. Talyn conducts whichever one you connect, and you can switch per task.",
  },
  {
    q: "Where does the work actually happen?",
    a: "Agent runs happen in your provider's cloud, under your account. Talyn is the desktop control surface that kicks them off, streams the progress live, and links the resulting PR back onto your dashboard.",
  },
  {
    q: "What are skills?",
    a: "Saved instructions you can re-run \u2014 a review checklist, a security pass, a changelog writer. Write one once and run it on any PR with a click. Talyn finds the ones already in your project or on your machine (the standard SKILL.md format), so if you use Claude you likely have some already. The agent follows the playbook and posts the result back to the PR.",
  },
  {
    q: "How does auto-keep-mergeable work?",
    a: "Flag a PR and Talyn watches it. The moment it goes out of date, clashes with someone else's work, or a test starts failing, Talyn sends an agent to fix it. Once it's green again, the merge queue lands it in order. Flagging PRs one at a time is free; having every new PR flagged automatically is an Unlimited feature.",
  },
  {
    q: "Is my code safe?",
    a: "Talyn talks to GitHub and your chosen provider over their official APIs using credentials you supply. The heavy lifting runs in the provider's sandbox under your account, and Talyn never stores your source.",
  },
  {
    q: "What does it cost?",
    a: "The free plan is the full app with up to 3 tasks running and 3 PRs in the merge queue at once, and auto-keep-mergeable on any PR you flag by hand. Unlimited removes both caps and keeps every new PR you open mergeable automatically, for $15/month (or $150/year, 2 months free), managed entirely in-app with cancel-anytime. Either way you bring your own cloud-agent credits: runs execute under the provider account you connect.",
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
  // Waitlist row (absorbed from the removed Beta section).
  emailLabel: "Want release notes? Get notified.",
  emailPlaceholder: "you@startup.dev",
  emailCta: "Notify me",
};

export const footer = {
  blurb: "Mission control for your GitHub PRs, powered by cloud coding agents.",
  madeBy: "Made by night owls who were tired of babysitting CI.",
  columns: [
    {
      title: "Product",
      links: [
        { label: "How it works", href: "/#how" },
        { label: "Features", href: "/#features" },
        { label: "Providers", href: "/#providers" },
        { label: "Pricing", href: "/#pricing" },
        { label: "Download", href: "/#download" },
        { label: "Open the web app", href: site.appUrl },
      ],
    },
    {
      title: "Company",
      links: [
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
