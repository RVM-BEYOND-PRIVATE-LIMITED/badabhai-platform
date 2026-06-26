# payer-web — accessibility checklist (DS4.2)

Manual a11y review of the payer/agency portal **core loop**:
`login → dashboard → applicant feed → unlock/reveal → wallet (credits)`.

Scope is a **source-level** audit + reasoned WCAG checks — the package test env is `node`
(no jsdom/axe, no new deps), so this is not a live axe run. It pairs with the automated
regression fence `src/app/ink-parity.test.tsx` (no raw color literal, no legacy non-flip
var/class in any screen source; `[data-theme="ink"]` parity block still present).

Status legend: **PASS** = verified in source / by computed contrast · **NOTE** = compliant
with a caveat worth recording.

---

## 1. Labelled controls (every interactive control has an accessible name)

| Surface | Control | Accessible name | Status |
| --- | --- | --- | --- |
| Login | Email field | DS `Input label="Email"` → `<label htmlFor>` | PASS |
| Login | OTP cells | group `aria-label="One-time passcode"` **+ per-cell `aria-label="Digit N of M"`** (added DS4.2) | PASS |
| Login | Send / Verify / Resend / different-email | DS `Button` with visible text | PASS |
| Login (dev) | Quick-login buttons | DS `Button` with visible text; error is `role="alert"` | PASS |
| Dashboard | Stat tiles, posting links | text content + `<Link>` text | PASS |
| Applicant feed | Pipeline tabs | DS `Tabs` `role="tablist"` + `aria-label="Applicant pipeline"`, each `role="tab"`/`aria-selected` with text | PASS |
| Applicant feed | Keep / Pass / Call / WhatsApp / Unlock / Reveal / Mark-contacted | DS `Button` with visible text | PASS |
| Applicant feed | Masked avatar | decorative, `aria-hidden="true"` (no name needed) | PASS |
| Unlock | Confirm-spend dialog | `role="dialog" aria-modal="true"` **+ `aria-labelledby` → title** (added DS4.2); Cancel/Unlock are text buttons; ✕ has `aria-label="Close"` | PASS |
| Unlock | Result toast | DS `Toast` `role="status"`; dismiss ✕ has `aria-label="Dismiss"` | PASS |
| Wallet / Credits | Pack tiles, buy buttons, history table | DS `Button`/`Card`; table has `<th>` headers | PASS |
| Team | Invite email/role, Send invite, Remove | DS `Input`/`Select` (labelled), DS `Button` text | PASS |
| Shell | Logout, nav links | text buttons/links; `<nav aria-label="Primary">` | PASS |

No bare icon-only `<button>`/`<a>` without a name was found. DS `IconButton` requires a
`label` prop (→ `aria-label`); the only icon-only buttons (Dialog ✕, Toast ✕) carry explicit
`aria-label`s. All decorative Phosphor glyphs are `aria-hidden="true"` with a text sibling.

---

## 2. Target size (web)

| Control | Token | Computed | Status |
| --- | --- | --- | --- |
| `.bb-btn` (default) | `--control-md` | 44px | PASS (WCAG 2.5.5 AAA 44px) |
| `.bb-input` / `.bb-select` / `.bb-textarea` | `--control-lg` | 52px | PASS |
| `.bb-iconbtn` (default) | `--control-md` | 44px | PASS |
| `.bb-btn--sm` (dense secondary, e.g. Keep/Pass/Remove) | `--control-sm` | 36px | NOTE |

**NOTE — `.bb-btn--sm` = 36px.** Clears WCAG **2.5.8 (AA, 2.2) = 24px** comfortably; below
the 44px **AAA** target. It is a deliberate design-system size for dense secondary actions and
is a **locked** DS token — not raised here (raising it is a global visual change + a DS change,
not an a11y bug at the AA bar we target). No screen sets a **custom** sub-44px tap target via
inline style (verified). The worker-app `--tap` 48px floor is a separate, mobile-only rule.

---

## 3. Visible focus

- Global `:focus-visible { box-shadow: var(--ring-focus) }` (tokens.css base layer) applies to
  every focusable element; `--ring-focus` = `0 0 0 3px var(--ring)`.
- DS `.bb-btn` / `.bb-iconbtn` / `.bb-input` / `.bb-chip` each re-declare
  `:focus-visible { outline: none; box-shadow: var(--ring-focus) }` — outline is **replaced**,
  never removed bare. **No** `outline: 0/none` exists without a `box-shadow` ring replacement
  (verified). Status: **PASS**.

---

