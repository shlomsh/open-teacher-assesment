# Product

## Register

product

## Users

Israeli high-school **art teachers** grading the Applied Art matriculation exam (בגרות),
working in Hebrew (RTL). They open a local folder of ~30 per-student exports and read each
student's questions, artwork, and answers, then assign a grade and comment per item. Context
is **mixed desktop + tablet** (at a desk, but often a laptop or tablet in varied settings), so
responsive behavior matters. Chrome/Edge only (File System Access API). They are not technical;
nothing is uploaded, everything is read and saved locally.

## Product Purpose

Replace the legacy Windows-only iTest grading client with a zero-install web app that lets a
teacher view every student's exam in a clean modern RTL layout and grade it item-by-item, with
grades saved back into each student's folder and exportable to CSV. Success = a teacher can grade
a full class faster and more comfortably than in the old kiosk, with confidence their work is saved.

## Brand Personality

Calm, trustworthy, scholarly. Tone is plain and reassuring (these are matriculation grades; the
stakes feel high to the teacher). The current visual direction is "archival dossier" (warm paper,
serif headings, gold/teal, wax-seal motif); the user is open on whether to keep that or move toward
a quieter, more utilitarian tool feel. Either way it must feel calm and credible, never flashy.

## Anti-references

Generic blue corporate SaaS dashboards. Loud, over-animated, gamified ed-tech. Anything that feels
like a marketing landing page rather than a working tool.

## Design Principles

- **The tool disappears into the task.** Grading is the job; chrome and decoration must not compete with reading answers and writing grades.
- **Trustworthy by default.** Make save state, location, and "nothing is uploaded" legible at all times. The teacher must never wonder if their grades were lost.
- **Calm over clever.** Restraint in motion and color; no choreography the user has to wait through.
- **RTL-native and responsive.** Hebrew/RTL and desktop+tablet are first-class, not afterthoughts.

## Accessibility & Inclusion

Pragmatic, not exhaustive ("ship fast" per the user). Hit basic WCAG AA contrast for body text and
controls and keep keyboard/focus usable, but deep screen-reader and full AA conformance are not a
gating requirement for this pilot.
