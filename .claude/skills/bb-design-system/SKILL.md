---
name: bb-design-system
description: Apply the BadaBhai brand + design system (Desi Vernacular Pop) to any UI — apps/payer-web (Company + Agency portal), apps/web (ops console), and the Flutter worker app. Use whenever building or reviewing a screen/component so it ships on-brand — design tokens (never raw values), the 24 shared primitives, voice/₹/masking rules, and the adherence linter. Source of truth: docs/design/BadaBhai Design System/.
---

# Skill: BadaBhai Design System

**Goal.** Every BadaBhai surface looks and sounds like one product — the "helpful big
brother" — by building from the locked design system, not ad-hoc styles.

**Source of truth (do not duplicate — link it):** `docs/design/BadaBhai Design System/`
- `readme.md` — full guide: brand story, **content/voice rules**, visual foundations, iconography.
- `SKILL.md` (`badabhai-design`) — design-from-this-folder notes + fast rules.
- `styles.css` + `tokens/*.css` — the token layer (colors, typography, spacing, radii,
  elevation, motion). **Build every theme — Next.js CSS vars and Flutter `ThemeData` — from these.**
- `components/` — 24 primitives (forms / display / feedback / navigation / brand); each has a
  `.d.ts` (props contract) + `.prompt.md` (usage).
- `ui_kits/company-web/` — the role-aware **Company + Agency payer-web** recreation → the
  visual target for `apps/payer-web`.
- `ui_kits/worker-app/` + `android-build-kit/` — the worker-app visual target.
- `_ds_manifest.json` — machine list of every token + component. `_adherence.oxlintrc.json` —
  the adherence lint (flags raw values vs tokens).

**Theme — Desi Vernacular Pop (locked, direction #5).**
- Brand vermilion `--brand` (#E0371C). **Green `--success` (#0E7A4F) is the action / "go"
  color** (Apply, verified, ₹) — do not flood vermilion. Saffron `--saffron` (#F29D10) warms;
  pink/teal accent.
- Surfaces: warm paper page (`--surface-page`), white cards (`--surface-card`), `ink` dark
  blocks. A full `[data-theme="ink"]` dark theme exists — keep token parity.
- Type: **Baloo 2** display (`--font-display`), **Mukta** body/multilingual (`--font-sans`,
  never below 16px / `--text-base`), **Roboto Mono** for data·₹·IDs (`--font-mono`, tabular).
- Money is `₹40` (no space) in mono tabular. Spacing on a 4px grid (`--space-*`). Radii:
  controls 14 / cards 18 / pills for chips. Motion: short `--ease-out`; one `--ease-stamp`
  spring for success.

**Fast rules (enforce).**
- Use **design tokens**, never raw hex / px literals for color, type, spacing, radius,
  elevation. The adherence oxlint flags raw values.
- Reuse the 24 primitives (Button, Input, Select, Card, Badge, Chip, Dialog, Toast, Tabs,
  StatTile, MaskedCandidate, JobCard, …) before inventing UI; take props from each `.d.ts`.
- **Masked-until-unlocked is a first-class visual pattern** — render the `MaskedCandidate`
  motif; never leak a worker name/phone.
- Voice: worker copy = warm "bada bhai" Hinglish ("no test, just talk"); **payer copy =
  crisp, operational**. Sentence case. One word: **BadaBhai**.
- Worker app: touch targets ≥ 48px (`--tap`); Phosphor icons paired with text labels;
  low-bandwidth / low-literacy first.

**Process.**
1. Identify the surface (payer-web Company / payer-web Agency / ops web / worker app) and open
   its `ui_kits/` recreation as the visual target.
2. Build from tokens + the matching primitive(s); pull the prop contract from the component `.d.ts`.
3. Hold the cross-cutting invariants: faceless/masked (no worker PII), ₹ formatting, green = action,
   voice per audience, tap targets, ink-theme parity.
4. Run the adherence check (`_adherence.oxlintrc.json`) + `bb-ui-review`.

**Checklist.**
- [ ] Color / type / spacing / radius / elevation come from tokens, not literals.
- [ ] Reuses DS primitives; new UI matches the `ui_kits/` recreation for that surface.
- [ ] Masked-until-unlocked respected; no worker name/phone rendered.
- [ ] ₹ in mono tabular, `₹40` no space; green is the action color; vermilion not flooded.
- [ ] Voice matches audience (worker Hinglish warmth vs payer operational).
- [ ] Worker app: ≥48px targets, icon+label, works low-bandwidth.
- [ ] Dark `[data-theme="ink"]` parity where applicable.

**Expected output.** On-brand UI / Flutter that passes adherence + `bb-ui-review`, reusing
tokens + primitives, with the masking, voice, and ₹ rules intact.

**Failure conditions.** Raw hex/px instead of tokens; reinventing a primitive; leaking worker
PII through an unmasked view; wrong voice for the audience; sub-48px worker targets.
