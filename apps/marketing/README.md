# Talyn — marketing site

The public marketing site for **Talyn** (`talyn.dev`): mission control for your GitHub PRs, powered by cloud coding agents. Light & warm aesthetic, single rich landing page. Independent of the FastOwl backend/desktop — its own Next.js app, deploys to Vercel.

## Stack

- **Next.js 14** (App Router, TypeScript), statically rendered
- **Tailwind CSS** — brand tokens in `app/globals.css` + `tailwind.config.ts` (warm paper + charcoal ink + single terracotta/clay accent)
- **framer-motion** scroll reveals · **lucide-react** icons
- Hand-themed marketing components (glow cards, dotted-grid backdrop, marquee, macOS app frame) inspired by Aceternity / Magic UI

## Develop

```bash
cd apps/marketing
npm install
npm run dev        # http://localhost:3000
npm run build      # production build
npm run lint       # eslint
npm run typecheck  # tsc --noEmit
```

## Deploy (Vercel)

Create a Vercel project with **Root Directory = `apps/marketing`**. Framework preset Next.js; no env vars required. Point `talyn.dev` at it once registered.

## What to swap before launch

Everything that needs a real value lives in one of two places.

### 1. Copy — `lib/content.ts`

All headlines, feature blurbs, FAQ, nav, and footer text. Edit here to retune voice; no component changes needed. Key fields in `site`: `githubUrl`, `email`, `domain`.

### Download button — live

`components/ui/DownloadButton.tsx` fetches the newest release from the public
GitHub API (`Gilbert09/owl`) on click and downloads the Apple-silicon `.dmg`,
falling back to the releases page. It uses `/releases?per_page=1` (not
`/releases/latest`) because all current builds are pre-releases. Change `REPO`
there if the repo moves. A `download_click` event is sent to PostHog.

### Analytics — PostHog

`components/analytics/Analytics.tsx` + `lib/analytics.ts`. Set
`NEXT_PUBLIC_POSTHOG_KEY` (and optionally `NEXT_PUBLIC_POSTHOG_HOST`, default US
cloud) — see `.env.example`. Inert until the key is set, so safe to deploy
without it. Captures pageviews, `download_click`, and `waitlist_signup` (the
email form records the address as a PostHog event).

### 2. Product screenshots — currently live HTML mockups

The hero and feature visuals render **in-browser mockups** of the real app (`components/mocks/AppMocks.tsx`) so the site looks alive with zero image assets. To use real captures instead, drop a PNG in `public/screenshots/<shot>.png` and pass `src` to `ScreenshotPlaceholder`:

```tsx
<ScreenshotPlaceholder shot="dashboard" src="/screenshots/dashboard.png" />
```

Shot ids: `dashboard`, `task-running`, `merge-queue`, `pr-detail`, `onboarding`.

### 3. Email capture — `components/sections/Beta.tsx`

`EmailCapture` records each signup as a `waitlist_signup` PostHog event (via
`captureSignup`) and shows a local confirmation. To also pipe signups into a
dedicated tool (Resend / Loops), add the POST in `onSubmit`.

## Brand quick reference

- **Name:** Talyn (a stylized "talon" — the owl's grip that drags a failing PR to green)
- **Tagline:** "Merge more. Babysit less."
- **Palette:** warm paper `#f8f5f0`, charcoal ink `#23201b`, terracotta/clay accent `#c25e3a` (CTAs); status colors only inside the product mockups
- **Type:** Space Grotesk (display) · Inter (body) · JetBrains Mono (code)
- **Voice:** dry, dev-native, a little silly. Owl/talon/night puns used sparingly.
