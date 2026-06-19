/**
 * Single source of truth for all marketing copy.
 * Edit here to retune the voice without touching component layout.
 */

export const site = {
  name: "Talyn",
  domain: "talyn.dev",
  tagline: "Merge more. Babysit less.",
  description:
    "Talyn watches every pull request, catches the ones stuck in CI, and sends cloud agents to fix the checks, clear the conflicts, and reply to reviews — so they land without you babysitting them.",
  // Swap this for the real release artifact when the beta build is public.
  downloadUrl: "#download",
  githubUrl: "https://github.com/Gilbert09/owl",
  email: "hey@talyn.dev",
};

export const nav = [
  { label: "How it works", href: "#how" },
  { label: "Features", href: "#features" },
  { label: "Providers", href: "#providers" },
  { label: "FAQ", href: "#faq" },
];

export const hero = {
  badge: "Public beta",
  titleLead: "Merge more.",
  titleAccent: "Babysit less.",
  sub: "Talyn is mission control for your GitHub pull requests. It watches every PR, catches the ones stuck in CI, and sends cloud agents to fix the checks, clear the conflicts, and reply to reviews — so they land without you hovering over them.",
  primaryCta: "Download for Mac",
  secondaryCta: "See how it works",
  microtrust: "Apple silicon · macOS 13+",
};

export const poweredBy = {
  kicker: "Bring your own agent",
  blurb:
    "Talyn doesn't run a model — it conducts the ones you already trust.",
  logos: [
    { name: "Claude Code", note: "Anthropic Managed Agents" },
    { name: "PostHog Code", note: "Connected" },
    { name: "GitHub", note: "Your repos" },
  ],
};

export const problem = {
  kicker: "The PR tax",
  title: "You're not coding. You're babysitting CI.",
  body: "Shipping with AI got fast. The part after the PR opens did not. Every green checkmark is one git pull, one flaky retry, one \"merge main into your branch\" away from being your whole afternoon.",
  pains: [
    {
      title: "The refresh loop",
      body: "Ten GitHub tabs open, hunting for which PR just went red, got a review, or quietly fell behind main.",
    },
    {
      title: "CI whack-a-mole",
      body: "A one-line lint fix means checking out the branch, re-running the suite, pushing, and waiting. Again.",
    },
    {
      title: "Stale-branch rot",
      body: "You approved it Tuesday. It's Thursday, main moved, and now it conflicts. Back to square one.",
    },
    {
      title: "Agent babysitting",
      body: "You kicked off an agent, then sat there watching the log so you could open the PR yourself.",
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
      title: "Connect GitHub + an agent",
      body: "Sign in with GitHub, pick the repos you live in, and connect a cloud agent — Claude Code or PostHog Code. That's the whole setup.",
      shot: "onboarding",
    },
    {
      n: "02",
      title: "Talyn watches every PR",
      body: "One live dashboard ranks your PRs by what needs you. CI status, review state, conflicts, and merge-readiness — at a glance, in real time.",
      shot: "dashboard",
    },
    {
      n: "03",
      title: "Delegate, or let it auto-fix",
      body: "Hit \"fix this PR\" and a cloud agent resolves CI, then opens the fix. Or flag it keep-mergeable and Talyn does it the moment things go red.",
      shot: "task-running",
    },
  ],
};

export const features = [
  {
    id: "dashboard",
    eyebrow: "Mission control",
    title: "Every PR, triaged. No tabs required.",
    body: "A live dashboard sorts your work into Needs attention, Mine, and Review. Status pills show the CI rollup, review state, and conflicts at a glance — so the PR that's actually blocking you is always at the top.",
    bullets: [
      "Real-time check rollups across every watched repo",
      "Needs-attention bucket surfaces blockers instantly",
      "Diffs, checks, and conversation right inside the app",
    ],
    shot: "dashboard",
    flip: false,
  },
  {
    id: "delegate",
    eyebrow: "Delegate the drudgery",
    title: "Send a cloud agent. Get a PR back.",
    body: "Fix failing CI, reply to review comments, or write a whole feature — the agent runs the full loop and opens a pull request. Watch the transcript stream live, then take it from there.",
    bullets: [
      "Fix CI / reply to review / freeform code tasks",
      "Live transcript streaming as the agent works",
      "It opens the PR — you stay in control",
    ],
    shot: "task-running",
    flip: true,
  },
  {
    id: "auto-merge",
    eyebrow: "Set it and forget it",
    title: "PRs that keep themselves mergeable.",
    body: "Flag a PR keep-mergeable and Talyn watches it. Falls behind main? Hits a conflict? Goes red? It dispatches a fix automatically. The merge queue lands them in order the second they're green.",
    bullets: [
      "Auto-fix when a PR falls behind or breaks",
      "Merge queue lands PRs in order, when green",
      "The talons stay out so you don't have to",
    ],
    shot: "merge-queue",
    flip: false,
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
    flip: true,
  },
];

