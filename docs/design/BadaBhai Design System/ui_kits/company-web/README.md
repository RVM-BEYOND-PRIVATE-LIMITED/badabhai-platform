# UI Kit · Company / Agency web app

A high-fidelity, click-through recreation of the **BadaBhai payer web app** (the
Next.js product). One role-aware platform — the account type reveals the right
sections.

**Open:** `index.html`

### What it shows
- **Dashboard** — KPI tiles (weekly paid unlocks = north star, repeat-unlock rate
  = health metric), recent activity, and the ₹40 unlock packs (50 / 200 / 1,000).
- **Find candidates** — the demand loop: search + filter → **masked** candidate
  list → **unlock for ₹40** (confirm dialog) → contact revealed. Sorted by
  relevance, never by who paid.
- **My jobs** — posted jobs with applicant-quota progress and status.
- **Post a job** — verification-gated form (free through launch).
- **Agency → Earnings** — switch the role toggle to *Agency* to reveal the parked
  supply/earnings view (an honest "fast-follow" empty state — that dashboard is
  the post-alpha workstream).

### Files
`index.html` · `screens.jsx` (shell + views) · `app.jsx` (controller) ·
`company-web.css` (kit-only chrome).

### Design-system components used
`StatTile`, `MaskedCandidate`, `Dialog`, `Tabs`, `Button`, `IconButton`, `Input`,
`Textarea`, `Select`, `Badge`, `Chip`, `Card`, `ProgressBar`, `Avatar`, `Toast`,
`BadaBhaiLogo` — all from `window.BadaBhaiDesignSystem_01ff85`.

### Caveats
- No Next.js source or Figma was provided — built from the context doc's product
  description, not a pixel recreation. Share the real console and it can be matched.
