# Open Teacher Assessment — Exam Viewer

My wife is an art teacher. For years she was stuck grading exams in a clunky,
Windows-only legacy app with dated UX — and we've been a Mac-only household for ages,
so every grading season meant borrowing or wrestling with a Windows machine. So I
decided to polish my vibe-coding skills, build her something better, and open-source it
for any teacher in the same spot.

It's a static web app that lets a teacher open a folder of student exam exports and view
every student's exam — **questions, artwork/diagrams, and answers** — in a clean,
modern, RTL layout. It replaces the legacy Windows-only **iTest** grading client and
runs on any OS, in the browser.

There's also a tiny, optional Vercel-hosted version so a teacher can just open a link —
no install. **It is built with security and student PII in mind: neither the
open-source code nor the Vercel deployment ever stores or receives any data.** Student
files are read locally via the File System Access API and **never uploaded**; only the
app's code is hosted.

- `index.html` — markup + styles
- `app.src.js` — folder picker, parsing, and rendering (no runtime dependencies)

## For the teacher

1. Open the app link in **Chrome or Edge** (bookmark it).
2. First time: click **"בחירת תיקייה…"** and select the folder containing the student
   subfolders (each named by student id).
3. All students appear — click one for its questions, images, and answers.
4. Next time: **"פתיחת התיקייה האחרונה"** reopens the same folder; **"רענון"** re-scans
   it after you add more student folders.
5. [סרטון הדרכה לשימוש באפליקציה](https://youtube.com/watch?v=mhr91sxjvnQ&si=h7iWePzWc2UWaXA4)

Requires Chrome or Edge (the folder-picker API isn't in Safari/Firefox).

## Performance

Small projects deserve the same engineering care as large ones. Here's what went into
making this as fast and resilient as possible.

### Build pipeline

Source files are human-readable; the build produces optimised output:

- **JavaScript** — [Terser](https://terser.org/) minifies `app.src.js → app.js`, shaving ~26% off the payload.
- **HTML** — `html-minifier-terser` strips whitespace and comments from `index.html`, cutting another ~16%.
- **Images** — The social preview was converted from a 53 KB PNG to a 14 KB WebP — a **74% reduction** — with no visual quality loss.

### Caching strategy

Every asset gets a cache lifetime matched to how often it changes:

| Asset | Strategy | TTL |
|---|---|---|
| `index.html`, `app.js` | `public, max-age=3600` | 1 hour, then revalidate |
| `dompurify.min.js`, images | `public, immutable` | 1 year — never re-fetched |
| `sw.js` | `no-cache` | Always revalidated so SW updates propagate instantly |

### Offline-first service worker

A [stale-while-revalidate](https://web.dev/stale-while-revalidate/) service worker (`sw.js`) precaches all core assets on first visit. From then on:

- Assets are served **instantly from cache** — zero network round trips.
- The SW fetches updates in the background; the next visit picks them up.
- The app works **fully offline** — critical for use in exam rooms with unreliable Wi-Fi.

### Edge delivery

Deployed on Vercel's edge network, **pinned to the Paris region (`cdg1`)** for minimal latency to Israeli users. `framework: null` skips redundant framework detection on every deploy.

A `<link rel="preload">` hint on `app.js` moves the script fetch earlier in the waterfall, before the HTML parser would ordinarily reach the `<script>` tag.

---

## Security

Student exam data is PII. Security is not an afterthought here.

### Data never leaves the device

The app uses the [File System Access API](https://developer.mozilla.org/en-US/docs/Web/API/File_System_Access_API) to read student folders **locally in the browser**. Nothing is uploaded, transmitted, or stored outside the user's machine. The Vercel deployment serves only the app's code — it has no backend, no database, and no analytics.

### Content Security Policy

A strict CSP is enforced on every response:

```
default-src 'self'
script-src  'self'                        — no inline scripts, no eval
style-src   'self' 'unsafe-inline' https://fonts.googleapis.com
font-src    https://fonts.gstatic.com
img-src     'self' blob: data:
connect-src 'self'                        — no external API calls
frame-ancestors 'none'                    — unembeddable (clickjacking protection)
```

`script-src 'self'` with no `unsafe-inline` or `unsafe-eval` means injected scripts — including XSS payloads — cannot execute, even if an attacker were to somehow influence the page's HTML.

### HTML sanitisation

Student exam files are parsed and rendered by the app. All student-supplied HTML is passed through **[DOMPurify](https://github.com/cure53/DOMPurify)** before being inserted into the DOM, preventing any malicious markup embedded in exam exports from executing.

### HTTP security headers

Every response includes:

| Header | Value |
|---|---|
| `X-Frame-Options` | `DENY` |
| `X-Content-Type-Options` | `nosniff` |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `Permissions-Policy` | camera, microphone, and geolocation all denied |

---

## Deploy

This is a static site with a lightweight build step. Any static host that can run
`npm run build` works — Vercel, Netlify, GitHub Pages, Cloudflare Pages, or your own
web server. The build output lands in `dist/`.

The only runtime requirement is a **secure context (HTTPS)**, which the File System
Access API needs to work.

If you use a host that gates deployments behind authentication, make the site public so
teachers can reach it without a login wall.

## Local development

```sh
npm install        # first time only
npm run build      # produces dist/
```

The folder picker needs a secure context, so serve `dist/` over HTTP (localhost) — don't open
`file://` (it's unreliable for the picker and for "remember last folder"):

```sh
cd dist && python3 -m http.server 8765   # then open http://localhost:8765 in Chrome
```

## Data (not in this repo)

Exam data lives **outside** the repo (it's student PII and large). Each student is one
folder named by student id, containing a decrypted `standalone_open/` directory.

Background on the export format, reverse-engineered from the legacy system:

- `standalone_open/index.html` already contains the student's answers baked in:
  free-text in `<div id="ans_qNN...">`, fill-in (cloze) as `<option selected>`,
  photo-tool answers in `answers/assets/assets.js`.
- Question **artwork** is present unencrypted under `helpers/myimg/Q<n>.*` (by question
  number) and `helpers/PhotoGallery_Q<n><part>/image/photos/*`. The app maps it to each
  question by filename. The `*.zip` files in each folder are encrypted but **redundant** —
  everything needed is already in `standalone_open/`, so no decryption is required.
- `VirtualTour_Q*` interactive rooms are referenced but not shipped in the export; the
  app flags those questions as "stimulus unavailable".
- Students answer a chosen subset of questions, so rendering is answer-driven.
- Validated across the 2024 and 2026 sittings of exam 816367 (Applied Art).

## License

[MIT](LICENSE) © shlomsh