export const providers = {
  kicker: "Providers",
  title: "No lock-in. Use the agent you trust.",
  sub: "Talyn is a pluggable conductor for cloud coding agents. Use the one your team already pays for — or pick a different one per task.",
  items: [
    {
      name: "Claude Code",
      sub: "Anthropic Managed Agents",
      status: "Connected",
      body: "Anthropic's hosted sandbox runs the agent loop and opens the PR. Full support: live transcript, PR creation, cancellation.",
    },
    {
      name: "PostHog Code",
      sub: "Personal API key + project",
      status: "Connected",
      body: "Connect a PostHog Code key and project. Powers auto-fixes, review replies, and freeform tasks end to end.",
    },
    {
      name: "More on the way",
      sub: "Pluggable by design",
      status: "Soon",
      body: "Every provider is a self-contained module behind one clean interface — so adding the next agent doesn't touch your workflow.",
    },
  ],
};

export const why = {
  kicker: "Why Talyn",
  title: "It doesn't just flag problems. It fixes them.",
  cards: [
    {
      title: "Triage that thinks",
      body: "Every PR ranked by what needs you — blocked, behind, or ready — the moment you open the app.",
      tone: "clay",
    },
    {
      title: "Fixes, not just alerts",
      body: "Other tools tell you CI broke. Talyn sends an agent to fix it and opens the pull request.",
      tone: "clay",
    },
    {
      title: "Stays green on its own",
      body: "Flag a PR keep-mergeable and Talyn re-fixes it the moment it falls behind or breaks.",
      tone: "plain",
    },
    {
      title: "Bring your own agent",
      body: "Claude Code or PostHog Code — use the one you trust. No model lock-in, switch per task.",
      tone: "plain",
    },
    {
      title: "Lands them in order",
      body: "The merge queue ships your ready PRs the second they're green — conflicts handled along the way.",
      tone: "plain",
    },
    {
      title: "Built to live in",
      body: "Real diffs, live transcripts, instant triage — the polish of a tool you keep open all day.",
      tone: "plain",
    },
  ],
};

export const beta = {
  badge: "Public beta",
  title: "Talyn is in beta.",
  body: "Connect your repos, bring your own cloud agent, and start clearing your PR backlog tonight. We're building in the open and would love your feedback while we get to 1.0.",
  cta: "Download for Mac",
  emailLabel: "Not on a Mac? Get notified.",
  emailPlaceholder: "you@startup.dev",
  emailCta: "Notify me",
};

export const faq = [
  {
    q: "What is Talyn, exactly?",
    a: "A desktop app that tracks your GitHub PRs and delegates the routine work — fixing CI, clearing conflicts, replying to reviews — to cloud coding agents that run the loop and open a pull request. Think mission control for getting PRs to a mergeable state.",
  },
  {
    q: "Which AI agents does it use?",
    a: "You bring your own. Claude Code (Anthropic Managed Agents) and PostHog Code are supported today, with more providers on the way. Talyn doesn't run a model itself — it conducts the provider you connect, and you can switch per task.",
  },
  {
    q: "Where does the work actually happen?",
    a: "Agent runs happen in your provider's cloud, under your account. Talyn is the desktop control surface that kicks them off, streams the progress live, and links the resulting PR back onto your dashboard.",
  },
  {
    q: "How does auto-keep-mergeable work?",
    a: "Flag a PR and Talyn watches it. When it falls behind main, hits a conflict, or fails CI, Talyn dispatches a cloud fix run automatically. Once the checks are green again, the merge queue lands it in order.",
  },
  {
    q: "Is my code safe?",
    a: "Talyn talks to GitHub and your chosen provider over their official APIs using credentials you supply. The heavy lifting runs in the provider's sandbox under your account — Talyn orchestrates, it doesn't hoard your source.",
  },
  {
    q: "What does it cost?",
    a: "Talyn is in public beta. You bring your own cloud-agent credits with whichever provider you connect. Pricing for general availability will be announced before we leave beta — beta users get a heads up first.",
  },
  {
    q: "What platforms are supported?",
    a: "The beta ships for macOS (Apple silicon) first. Not on a Mac? Drop your email and we'll ping you the moment other builds land.",
  },
];

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
        { label: "Download", href: "/#download" },
      ],
    },
    {
      title: "Company",
      links: [
        { label: "FAQ", href: "/#faq" },
        { label: "GitHub", href: "https://github.com/Gilbert09/owl" },
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
