/**
 * Single source of truth for all marketing copy.
 * Edit here to retune the voice without touching component layout.
 */

export const site = {
  name: "Talyn",
  domain: "talyn.dev",
  tagline: "Drag your PRs to green.",
  description:
    "Talyn watches every pull request, flags what's broken, and sends cloud agents to fix CI, clear conflicts, and answer reviews — so your PRs land themselves.",
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
  badge: "Free while in beta",
  // Primary line + the bit we tint gold.
  titleLead: "Drag your PRs to",
  titleAccent: "green.",
  sub: "Talyn is mission control for your GitHub pull requests. It watches every PR, flags the ones rotting in CI hell, and dispatches cloud coding agents to fix the checks, clear the conflicts, and answer the reviews — automatically.",
  primaryCta: "Download for Mac",
  secondaryCta: "See how it works",
  microtrust: "Apple silicon · macOS 13+ · free in beta",
};

export const poweredBy = {
  kicker: "Bring your own agent",
  blurb:
    "Talyn doesn't run a model — it conducts the best ones. Plug in the cloud agents you already trust.",
  logos: [
    { name: "Claude Code", note: "Anthropic Managed Agents" },
    { name: "PostHog Code", note: "Live" },
    { name: "OpenAI Codex", note: "Coming soon" },
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
      body: "You kicked off an agent, then sat there watching the terminal so you could open the PR yourself.",
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
      body: "Sign in with GitHub, pick the repos you live in, and plug in a cloud provider — Claude Code or PostHog Code. No daemon, no SSH, nothing running on your laptop.",
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
      body: "Hit \"fix this PR\" and a cloud agent resolves CI in its own sandbox, then opens the fix. Or flag it keep-mergeable and Talyn does it the moment things go red.",
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
      "Open diffs, checks, and conversation in-app",
    ],
    shot: "dashboard",
    flip: false,
  },
  {
    id: "delegate",
    eyebrow: "Delegate the drudgery",
    title: "Send a cloud agent. Get a PR back.",
    body: "Fix failing CI, answer review comments, or write a whole feature — the agent runs the full loop on its own sandbox and opens a pull request. Watch the transcript stream live, then review it like any other PR.",
    bullets: [
      "Fix CI / respond to review / freeform code tasks",
      "Live transcript streaming as the agent works",
      "It opens the PR — you just review and merge",
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
    id: "in-app",
    eyebrow: "Native, not a browser tab",
    title: "Review and merge without leaving.",
    body: "File-by-file diffs, the full check breakdown, the conversation thread, and a real one-click merge — all in a desktop app that's always there. Your laptop can close; the agents keep working in the cloud.",
    bullets: [
      "In-app diffs, checks, and conversation",
      "One-click merge — not a GitHub.com redirect",
      "Cloud-only: work survives a closed lid",
    ],
    shot: "pr-detail",
    flip: true,
  },
];

export const providers = {
  kicker: "Providers",
  title: "No lock-in. Switch per task.",
  sub: "Talyn is a pluggable conductor for cloud coding agents. Use the one your team already pays for — or pick a different one for each task.",
  items: [
    {
      name: "Claude Code",
      sub: "Anthropic Managed Agents",
      status: "Live",
      body: "Anthropic's hosted sandbox runs the agent loop and opens the PR. Full parity: transcript polling, PR creation, cancellation.",
    },
    {
      name: "PostHog Code",
      sub: "Personal API key + project",
      status: "Live",
      body: "Connect a PostHog Code key and project ID. Powers auto-fixes, review responses, and freeform tasks end to end.",
    },
    {
      name: "OpenAI Codex",
      sub: "Codex Cloud",
      status: "Coming soon",
      body: "Wired for the day OpenAI ships a server-to-server cloud API. The provider seam is already built and waiting.",
    },
  ],
};

export const why = {
  kicker: "Why Talyn",
  title: "Built for people who live in PRs.",
  cards: [
    {
      title: "No daemon. No SSH.",
      body: "Nothing runs on your machine. Agents work in the cloud; you get a transcript and a pull request.",
      tone: "talon",
    },
    {
      title: "Survives a closed laptop",
      body: "Kick off a fix, shut the lid, go to lunch. The run finishes in the cloud and the PR is waiting.",
      tone: "blue",
    },
    {
      title: "PR-native, not a generic IDE",
      body: "Every feature is wired to GitHub — triage, auto-fix, merge queue. It does one thing relentlessly well.",
      tone: "blue",
    },
    {
      title: "Auto-keep-mergeable",
      body: "The thing nothing else does: re-fix a PR the moment it falls behind or breaks, and merge it when green.",
      tone: "talon",
    },
    {
      title: "Multi-provider by design",
      body: "Claude Code and PostHog Code today, Codex next. A clean seam shields you from provider API churn.",
      tone: "blue",
    },
    {
      title: "Desktop-grade craft",
      body: "Coalesced live transcripts, real diffs, instant triage. The polish of a tool you keep open all day.",
      tone: "blue",
    },
  ],
};

export const beta = {
  badge: "Public beta",
  title: "Free while we're in beta.",
  body: "Talyn is free during the beta — you bring your own cloud agent, we conduct it. No card, no seats, no catch. Grab the Mac build and start clearing your PR backlog tonight.",
  cta: "Download for Mac",
  emailLabel: "Not on a Mac? Get notified.",
  emailPlaceholder: "you@startup.dev",
  emailCta: "Notify me",
};

export const faq = [
  {
    q: "What is Talyn, exactly?",
    a: "A desktop app that tracks your GitHub PRs and delegates the routine work — fixing CI, clearing conflicts, answering reviews — to cloud coding agents that run in their own sandbox and open a pull request. Think mission control for getting PRs to a mergeable state.",
  },
  {
    q: "Which AI agents does it use?",
    a: "You bring your own. Claude Code (Anthropic Managed Agents) and PostHog Code are live today; OpenAI Codex Cloud is planned. Talyn doesn't run a model itself — it conducts the provider you connect, and you can switch per task.",
  },
  {
    q: "Does anything run on my machine?",
    a: "No daemon, no SSH, no local CLI. Every agent run happens in the provider's cloud sandbox. Talyn is just the desktop control surface — your laptop can sleep while a fix finishes.",
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
    a: "Talyn is free during the public beta. You pay only for your own cloud-agent usage with whichever provider you connect. Pricing for general availability will be announced later — beta users get a heads up first.",
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
        { label: "How it works", href: "#how" },
        { label: "Features", href: "#features" },
        { label: "Providers", href: "#providers" },
        { label: "Download", href: "#download" },
      ],
    },
    {
      title: "Company",
      links: [
        { label: "FAQ", href: "#faq" },
        { label: "GitHub", href: "https://github.com/Gilbert09/owl" },
        { label: "Status", href: "#" },
        { label: "Changelog", href: "#" },
      ],
    },
    {
      title: "Legal",
      links: [
        { label: "Privacy", href: "#" },
        { label: "Terms", href: "#" },
      ],
    },
  ],
};
