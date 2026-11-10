/**
 * Single source of truth for all marketing copy.
 * Edit here to retune the voice without touching component layout.
 *
 * House rules for the copy (the relaunch, November 2026): plain words, short
 * sentences, second person, no em-dashes, no exclamation marks, sentence-case
 * headings under about eight words. Each section is one headline, one or two
 * sentences, then specifics. Every claim must be true of the shipped app.
 */

export const site = {
  name: "Talyn",
  domain: "talyn.dev",
  /** Canonical origin. The apex 308-redirects to www at the Vercel level. */
  url: "https://www.talyn.dev",
  tagline: "Your coding agents keep working with the laptop closed.",
  description:
    "Run Claude Code and Codex in parallel cloud sandboxes, on the subscription you already pay for. Each session gets its own branch, diff, terminal and a path to a merged pull request.",
  githubUrl: "https://github.com/Gilbert09/talyn",
  /** The browser app: same product, nothing to install. */
  appUrl: "https://app.talyn.dev",
  /** Support/contact channel. Every Talyn user has a GitHub account. */
  supportUrl: "https://github.com/Gilbert09/talyn/issues",
  /** The public API docs, in the docs section. */
  apiDocsUrl: "/docs/api",
};

/**
 * Top-level navigation.
 *
 * `href` is written WITHOUT a leading slash and the component prefixes one,
 * which is how the same array holds both a homepage anchor (`#how` → `/#how`)
 * and a real route (`pricing` → `/pricing`).
 *
 * The Features entry is a `group`: the component draws it as a menu built
 * from `listFeaturePages()` rather than from a list typed out here.
 */
export interface NavItem {
  label: string;
  /** Path relative to the root, with no leading slash. */
  href: string;
  /** Draw as a menu of the feature pages, headed by a link to `href`. */
  group?: "features";
}

/**
 * Five entries. The desktop bar has a logo and three buttons to fit beside
 * them, and "Download for Windows" is wide, so keep the labels to one word.
 * Sessions and threads lead because the relaunch leads with them.
 */
export const nav: NavItem[] = [
  { label: "Sessions", href: "features/sessions" },
  { label: "Threads", href: "features/threads" },
  { label: "Features", href: "features", group: "features" },
  { label: "Pricing", href: "pricing" },
  { label: "Docs", href: "docs" },
];

/**
 * The fold. The median visitor clicks at about 27 seconds and most clicks
 * come from the nav button, so the hero's job is to say what this is and
 * who it is for, fast. Two sentences of subhead, no more.
 */
export const hero = {
  badge: "Public beta",
  /**
   * Shown in place of the badge while it is set. Conductor announced on
   * 2026-11-04 that it is joining Meta, and Conductor Cloud shuts down on
   * 2026-11-20, so its users are looking for somewhere to go this month.
   * Set to null once that has passed (early 2027, when local Conductor winds
   * down, at the latest).
   */
  announcement: {
    label: "Leaving Conductor Cloud? Your conductor.json works here",
    href: "/compare/conductor",
  } as { label: string; href: string } | null,
  // Leads with the cloud benefit: the agents run on our machines, not yours.
  // That is what a local tool cannot say, and the subhead then answers the two
  // FAQ questions visitors open most (which agents, where the work happens).
  titleLead: "Your coding agents keep working",
  titleAccent: "with the laptop closed.",
  sub: "Run Claude Code and Codex in parallel cloud sandboxes, on the plan you already pay for. Come back to a diff, or to a pull request that is already green.",
  primaryCta: "Download for {platform}",
  webCta: "Open in browser",
  // "For GitHub" stays: a GitLab user should find out in eight seconds, not
  // after an install.
  microtrust: "For GitHub. macOS, Windows and Linux, or in your browser.",
};

/** How a session works. Carries the `#how` anchor older links point at. */
export const sessions = {
  kicker: "Sessions",
  title: "From prompt to pull request.",
  sub: "Describe the task. Talyn makes the branch, starts the sandbox and hands it to your agent.",
  steps: [
    {
      title: "Describe it",
      body: "Type what you want done. Talyn names the session and its branch from your words.",
    },
    {
      title: "Let it work",
      body: "The agent reads, edits and runs commands in its own sandbox. Send more messages while it works and they wait their turn.",
    },
    {
      title: "Check it",
      body: "Read the diff, browse the files, open a terminal or start your app with a run script. Roll the files back to any earlier message.",
    },
    {
      title: "Ship it",
      body: "One button opens the pull request. The same button then fixes checks, resolves conflicts and merges.",
    },
  ],
  link: "How sessions work",
};

