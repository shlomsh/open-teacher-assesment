# Open Teacher Assessment — Exam Viewer

A static web app that lets a teacher open a folder of student exam exports and view
every student's exam — **questions, artwork/diagrams, and answers** — in a clean,
modern, RTL layout. It replaces the legacy Windows-only **iTest** grading client.

Everything runs **in the browser**. Student files are read locally via the
File System Access API and **never uploaded**; only this app's code is hosted.

- `index.html` — markup + styles
- `app.js` — folder picker, parsing, and rendering (no dependencies, no build step)

## For the teacher

1. Open the app link in **Chrome or Edge** (bookmark it).
2. First time: click **"בחירת תיקייה…"** and select the folder containing the student
   subfolders (each named by student id).
3. All students appear — click one for its questions, images, and answers.
4. Next time: **"פתיחת התיקייה האחרונה"** reopens the same folder; **"רענון"** re-scans
   it after you add more student folders.

Requires Chrome or Edge (the folder-picker API isn't in Safari/Firefox).

## Deploy (Vercel)

Zero-config static site. Connect this repo to Vercel and it serves `index.html` from
the root — every push to the default branch auto-deploys.

```sh
# one-time, if using the CLI:
vercel            # link the project
vercel --prod     # deploy
```

Or import the GitHub repo at vercel.com → it detects a static site (no build) and
gives you a URL. Share that URL with teachers.

## Local development

The folder picker needs a secure context, so serve over http (localhost), don't open
`file://` (it's unreliable for the picker and for "remember last folder"):

```sh
python3 -m http.server 8765   # then open http://localhost:8765 in Chrome
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
