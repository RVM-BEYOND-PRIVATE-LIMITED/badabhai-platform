# BadaBhai — Design System

> The helpful big brother for India's blue- and grey-collar workforce.
> This repository is the brand + product design system: tokens, fonts, reusable
> React components, and full-screen UI kits for the two BadaBhai surfaces.

---

## ⚠️ Read first — provenance of this system

The only source material provided was a **product/strategy context document**
(`uploads/BadaBhai_Latest_Context_2026-06-19.md.docx`, extracted to
`uploads/badabhai_context.txt`). It is rich on **product, business, and UX
strategy** but contains **no visual brand** — no logo, colors, type, screenshots,
Figma, or codebase.

So the **visual layer in this system is an original, defensible interpretation**
derived from BadaBhai's product DNA, *not* a recreation of an existing brand.
Everything marked 🟠 below is a proposed decision awaiting your sign-off:

- ✅ **Color** — "Desi Vernacular Pop" — **LOCKED #5** (vermilion + green + saffron)
- 🟠 **Type** — Baloo 2 (display) + Mukta (body) + Roboto Mono (data)
- 🟠 **Logo** — a placeholder wordmark + chat-lift app-icon
- 🟠 **Iconography** — Phosphor Icons (CDN), substituted as no set was provided

If you have *any* real assets (a logo, a color, a deck, screenshots of the
Flutter app or Next.js console), share them and this system snaps to them.

---

## 1 · What BadaBhai is

BadaBhai turns blue/grey-collar workers in India into **live, profiled,
contactable candidates** — profiled by a conversational AI ("bada bhai," the
helpful big brother who *never tests, only helps*) in Hinglish/regional language,
over chat and async voice — and sells **reach and access** to anyone who pays:
vacancy-banded job postings, boosts, and ₹40 contact unlocks. For every worker
it also generates a **free, perfect resume** and a **trade interview kit** — the
marketing front door.

**It is not** a staffing firm, an employer-of-record, or a static job board.
Money in → reach + data + access out. Positioning: *"Naukri-Resdex for
blue-collar, with live intent."*

**Wedge:** industrial / manufacturing trades (the launch CNC/VMC roles + adjacent
manufacturing, 15 trades built). Hospitality and gig come later.

**The moat:** chat-built profiles (for workers who could never write a resume) +
live intent + a compounding behavioral event stream + an indefinitely-retained
voice/transcript corpus + the resume artifact base.

### Two products (this system covers both)

1. **Worker mobile app** — Flutter. Chat-first (the first screen *is* a chat
   window — no forms, no tiles). Profiling by conversation, swipe-to-apply job
   feed (right = apply, left = skip), async voice notes ≤2 min, free resume +
   interview kit. Low-literacy-first, offline-tolerant, phone + OTP. Hinglish.
2. **Company / Agency web app** — Next.js. A role-aware platform (account type
   reveals the right sections). The **demand loop**: post a job → browse masked
   candidates → unlock a contact (₹40) → reach out. The **agency** logs in
   separately and also has a supply/earnings side (fast-follow, not in alpha).

### Three actors

- **Worker** — the supply, the heart, the front door. Dignity-first.
- **Company** — posts jobs, unlocks candidates. Pays.
- **Agency** — dual mode: refers workers (earns 25% rev-share) *and* hires (pays).

### Sources used to build this system

- `uploads/BadaBhai_Latest_Context_2026-06-19.md.docx` — the master context doc
  (compiled 2026-06-19), the sole input. Key numbers: unlock **₹40** flat (packs
  50/200/1,000); north star = **weekly paid unlocks**; Reach weights
  **35/20/15/15/10/5** (Trade/Location/Skills/Experience/Salary/Availability),
  flat, **no demographic inputs ever**; soft launch **Sep 2026**.
- Stack referenced (for UI-kit fidelity): Flutter (mobile), Next.js (web),
  NestJS + FastAPI + Supabase-Mumbai backend. *No codebase or Figma was shared —
  if either exists, attach it and the UI kits can be made pixel-exact.*