/** The sandbox facts: parallel, fast, free when asleep, safe. */
export const sandboxes = {
  kicker: "Sandboxes",
  title: "Run sessions side by side.",
  sub: "Every session gets its own sandbox. Start the next task while the last one runs.",
  items: [
    {
      title: "Ready in seconds",
      body: "Talyn builds an image of your repository with its setup already done. A new session starts from that image, not from a clean machine.",
    },
    {
      title: "Asleep costs nothing",
      body: "A sandbox that sits idle for 10 minutes goes to sleep, and a sleeping sandbox is free. Your next message wakes it.",
    },
    {
      title: "Read it without waking it",
      body: "Talyn keeps a copy of each session's changes and files. You can review a sleeping session without starting its sandbox.",
    },
    {
      title: "Your setup, every time",
      body: "Add setup steps and your dotfiles once. Talyn builds them into the image, and suggests steps it sees your sessions repeat.",
    },
    {
      title: "Work is saved as you go",
      body: "After every turn, Talyn saves the work you have not pushed. If a sandbox is lost, the next one restores it.",
    },
    {
      title: "Sessions remember",
      body: "Agents save short notes as they learn your codebase. The next session reads them, so you explain things once.",
    },
  ],
};

/** Threads: one conversation that runs sessions across repositories. */
export const threads = {
  kicker: "Threads",
  title: "One conversation, many repositories.",
  sub: "Give a thread a goal. It starts a session on every repository that needs a change.",
  bullets: [
    "It hears when a session finishes, opens a pull request or needs an answer.",
    "Open any of its sessions to read the diff or step in.",
    "It stops when its sessions stop making progress, and waits for you.",
  ],
  link: "How threads work",
};

/** PRs on autopilot: the GitHub panel, fix runs, the merge queue, review. */
export const pullRequests = {
  kicker: "Pull requests",
  title: "Your pull requests, kept green.",
  sub: "Every PR you own and every review you owe, blocked ones first. One click sends the fix.",
  items: [
    {
      title: "Fix it in one click",
      body: "Failing checks, a merge conflict or a review comment. The agent pushes the fix to the same branch.",
      href: "/features/fix-pull-requests",
    },
    {
      title: "A merge queue that fixes",
      body: "Queue a ready pull request and Talyn merges it when it is green. If it falls behind or breaks first, an agent fixes it.",
      href: "/features/merge-queue",
    },
    {
      title: "Code review in the app",
      body: "Several reviewers read the change, then a check drops what it cannot back up. Findings reach GitHub only if you post them.",
      href: "/features/code-review",
    },
  ],
};

/** Automation: loops, workflows, Slack, MCP servers, skills, the API. */
export const automation = {
  kicker: "Automation",
  title: "Work that starts without you.",
  sub: "Set it up once. It runs in the cloud, even with the app closed.",
  items: [
    {
      title: "Loops",
      body: "Run a prompt on a schedule. Every weekday at 9, every Monday, or any cron expression.",
      href: "/features/loops",
    },
    {
      title: "Workflows",
      body: "Rules for pull request events. When checks fail on a dependency bump, send an agent. When a PR is approved and green, queue it.",
      href: "/features/workflows",
    },
    {
      title: "Slack",
      body: "React with your emoji, mention Talyn or send it a message, and a session starts. Its status shows as reactions on your message.",
      href: "/features/slack",
    },
    {
      title: "MCP servers",
      body: "Connect Linear, Sentry or your own server. The agent uses the tools, and the keys stay outside the sandbox.",
      href: "/features/mcp-servers",
    },
    {
      title: "Skills",
      body: "Run your SKILL.md playbooks on any pull request: a security pass, a review checklist, a changelog.",
      href: "/features/skills",
    },
    {
      title: "Public API",
      body: "Start sessions, send messages and read the results from your own scripts with a personal access token.",
      href: site.apiDocsUrl,
    },
  ],
};

/**
 * Headed by the AGENTS, not by our provider names. What a reader recognises
 * is Claude and ChatGPT; "Talyn Fleet" is the one name on the page they have
 * no reason to know. The fleet is stated once, in `note`, as a description.
 */
export const providers = {
  kicker: "Agents",
  title: "Bring your Claude or ChatGPT plan.",
  sub: "Claude Code or Codex, on the plan you already pay for. Talyn charges for sandboxes, not tokens.",
  items: [
    {
      name: "Claude Code",
      mark: "claude" as const,
      meta: "On your Claude Pro or Max plan",
      body: "Sign in with Claude and every session uses that subscription. No API key and no metered credits.",
    },
    {
      name: "Codex",
      mark: "codex" as const,
      meta: "On your ChatGPT Plus or Pro plan",
      body: "Sign in with ChatGPT and sessions run Codex on your plan. Connect both and pick per session.",
    },
  ],
  note: "Each sandbox is a Firecracker microVM on our own hardware. Your credentials are added from outside it, so no token is ever inside the machine that runs your code. PR fixes and loops can also run on PostHog Code.",
  link: "How the sandbox and your credentials work",
};

