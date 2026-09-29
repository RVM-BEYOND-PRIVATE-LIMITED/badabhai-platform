# @badabhai/design-tokens

The brand token layer for the web portals: one file, `tokens.css`, of CSS custom properties
plus a small base layer. CSS only — no build step, no runtime, no JS exports.

Consumers: `apps/payer-web` (Company + Agency) and `apps/admin-web`. Each declares
`"@badabhai/design-tokens": "workspace:*"` and imports the file at the top of
`src/app/globals.css`:

```css
@import "@badabhai/design-tokens/tokens.css";
```

Importing it is not side-effect free: besides the variables it sets the reset, `body`,
`h1`–`h5`, `a`, `:focus-visible` and `::selection`, and ships the `.bb-*` / `.ui-*` helper
classes and the `.bb-lockup` logo classes (`package.json` declares `sideEffects: ["*.css"]`).

## Brand source

The Sept 2026 brand kit — `BB - Brand Guidelines.pdf` (colour palette with 80/60/40 tints,
Kilimanjaro Sans headings, Inter body/UI, the two-figure monogram, the BADABHAI logotype) —
restated in the UI/UX block of `CLAUDE.md`. It fixes three colours and two families.
Everything else here (ramps, neutrals, status hues, radii, elevation, motion) is derived from
those values and from the worker app, which already ships the palette in
`apps/worker-app/lib/core/theme/onboarding_theme.dart`. `docs/design/` is an older proposal
("Desi Vernacular Pop") and is NOT the brand.

| CLAUDE.md name          | Value                   | Ramp token        | Role                                         |
| ----------------------- | ----------------------- | ----------------- | -------------------------------------------- |
| `--color-brand-primary` | `#05194C` Shift Blue    | `--navy-900`      | structure: rail, headers, headings, wrappers |
| `--color-brand-accent`  | `#FFB32C` Safety Yellow | `--vermilion-500` | the one action per view, every active state  |
| `--color-brand-surface` | `#F3F5F4` Ivory         | `--paper-2`       | page background                              |

Cards are white (`--surface-card` → `--paper-0`) on the Ivory page. Headings use
`--font-display` (Kilimanjaro Sans), body/UI `--font-sans` (Inter), data/IDs/₹ `--font-mono`
(Roboto Mono). Radii: controls 10 (`--radius-md`), cards 14 (`--radius-lg`), dialogs 16
(`--radius-xl`). Shadows are navy-tinted and quiet; the CTA is flat (`--shadow-brand: none`).

## Naming contract

- The semantic names (`--brand`, `--primary`, `--surface-*`, `--text-*`, `--border-*`,
  `--focus-ring` …) are the names the portals were written against, so their `var(--…)` call
  sites re-skin by value, not by edit. Change values, not names.
- `--brand` / `--primary` = Safety Yellow, the ACTION colour. Text on it is always
  `--text-on-brand` (Shift Blue, 9.39:1).
- `--blue-500` = Shift Blue, the STRUCTURE colour. Razorpay's checkout reads it by name — do
  not rename it.
- `--vermilion-*`, `--saffron-*` and `--marigold-*` are historical names that all resolve to
  the Safety Yellow ramp; `--pink-*` / `--teal-*` fold to navy.