---

## 2 · Content Fundamentals — how BadaBhai writes

The brand voice **is the product**: the "bada bhai" persona is a helpful big
brother who *never tests, only helps*. Everything below flows from that.

**Voice:** warm, plain, encouraging, never condescending. Big brother, not
boss; guide, not gatekeeper. Confidence without hype.

**Person & address:**
- To **workers** → speak as a supportive *aap*/*tu*-warm "we've got you." Use
  **"you / आप / tum"** directly. Never make the worker feel tested or judged
  ("No test. Just talk." / *"Koi test nahi. Bas baat."*).
- To **payers** → professional, efficient, second-person ("Post a job", "Unlock
  this candidate"). Respect their time; lead with the action.

**Language — Hinglish-first.** Copy is bilingual by default: a Latin-script
Hinglish line carries the warmth, regional/Devanagari supports comprehension.
Casual, spoken register — the way a helpful elder actually talks, not formal
textbook Hindi. Examples of register (illustrative, not locked copy):
- *"Resume ban gaya! Download karein 👍"* → "Your resume is ready."
- *"Bas ek minute ki baat, phir kaam shuru."* → "One minute of talking, then we get to work."
- Job feed: **"Apply"** (swipe right) / **"Skip"** (swipe left) — single words.

**Casing:** Sentence case everywhere for UI and body. **Title Case is avoided.**
Short ALL-CAPS only for tiny eyebrow labels and status chips (`VERIFIED`,
`PAUSED`, `2 LEFT`), set with wide tracking. Brand name is always **BadaBhai**
(one word, two capitals) — never "Bada Bhai", "Badabhai", or "BADABHAI".

**Numbers & money:** always the rupee glyph **₹** with no space (`₹40`,
`₹1,000`). Indian digit grouping (lakh/crore: `1,00,000`). Set figures in Roboto
Mono with tabular numerals so they align in tables and ledgers.

**Tone by surface:**
- Worker app → reassuring, celebratory at milestones ("Resume ready!",
  "Applied!"), zero jargon, very short sentences, one idea per screen.
- Payer web → crisp, operational, trustworthy. Numbers and status do the talking.

**Honesty guardrails (from the strategy doc, treat as copy law):**
- Off-wedge / waitlist messaging must be **honest** — never imply an imminent
  launch. "We'll alert you when [trade] opens."
- Money **never** tilts a worker's visibility — never imply pay-to-rank to anyone.
- Don't surface payroll/EOR language to workers.

**Emoji:** sparingly and only worker-facing, as a warm human accent on a
celebratory or instructional moment (a single 👍 / ✅ / 📄), never in payer UI,
never decoratively, never more than one per message. Prefer the icon set.

---

## 3 · Visual Foundations

**Theme — "Desi Vernacular Pop."** The dignity of skilled trade work meets the
warmth of a helpful big brother. Honest, sturdy, optimistic, vernacular-Indian,
mobile-first. We avoid the cold blue/purple SaaS look entirely.

### Color
- **Vermilion** (`--brand`, `#E0371C`) is the brand — sindoor red, festive and
  alive. Logo, highlights, brand moments, primary brand buttons. Used with intent.
- **Green** (`--success`, `#0E7A4F`) is the **action / "go"** color — Apply,
  verified, ₹/money, consent. Primary CTAs are green (with a 3D press).
- **Saffron** (`--saffron`, `#F29D10`) — haldi warmth: tags, resume header, kit
  icons, festive accents.
- **Ink** (`--ink-900`, warm brown near-black) — text, chrome, earthy dark blocks.
- **Cream** (`--paper-2`, `#FFF6E8`) — the page; cards sit on it as crisp white.
- **Crimson** (`--danger`) — skip, errors, urgency. Sparingly.
- **Rani pink & turquoise** (`--pink`, `--teal`) — festive pops in small doses;
  turquoise also serves info/links.
- **Festive borders** — dashed-green (`--border-festive`) + double-vermilion
  (`--border-double`) on hero cards (job card, resume header, form pop-up).
- A **dark/ink theme** (`[data-theme="ink"]`) inverts surfaces for hero blocks.

### Type
- **Baloo 2** — display & brand voice. Warm, rounded, sturdy; carries Devanagari.
  This is "bada bhai" talking — big and encouraging, never shouting. Headlines,
  the logo, big worker-facing moments. Weights 600–800.
- **Mukta** — body & all UI. Calm, highly legible, multilingual (Devanagari +
  Latin), built for screens. Carries Hinglish/regional copy at low-literacy
  sizes. Weights 400–700.
- **Roboto Mono** — data: wages, IDs, unlock counts, codes. Tabular numerals.
  **Self-hosted** (`assets/fonts/`, real binaries) so figures render offline.
- **Body never below 16px.** Worker-facing copy skews larger (18–20px). Generous
  line-height (1.5). Headlines tight (1.1) with slight negative tracking.
- 🟠 Baloo 2 + Mukta load from the Google Fonts CDN (both open-source). Ask and
  I'll self-host their binaries for full offline parity.

### Spacing & layout
- **4px base grid** (`--space-*`). Worker mobile canvas is `--app-max` (440px).
- **Touch targets are sacred** — worker-app controls never below **48px**
  (`--tap`); the primary CTA is 52px (`--control-lg`). Gloved hands, the field.
- One idea per worker screen; generous breathing room. Payer web is denser,
  table- and card-driven, 32px gutters.

### Shape & elevation
- **Corner radii** are friendly but sturdy: controls 14px, cards 18px, sheets
  24px, pills for chips/status/swipe. Never sharp, never fully toy-round.
- **Cards** = crisp white on warm paper, a hairline warm border
  (`--border-subtle`) + a soft low shadow (`--shadow-sm`/`md`). No heavy drops.
- **Shadows** are warm, ink-tinted, and low — objects resting on paper, not
  floating in cold space. The **vermilion glow** (`--shadow-brand`) is reserved
  for the single primary CTA on a screen.
- **Borders** are warm hairlines, not grey lines. Dividers are barely-there.

### Motion
- Purposeful and reassuring. Short fades + small slides on a confident ease-out
  (`--ease-out`, 140–220ms). Nothing loops; nothing decorative.
- **One earned exception — "the stamp":** a small spring overshoot
  (`--ease-stamp`) for *verify / unlock / apply / resume-ready* success, like a
  rubber stamp hitting paper. This is the brand's one moment of delight.
- **Hover** (web): fill darkens one step + a small shadow lift.
  **Press** (mobile): scale to 0.97 + darken — tactile, like a real button.
- `prefers-reduced-motion` zeroes all durations (built into `motion.css`).

### Backgrounds & texture
- Mostly flat warm paper. Depth comes from **elevation and warm borders**, not
  gradients. We avoid bluish-purple gradients, emoji cards, and the
  rounded-card-with-colored-left-border trope (explicitly).
- Acceptable atmosphere: a very subtle warm paper tint, a marigold under-stroke
  on a key headline (`.bb-mark`), and the ink theme for contrast blocks.

### Imagery
- Direction: **warm, dignified, documentary portraits** of real Indian workers in
  real workplaces (CNC shops, factory floors) — natural light, honest, never
  cheesy stock or staged "diverse office." Warm color grade.
- **No real photography or illustration was provided.** UI kits use labelled
  image placeholders where worker photos/logos go. We do **not** ship invented
  illustrations of people. Provide real imagery and the kits will use it.

### Privacy as a visual motif
Masking is core to the product (candidates are masked until unlocked). The
**masked state** — blurred name/photo, a lock affordance, a "Unlock for ₹40"
action — is a first-class, recurring visual pattern, not an afterthought.

---

## 4 · Iconography

🟠 **No icon set was provided.** This system uses **[Phosphor Icons](https://phosphoricons.com/)**
(via CDN) as the substitute — chosen for friendly geometric forms with rounded
terminals (warm, approachable, on "bada bhai" voice) plus broad coverage and
multiple weights. **Lucide** is the clean fallback if you prefer. If BadaBhai has
its own icons, drop the SVGs/font into `assets/icons/` and we switch.

**Rules:**
- Icons in the **worker app always pair with a text label** — never icon-only for
  primary actions (low-literacy-first). Minimum render size 20px; touch target
  still 48px.
- Weight: **regular** for most UI, **bold/fill** for active/selected states and
  the bottom-nav current tab.
- The payer web app may use icon-only affordances in dense toolbars where a
  tooltip is present.
- **Unicode/emoji are not an icon system here.** A single warm emoji is allowed
  as a worker-facing accent (see Content Fundamentals); structural iconography is
  always Phosphor.

**CDN (used by cards & kits):**
```html
<script src="https://unpkg.com/@phosphor-icons/web@2.1.1"></script>
<!-- then: <i class="ph ph-chat-circle-dots"></i> · <i class="ph-fill ph-seal-check"></i> -->
```

Common glyphs in use: `ph-chat-circle-dots` (chat), `ph-seal-check` (verified),
`ph-lock-simple` / `ph-lock-key-open` (mask/unlock), `ph-microphone` (voice
note), `ph-file-text` (resume), `ph-hand-swipe-right` (apply), `ph-wrench`
(trades), `ph-currency-inr` (₹), `ph-map-pin` (location).

---

## 5 · Index — what's in this repo

```
styles.css                 ← the one file consumers link (@import manifest)
tokens/
  fonts.css                @import Google (Baloo 2, Mukta) + @font-face (Roboto Mono)
  colors.css               ramps + semantic aliases + [data-theme="ink"]
  typography.css           families, scale, weights, leading, tracking
  spacing.css              4px grid, touch sizes, layout rails
  radii.css                corner radii
  elevation.css            shadows + borders + focus ring
  motion.css               easings, durations, reduced-motion
  base.css                 reset, globals, z-index layers
components.css             @imports each component group's CSS (in the styles.css closure)
assets/
  fonts/                   Roboto Mono .ttf (self-hosted, shipped)
  logo/app-icon.svg        🟠 placeholder chat-lift app icon
guidelines/                foundation specimen cards (Design System tab)
components/                24 reusable React primitives (see below)
ui_kits/
  worker-app/              Worker mobile app (Flutter product) recreation
  company-web/             Company / Agency web app (Next.js product) recreation
templates/                 copyable starting screens (consuming projects seed from these)
  company-dashboard/       payer KPIs + masked candidate list
  worker-screen/           mobile worker job feed
BadaBhai Design System.html  brand overview / cover page (loads without the bundle)
readme.md                  this file
SKILL.md                   Agent-Skill manifest (for Claude Code download)
```

**Starting points / templates.** Consuming projects seed new work from the
`templates/` folder (the live starting-point mechanism). Two ship today —
`CompanyDashboard` and `WorkerJobFeed`; both `@import` this system and mount its
real components.

**Components** — 24 primitives, each `<Name>.jsx` + `.d.ts` + `.prompt.md`, with
one demo card per group (mounted from `window.BadaBhaiDesignSystem_01ff85`):
- **forms/** — Button, IconButton, Input, Textarea, Select, Checkbox, Radio, Switch, OtpInput
- **display/** — Card, Badge, Chip, Avatar, StatTile
- **feedback/** — Dialog, Toast, Tooltip, ProgressBar
- **navigation/** — Tabs, BottomNav
- **brand/** — BadaBhaiLogo, ChatBubble, JobCard, MaskedCandidate

**Namespace:** components are exposed at `window.BadaBhaiDesignSystem_01ff85`.

---

*Compiled from the 2026-06-19 context doc. The visual layer is a proposal — see
the top of this file. Iterate with me to make it exact.*
