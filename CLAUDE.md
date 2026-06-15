# CLAUDE.md

Static, offline-first teacher-assessment app. No backend. Served on Vercel.

## Source of truth & build
- **`app.src.js` and `index.html` are the only source files** for the app. `app.js` and `dist/` are **gitignored build artifacts** — never edit them by hand.
- Vercel runs `npm run build` (terser + html-minifier-terser) → emits `dist/`. `outputDirectory` is `dist`.
- Verify prod with curl, e.g. `curl -sI https://open-teacher-assesment.vercel.app/students` should be `200 text/html`.

## Routing model (important — non-obvious)
- The real view is driven by **`rootHandle`** (File System Access directory handle) **+ `location.hash`** (student id), not by the URL path.
- The URL **path** (`/`, `/students`, `/exam`) is a **cosmetic analytics label** written via `replaceState` in `trackView()` so Vercel Web Analytics counts distinct views. It does NOT drive the view.
- On refresh, `init()` can only auto-restore the view if `handle.queryPermission({mode:'readwrite'})` already returns `'granted'` (persistent grant / installed PWA). `requestPermission()` needs a user gesture, so when the grant has lapsed the welcome/resume screen is the **required** fallback — that's the FS Access security model, not a bug.

## vercel.json gotchas
- SPA fallback rewrite: `{ "source": "/(.*)", "destination": "/index" }`. With **`cleanUrls: true`**, Vercel strips `.html` at build time, so a destination of `/index.html` does NOT resolve at the Edge and refreshes 404. Use the **extensionless** `/index`.
- No `_vercel/` source exclusion needed: Vercel serves real static files and `/_vercel/*` (analytics) from the filesystem layer before user rewrites apply.

## Workflow
- User commits straight to `main`; Vercel auto-deploys. No branches/preview-by-default.
- Never commit exam data / student PII (already gitignored).