/** The /features hub's "why" grid. */
export const why = {
  kicker: "Why Talyn",
  title: "From task to merged PR in one place.",
  cards: [
    {
      title: "Parallel by default",
      body: "Every session has its own branch and sandbox. Run several at once and none of them touch each other's files.",
    },
    {
      title: "Your own subscription",
      body: "Claude Code and Codex run on the plan you already pay for. You never paste an API key.",
    },
    {
      title: "Close the laptop",
      body: "Sessions run in the cloud. Pick them up later from the desktop app or the browser.",
    },
    {
      title: "Past the pull request",
      body: "Talyn opens the PR, fixes the checks, keeps it up to date and merges it when it is green.",
    },
    {
      title: "Work across repositories",
      body: "A thread runs sessions on several repositories and keeps track of each one for you.",
    },
    {
      title: "Runs with the app closed",
      body: "Loops run on a schedule and workflows run on pull request events, with the app closed.",
    },
  ],
};

export const pricing = {
  kicker: "Pricing",
  title: "Pay for the machines. Bring your own model.",
  sub: "A monthly allowance of box-hours, and credits only if you need more. The model runs on your own subscription.",
  footnote:
    "Prices are in US dollars. The model is not included: runs use the Claude or ChatGPT subscription you connect, so you pay us for the machines, not the model. Manage or cancel any time from Settings → Billing in the app.",
  annualBadge: "2 months free",
  boxHour:
    "A box-hour is one standard box running for one hour. Smaller boxes use less of your allowance and bigger boxes use more. Billing is per running second, and a sleeping box costs nothing.",
  tiers: [
    {
      name: "Free",
      priceMonthly: "$0",
      priceAnnual: "$0",
      priceAnnualTotal: "$0",
      period: "forever",
      periodAnnualNote: null,
      blurb: "The whole app, with a small monthly allowance.",
      features: [
        "10 box-hours a month",
        "Small and standard boxes",
        "Up to 2 boxes running at once",
        "Sessions, threads and the whole PR dashboard",
        "Skills, the merge queue, workflows, loops and code review",
        "Keep a PR mergeable on any PR you flag by hand",
        "Mobile app (coming soon)",
      ],
      cta: "Download for {platform}",
      highlighted: false,
    },
    {
      name: "Pro",
      priceMonthly: "$40",
      priceAnnual: "$33.33",
      priceAnnualTotal: "$400",
      period: "/month",
      periodAnnualNote: "billed annually ($400/yr)",
      blurb: "For the weeks when everything ships at once.",
      features: [
        "Everything in Free",
        "200 box-hours a month",
        "Every box size",
        "Up to 100 boxes running at once",
        "Auto-keep on every new PR, and auto-review on every new PR",
        "Credits with auto top-up, for anything above your allowance",
        "Mobile app (coming soon)",
        "Cancel any time, in the app",
      ],
      cta: "Download & upgrade in-app",
      highlighted: true,
    },
  ],
  sizesTitle: "Pay as you go, above your plan",
  sizesSub:
    "When your box-hours run out, boxes draw on your credit balance at the hourly price for their size. Credits are in US dollars.",
  sizes: [
    { name: "Small", vcpu: 2, ram: 4, perHour: "$0.11", weight: "0.5 box-hours" },
    { name: "Standard", vcpu: 4, ram: 4, perHour: "$0.22", weight: "1 box-hour" },
    { name: "Medium", vcpu: 4, ram: 8, perHour: "$0.275", weight: "1.25 box-hours" },
    { name: "Large", vcpu: 6, ram: 12, perHour: "$0.44", weight: "2 box-hours" },
    { name: "XLarge", vcpu: 8, ram: 16, perHour: "$0.55", weight: "2.5 box-hours" },
  ],
  sizesNote:
    "Free accounts can use small and standard boxes. Pro and Team can use every size. Your included hours are used first, then your credits.",
  creditsTitle: "Credits",
  creditPacks: [
    { amount: "$25", bonus: null },
    { amount: "$100", bonus: "+5% extra credit" },
    { amount: "$500", bonus: "+10% extra credit" },
  ],
  creditPoints: [
    "Credits last 12 months from the day you buy them.",
    "Turn on auto top-up and pick the balance that triggers it and the amount to add.",
    "Set a monthly limit on auto top-ups, so a busy month cannot surprise you.",
    "Credits are on Pro and Team plans.",
  ],
  comingSoon: "The mobile app is coming soon, and it is included on every plan.",
};

