---
name: badabhai-design
description: Use this skill to generate well-branded interfaces and assets for BadaBhai (the helpful big brother for India's blue/grey-collar workforce — chat-built worker profiles, free resumes, and a masked-candidate marketplace sold by ₹40 unlocks), either for production or throwaway prototypes/mocks/etc. Contains essential design guidelines, colors, type, fonts, assets, and UI kit components for prototyping.
user-invocable: true
---

Read the README.md file within this skill, and explore the other available files.

If creating visual artifacts (slides, mocks, throwaway prototypes, etc), copy assets out and create static HTML files for the user to view. If working on production code, you can copy assets and read the rules here to become an expert in designing with this brand.

If the user invokes this skill without any other guidance, ask them what they want to build or design, ask some questions, and act as an expert designer who outputs HTML artifacts _or_ production code, depending on the need.

## What's here
- `readme.md` — the full design guide: brand story, **Content Fundamentals** (voice, Hinglish, casing, ₹ formatting), **Visual Foundations** (Desi Vernacular Pop palette, type, motion, the masking motif), **Iconography** (Phosphor).
- `styles.css` — the single stylesheet to link; `@import`s every token + the component styles. Tokens live in `tokens/`.
- `assets/fonts/` — self-hosted Roboto Mono. Baloo 2 + Mukta load from Google Fonts.
- `assets/logo/` — the placeholder app-icon.
- `components/` — 24 React primitives (forms, display, feedback, navigation, brand). Each has a `.d.ts` contract and a `.prompt.md` with usage.
- `ui_kits/worker-app/` and `ui_kits/company-web/` — full click-through product recreations.
- `templates/` — copyable starting screens (`CompanyDashboard`, `WorkerJobFeed`).
- `guidelines/` — foundation specimen cards.

## ⚠️ The visual layer is a proposal
No logo, colors, fonts, or screenshots were supplied — only a product/strategy
doc. Everything visual (palette, type, logo, icon set) is an original, flagged
interpretation. Treat it as a strong v1 to confirm, not gospel. If real brand
assets exist, prefer them.

## Fast rules
- Brand is vermilion `#E0371C`; **green `#0E7A4F` is the action/“go” color** (Apply, verified, ₹). Saffron `#F29D10` warms. Don't flood vermilion.
- Type: Baloo 2 (display), Mukta (body, multilingual), Roboto Mono (data/₹).
- Money is always `₹40` (no space); set figures in mono with tabular numerals.
- Worker copy = warm "bada bhai" Hinglish, "no test, just talk"; payer copy =
  crisp and operational. Sentence case. One word: **BadaBhai**.
- Worker touch targets ≥ 48px. Masked-until-unlocked is a core visual pattern.
- Icons = Phosphor; in the worker app pair icons with text labels.