- `--amber-*` (and `--warning`) is caution and deliberately NOT the accent (#1103).
- `--text-heading` is Shift Blue on light surfaces (15.34:1 on Ivory) and white under ink.
- The `CLAUDE.md` names (`--color-brand-primary` / `-accent` / `-surface`) are aliases; new
  components can name the brand role directly.

## Links and focus: navy on light, yellow on navy

The brand block lists yellow for text links, but yellow fails as text on a light surface:

| Pair                                  | Ratio                                |
| ------------------------------------- | ------------------------------------ |
| Safety Yellow on Ivory                | 1.63:1 (under 4.5:1 text and 3:1 UI) |
| Safety Yellow on white                | 1.79:1                               |
| `--text-link` (`--navy-700`) on Ivory | 11.65:1                              |
| Safety Yellow on Shift Blue           | 9.39:1                               |
| Safety Yellow on the ink-theme card   | 9.77:1                               |

So on light surfaces the link is navy text and yellow is the accent (hover underline via
`--border-accent`, the active spine). `--focus-ring` is Shift Blue (16.8:1 on white) and moves
to Safety Yellow under `[data-theme="ink"]`, as does `--text-link`. `--ring-focus` is two-tone
(a 2px `--surface-card` band, then 2px of `--focus-ring`) so it reads on a yellow button too.

## Alpha ladder

`CLAUDE.md` asks for 80 / 60 / 40 % step-downs of the primary tokens. They are declared once,
from channel tokens, so no component writes an `rgb()`/`rgba()` literal (the TSX adherence
fence bans them in screen sources):

- `--brand-primary-rgb` (`5 25 76`), `--brand-accent-rgb` (`255 179 44`)
- `--color-brand-primary-80` (8.61:1 on Ivory), `--color-brand-primary-60`,
  `--color-brand-primary-40`
- `--color-brand-accent-80`, `--color-brand-accent-60`, `--color-brand-accent-40`

Semantic users: `--text-disabled` = primary-40 (disabled, exempt from AA), `--icon-secondary`
= primary-60. If a component needs another alpha, add a named token here.

## On-navy chrome

The rail, sidebar and hero bands are always Shift Blue, so these are the same in both themes:

| Token                    | Value                | Use                             |
| ------------------------ | -------------------- | ------------------------------- |
| `--surface-ink`          | `--navy-900`         | the band itself                 |
| `--surface-ink-2`        | `--navy-950`         | pressed / deepest wrapper       |
| `--surface-ink-hover`    | `--navy-800`         | hover on navy                   |
| `--surface-ink-raised`   | `--navy-700`         | pill / raised on navy           |
| `--surface-ink-active`   | Safety Yellow at 14% | active nav item wash            |
| `--text-on-ink`          | white                | text on navy (16.8:1)           |
| `--text-on-ink-muted`    | `--navy-200`         | secondary text on navy (9.97:1) |
| `--text-on-ink-active`   | Safety Yellow        | active item text (9.39:1)       |
| `--text-on-ink-disabled` | white at 40%         | disabled on navy                |
| `--border-on-ink`        | white at 10%         | dividers on navy                |
| `--border-spine`         | `3px`                | active-nav spine width          |

Logo: `.bb-lockup` (`__tile`, `__mark`, `__word`, `__sub`) puts the mark on a Shift Blue tile;
`.bb-lockup--on-ink` drops the tile on a navy band. Size with `--bb-lockup-size` (defaults to
`--logo-mark-md`; `--logo-mark-sm` / `-lg` also exist).

## Fonts

- `--font-display`: `"Kilimanjaro Sans"`, bundled in this package
  (`fonts/KilimanjaroSans-Regular.woff`, converted from the brand kit's OTF) and declared by an
  `@font-face` with a **relative** URL, so each app's bundler emits it under `/_next/static`.
  One face (Regular, already a heavy display cut) is declared across weights 100–900 so a
  bold heading never gets a synthetic bold. It has no ₹ and no Devanagari; Anek (loaded by
  each app) sits behind it and takes those glyphs. Headings use `--tracking-display` (0).
  **Licence:** the font is commercial ("Nicky Laatz 2022 – All rights reserved"). The owner
  ruled on 2026-09-29 to ship it in this public repo, accepting that.
- `--font-sans`: Inter, then Roboto — buttons, labels, body. Inter ships no Devanagari and
  fallback resolves per glyph, so Hindi/Hinglish runs render in Roboto; Roboto must stay in
  each app's font URL.
- `--font-mono`: Roboto Mono, self-hosted. These `@font-face` URLs are root-relative
  (`/fonts/…`), so they resolve against the importing app: the files live in
  `apps/payer-web/public/fonts` and `apps/admin-web/public/fonts` as byte-identical copies.

## Logo

`.bb-lockup*` draws the brand kit's lockup: the monogram (`/brand/badabhai-mark.png`) on a
Shift Blue tile on light surfaces, straight on the band on navy (`.bb-lockup--on-ink`), and the
official logotype image (`/brand/badabhai-wordmark.png` white, `…-wordmark-navy.png` Shift
Blue) cropped from the kit's `Logotype.png`. The files live in each app's `public/brand/`.

## Changing a token safely

- One edit re-skins **both** portals (payer-web Company + Agency, and admin-web). Check both.
- Keep `[data-theme="ink"]` in step: a light value that changes meaning needs its ink
  counterpart reviewed.
- Tests that read this file:
  - `apps/payer-web/src/app/ink-parity.test.tsx` — payer-web's `globals.css` must import
    `@badabhai/design-tokens/tokens.css` (not a local copy), and the first
    `[data-theme="ink"]` block here must exist and flip `--surface-page` to `var(--ink-950)`
    and `--text-primary` to `var(--paper-1)`.
  - `apps/payer-web/src/app/agency-b5-layout.css.test.ts` — reads `--border-hairline`,
    `--gutter`, `--space-5`, `--space-6` as bare px lengths (their first declaration) and
    requires `--z-sticky` > `--z-raised`.
- Run `npx vitest run` in `apps/payer-web` and `apps/admin-web`.
- A colour change re-measures contrast: update the ratio in the comment here and in
  `docs/design/payer-web-a11y-checklist.md` §5.
- CI: `packages/design-tokens/**` is in both the `payer-web` and `admin-web` path filters of
  `.github/workflows/ci.yml`, so a token edit re-runs both image gates. The `node` job has no
  path filter, and turbo hashes this package's files into both apps' `build`/`test` task
  hashes through the workspace dependency (a `<NONEXISTENT>` `build` task in `--dry=json`), so
  a restored cache entry is not reused after an edit.
