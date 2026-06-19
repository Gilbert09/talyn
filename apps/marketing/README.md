# Talyn — marketing site

The public marketing site for **Talyn** (`talyn.dev`): mission control for your GitHub PRs, powered by cloud coding agents. Premium-dark, single rich landing page. Independent of the FastOwl backend/desktop — its own Next.js app, deploys to Vercel.

## Stack

- **Next.js 14** (App Router, TypeScript), statically rendered
- **Tailwind CSS** — brand tokens in `app/globals.css` + `tailwind.config.ts` (navy + owl-blue + signature talon-gold), carried over from the desktop owl icon
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

All headlines, feature blurbs, FAQ, nav, and footer text. Edit here to retune voice; no component changes needed. Key fields in `site`:

- `downloadUrl` — currently `#download`. **Point at the real Mac build/release** (e.g. a GitHub Releases `.dmg` URL).
- `githubUrl`, `email`, `domain`.

### 2. Product screenshots — currently live HTML mockups

The hero and feature visuals render **in-browser mockups** of the real app (`components/mocks/AppMocks.tsx`) so the site looks alive with zero image assets. To use real captures instead, drop a PNG in `public/screenshots/<shot>.png` and pass `src` to `ScreenshotPlaceholder`:

```tsx
<ScreenshotPlaceholder shot="dashboard" src="/screenshots/dashboard.png" />
```

Shot ids: `dashboard`, `task-running`, `merge-queue`, `pr-detail`, `onboarding`.

### 3. Email capture — `components/sections/Beta.tsx`

`EmailCapture` has a placeholder submit handler (sets local "you're on the list" state). Wire `onSubmit` to Resend / Loops / a form endpoint.

## Brand quick reference

- **Name:** Talyn (a stylized "talon" — the owl's grip that drags a failing PR to green)
- **Palette:** ink navy `#030816`, owl-blue `#7da2e8` / `#aac4f5`, talon-gold `#f5b94d` (CTAs)
- **Type:** Space Grotesk (display) · Inter (body) · JetBrains Mono (code)
- **Voice:** dry, dev-native, a little silly. Owl/talon/night puns used sparingly.
