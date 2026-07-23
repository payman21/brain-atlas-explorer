# Deploying Brain Atlas Explorer

The app is a fully static site — no server, no database, nothing runs on the
host. `npm run build` emits a `dist/` folder of plain files; any static host
serves it. These instructions target **Cloudflare Pages**, which is free, has
unmetered bandwidth (the ~9 MB of bundled templates and surfaces never risk a
cap), and can apply the cache rules in `public/_headers`.

## First-load size, for reference

- ~332 KB gzipped JavaScript (one chunk)
- plus whatever the user opens: the 4 MB MNI template loads only when a volume
  is viewed; the ~700 KB surfaces load only in the surface path

The `zstd` / `blosc` / `lz4` chunks in `dist/assets/` are OME-Zarr codecs that
NiiVue code-splits and never fetches for NIfTI/GIFTI/CIFTI, so they cost nothing
on load. Leave them; they are not dead weight.

## Option A — Cloudflare Pages via GitHub (auto-deploys on push)

1. Create the repo and push:
   ```bash
   git remote add origin git@github.com:<you>/brain-atlas-explorer.git
   git push -u origin main
   ```
2. In the Cloudflare dashboard: **Workers & Pages → Create → Pages → Connect to
   Git**, and pick the repo.
3. Build settings:
   - Framework preset: **Vite** (or **None**)
   - Build command: `npm run build`
   - Output directory: `dist`
4. Save and deploy. You get a `https://<project>.pages.dev` URL, and every push
   to `main` redeploys automatically.

## Option B — Cloudflare Pages direct upload (no GitHub)

```bash
npm run build
npx wrangler pages deploy dist --project-name brain-atlas-explorer
```
Wrangler prompts a browser login the first time, then uploads `dist/` straight
from your machine.

## Any other static host

`npm run build` and serve `dist/`. It works on Netlify (`_headers` is honoured),
GitHub Pages (cache headers ignored, but otherwise fine), S3 + CloudFront, or a
plain nginx root. No SPA-rewrite rules are needed — it is a single page.

## Custom domain (optional)

Cloudflare Pages → your project → **Custom domains** → add a domain you own
(~$10/yr). The free `*.pages.dev` subdomain works indefinitely if you don't want
one.