/**
 * Teams: seat billing. One person pays for N seats and every seat is a Pro
 * account with its own 200 box-hours. Nothing is shared between seats, and
 * the page says so, because a team lead asks about shared workspaces and SSO
 * inside two minutes.
 */
export const teams = {
  kicker: "Team",
  title: "More than one of you?",
  body: "A team seat is $40 a month. Each seat is a Pro account with its own 200 box-hours, so one person's busy week does not use up anybody else's allowance. One invoice covers everyone.",
  bullets: [
    "$40 per seat, with Pro for every seat",
    "200 box-hours a month for each person, not one pool for the team",
    "One invoice instead of everybody expensing $40",
  ],
  cta: "Talk about a team plan",
  caveat:
    "Each person keeps their own workspaces. Shared workspaces, SSO and admin controls are not built yet. Tell me what you need and it will shape what gets built.",

  modalTitle: "Tell me about your team",
  modalBody:
    "Two questions and anything else you want to add. It comes to me directly and I answer them myself.",
  modalCta: "Send it",
  modalFootnote:
    "Your email is used to reply to you and nothing else. No list, no newsletter.",

  sentTitle: "Got it.",
  sentBody: "I read these myself and I will come back to you at",

  failedTitle: "That did not send.",
  failedBody:
    "Something in your browser blocked it, usually an ad blocker or a privacy extension, because the form rides on our analytics. Rather than pretend otherwise: open a GitHub issue and I will pick it up there.",
};

/**
 * The questions that stop somebody paying, answered on `/pricing`.
 *
 * They are the ones a person asks with a card in their hand: what is a
 * box-hour, what happens when I run out, is this priced per person, what is
 * it about to do to my repository, and can I stop it.
 */
export const pricingFaq = [
  {
    q: "What is a box-hour?",
    a: "A box-hour is one standard box running for one hour. Every agent run happens on a box, which is a small cloud machine Talyn starts for you. A small box counts as half a box-hour for each hour it runs, a large box counts as two, and so on. We bill per running second, so a ten minute run uses a sixth of a box-hour on a standard box.",
  },
  {
    q: "What happens when my hours run out?",
    a: "Work that is already running finishes. Nothing new starts until you add credits or your hours reset at the start of the next month. Runs that Talyn starts for you, such as loops and merge queue fixes, wait with a notice in the app and start once there is room. Talyn never stops a run part way through.",
  },
  {
    q: "Do idle boxes cost anything?",
    a: "No. A box that has been idle for 10 minutes goes to sleep, and a sleeping box is free. You only pay for the seconds a box is awake and running.",
  },
  {
    q: "Do I pay for Claude or ChatGPT as well?",
    a: "Yes, on your own account, and Talyn does not mark it up. You bring your Claude or ChatGPT subscription and the agent uses it. You pay us for the machines, not the model.",
  },
  {
    q: "Is $40 per person, or per account?",
    a: "Per account. Talyn bills the person who signs in, and the box-hours are counted across every workspace that person owns. If several of you want it, a team seat is $40 a month and each seat gets Pro with its own 200 box-hours. What a team plan does not add is sharing: every person keeps their own workspaces, and there is no SSO.",
  },
  {
    q: "How do credits and auto top-up work?",
    a: "Credits are a balance in US dollars. You buy a pack of $25, $100 (with 5% extra) or $500 (with 10% extra), and boxes draw on the balance at their hourly price once your included hours are gone. With auto top-up on, Talyn buys a pack when your balance drops below a level you pick, up to a monthly limit you set. Credits last 12 months. Included hours reset every month and do not roll over.",
  },
  {
    q: "What does the GitHub App actually get access to?",
    a: "The repositories you pick, and nothing else. You choose them when you install and can change them later. It needs write access to code, because the whole point is that an agent pushes a fix to your branch. It does not need organisation admin, and it works on a personal private repository with no organisation at all. It never force-pushes, and it never touches a branch you have not pointed it at.",
  },
  {
    q: "How much of my Claude or ChatGPT quota will this burn?",
    a: "As much as the work takes. Talyn does not meter or cap your subscription, and we would rather say that plainly than pretend it is free. A fix run on a small pull request is a few minutes of agent time. A deep code review on a large one can be an hour across several boxes. If your subscription's quota runs out mid-run, Talyn moves that run to your other connected agent, and remembers so the next one does not waste a machine finding out.",
  },
  {
    q: "Can it merge something without me asking?",
    a: "Only on pull requests you flagged. Auto-keep and the merge queue are opt-in per pull request on every plan, so nothing you have not flagged is ever merged, rebased or pushed to. The one setting that changes that is the workspace default that flags every new pull request you open. It is part of Pro and it is off unless you switch it on. Everything still goes through GitHub's own merge API, so your branch protection applies exactly as you set it up.",
  },
  {
    q: "Can I cancel, and do I get a refund?",
    a: "Cancel any time from Settings → Billing in the app. You keep Pro until the end of the period you have paid for and then drop back to the free plan, which keeps working. Payments are not refundable. Talyn is in public beta, and the free plan exists so you can find out whether it works for you before paying anything.",
  },
];

