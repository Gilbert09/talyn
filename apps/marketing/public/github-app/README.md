# GitHub App logos

Avatars for the Talyn GitHub App, set under **GitHub → Settings → Developer settings → GitHub Apps → (app) → Display information → Logo**.

| File | Use | Look |
| --- | --- | --- |
| `logo-production.*` | Production app (`talyn`) | Brand owl on the terracotta tile — matches the marketing favicon. |
| `logo-development.*` | Development app (`talyn-dev`) | Same owl, terracotta-on-ink dark tile with a **DEV** pill — instantly distinct from production at avatar size. |

Each comes as the SVG master plus rendered PNGs (`@1024` and the 512px upload size).
GitHub requires a square raster image (PNG/JPG, ≥200×200, ≤1 MB) — upload the `.png`.

## Regenerating

Edit the `.svg` master, then re-render with `rsvg-convert`:

```sh
cd apps/marketing/public/github-app
for v in production development; do
  rsvg-convert -w 512  -h 512  logo-$v.svg -o logo-$v.png
  rsvg-convert -w 1024 -h 1024 logo-$v.svg -o logo-$v@1024.png
done
```

Palette (from `tailwind.config.ts` / `public/favicon.svg`): terracotta `#cf6a43 → #b4502e`, accent `#cf7553`, ink `#3d3830 → #23201b`, cream `#fbf6ef`.