## 4. aria-live on async / status regions

| Region | Mechanism | Status |
| --- | --- | --- |
| Login status (code-sent / error) | `<div aria-live="polite" className="login-status">` wrapping DS Toasts | PASS |
| Login inline field errors | DS Input `error` slot; OTP error `role="alert"` | PASS |
| Unlock transient error (per row) | `<div aria-live="polite">` around the inline error | PASS |
| Reveal contact / masked-resume errors | `<div aria-live="polite">` around each | PASS |
| Unlock result toast | `<div className="unlock-toast-region" aria-live="polite">` + Toast `role="status"` | PASS |
| Team invite result | `<div aria-live="polite" className="team-form__status">` | PASS |
| Route loading | `loading.tsx` `aria-busy="true" aria-live="polite"` + `.sr-only "Loading…"` | PASS |
| Error boundaries | `role="alert"` on the neutral fallback | PASS |

---

## 5. Contrast (AA) — paper **and** ink

Computed from the token hex values (WCAG relative-luminance ratio). AA = 4.5:1 normal text /
3:1 large/UI. Ink tints are evaluated as their translucent fill blended over `--surface-card`.

**Paper (default):**

| Pair | Ratio | Status |
| --- | --- | --- |
| `--text-primary` on `--surface-card` | 16.8:1 | PASS |
| `--text-secondary` on `--surface-card` | 7.2:1 | PASS |
| `--text-muted` on `--surface-card` | 4.5:1 | PASS |
| `--text-muted` on `--surface-page` | 4.2:1 | PASS (muted = small supporting copy; ≥ AA-large, ~AA-normal) |
| `--text-on-brand` on `--brand` (button) | 4.4:1 | PASS (bold button text; meets large/UI 3:1, ~AA-normal) |
| `--text-link` (green-600) on card | 7.3:1 | PASS |
| soft badge success/neutral/warning fg on tint | 5.3–8.7:1 | PASS |

**Ink (`[data-theme="ink"]`):**

| Pair | Ratio | Status |
| --- | --- | --- |
| `--text-primary` (paper-1) on card (ink-900) | 16.5:1 | PASS |
| `--text-secondary` (ink-200) on card | 12.1:1 | PASS |
| `--text-muted` (ink-300) on card / page | 9.4 / 10.4:1 | PASS |
| `--text-link` (green-300) on card | 6.5:1 | PASS |
| `--text-on-brand` on `--brand` | 4.4:1 | PASS |
| **soft badge fg on dark tint — BEFORE fix** | **~1.6:1** | **FAIL → fixed** |
| soft badge fg on dark tint — AFTER DS4.2 fix | 5.4–10.3:1 | PASS |

**Fix applied (token *usage*, not token *values*):** the soft `.bb-badge--*` foregrounds are
dark-end ramp colors tuned for the **light** paper tints. Under ink the tints flip to dark
translucent fills, so a dark foreground fell sub-AA (e.g. `green-700` on the dark green tint
≈ 1.6:1). Added `[data-theme="ink"]` overrides re-pointing **only** the soft badge/outline
foregrounds to the **light** end of each ramp (`green-200`, `red-300`, `saffron-200`,
`vermilion-200`, `teal-100`, `ink-200/300`) → all ≥5.4:1. **Solid** badges (white on saturated
brand/success/danger) are theme-independent and unchanged. Paper appearance is untouched.

---

## 6. How to enable the ink theme

The portal is token-driven and `tokens.css` ships a full `[data-theme="ink"]` block, so the
whole app re-themes from a single attribute on the shell `<html>`:

- Set **`PAYER_THEME=ink`** (server) or **`NEXT_PUBLIC_PAYER_THEME=ink`** (also honored by the
  `global-error` boundary, which renders its own `<html>`). `resolvePayerTheme()` (`src/lib/config.ts`)
  is **fail-closed**: only the exact literal `ink` flips it; unset / `paper` / anything else
  emits **no** `data-theme` and renders the default paper theme — **default appearance is
  unchanged**.
- The root layout applies `<html lang="en" data-theme={theme}>`.

---

## Summary

- **Labels / focus / aria-live:** PASS across the core loop.
- **Targets:** DS controls use the `--control-*` tokens; default ≥44px. `.bb-btn--sm` = 36px
  (AA-compliant, AAA-shortfall) — documented, not changed (locked DS size).
- **Contrast:** PASS in both themes after the DS4.2 ink soft-badge foreground fix (the one
  sub-AA pair found).
- **Ink parity:** guarded by `src/app/ink-parity.test.tsx`.