/**
 * The homepage FAQ: the general questions only. Questions about one feature
 * are answered on that feature's own page, where they also become `FAQPage`
 * structured data for the page a searcher wants.
 */
export const faq = [
  {
    q: "What is Talyn?",
    a: "An app for running coding agents in the cloud. Each session is a branch with its own agent, sandbox, diff and terminal, and it ends in a pull request. Talyn also watches your open pull requests and sends an agent to fix the ones that break.",
  },
  {
    q: "How is a session different from Claude Code on my laptop?",
    a: "The agent runs in a cloud sandbox, not on your machine. You can run several at once, close the laptop, and open the same session later in the browser. Each session has its own branch, so two agents never edit the same files. On the desktop app you can also run a session in a local git worktree, or move a Claude Code conversation from your computer into a sandbox and carry on.",
  },
  {
    q: "Which agents does it use?",
    a: "Claude Code on your Claude Pro or Max plan, and Codex on your ChatGPT Plus or Pro plan. You sign in with the account; there is no API key. Connect both and pick per session. PR fixes and loops can also run on PostHog Code.",
  },
  {
    q: "Where does my code run?",
    a: "On Talyn Fleet: one Firecracker microVM per session, on our own hardware. Your GitHub and agent credentials are added by a proxy outside the machine, so no token is ever inside it. A sandbox sleeps after 10 minutes without work. Talyn saves your unpushed work after every turn, so a lost sandbox can be restored.",
  },
  {
    q: "Does it work with GitLab or Bitbucket?",
    a: "No. Talyn is GitHub only, and that will not change soon. It installs as a GitHub App on the repositories you pick.",
  },
  {
    q: "Will it merge something without me asking?",
    a: "Only pull requests you flagged. Keeping a pull request mergeable and adding it to the merge queue are both opt-in, one pull request at a time. The one setting that widens that is the workspace default that flags every new pull request you open. It is part of Pro and it is off unless you turn it on. Everything goes through GitHub's merge API, so your branch protection applies as you set it up.",
  },
  {
    q: "What does it cost?",
    a: "Free includes 10 box-hours a month. Pro is $40 a month ($400 a year) and includes 200 box-hours, every box size and up to 100 boxes at once. A box is the sandbox a session or an agent run uses, and it counts only while it is awake. The model runs on your own Claude or ChatGPT plan, so you pay us for the machines, not the model.",
  },
  {
    q: "What platforms are supported?",
    a: "macOS (Apple silicon and Intel), Windows and Linux, and a web app at app.talyn.dev with nothing to install. Your sessions and pull requests follow you between them. The desktop app adds local sessions, previews of your app on localhost and skills from ~/.claude/skills.",
  },
];

export const finalCta = {
  titleLead: "Start a session.",
  titleAccent: "Merge the PR.",
  sub: "Free to start, on the Claude or ChatGPT plan you already have.",
  cta: "Download for {platform}",
};

export const footer = {
  blurb: "Coding agents in cloud sandboxes, one session per task, from the first prompt to the merged pull request.",
  madeBy: "Made by a night owl who wanted the agents to work the night shift.",
  columns: [
    {
      title: "Product",
      links: [
        { label: "Sessions", href: "/features/sessions" },
        { label: "Threads", href: "/features/threads" },
        { label: "All features", href: "/features" },
        { label: "Pricing", href: "/pricing" },
        { label: "Docs", href: "/docs" },
        { label: "Download", href: "/download" },
        { label: "Open the web app", href: site.appUrl },
      ],
    },
    {
      title: "Company",
      links: [
        { label: "About", href: "/about" },
        { label: "FAQ", href: "/#faq" },
        { label: "Compare", href: "/compare" },
        { label: "API docs", href: site.apiDocsUrl },
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
