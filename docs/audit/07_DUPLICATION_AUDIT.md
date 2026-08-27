# 07 — Duplication Audit

Duplicated implementations found across the platform, with consumers, whether each is
accidental or a deliberate/documented split, and a migration recommendation. **Nothing is
consolidated by this audit** — each item is a candidate for a future, individually-reviewed PR.

## Genuine duplication — recommend consolidating

### DU-1 — `apps/payer-web` `/profile` page is a near-verbatim duplicate of `/account`

- **Implementation A**: `apps/payer-web/src/app/(portal)/account/page.tsx` (166 lines, tested,
  linked from nav)
- **Implementation B**: `apps/payer-web/src/app/(portal)/profile/page.tsx` (160 lines, zero
  tests, not linked from nav)
- **Behavior difference**: title/copy text and the imported form-component name only — same
  error state, identity panel, `AccountForm` embed, agent-only KYC/bank alert cards.
- **Consumers**: `/account` via nav; `/profile` only via direct URL (old bookmarks/links per
  the page's own docstring).
- **Preferred implementation**: `/account` (tested, nav-linked, actively maintained).
- **Migration strategy**: replace `/profile/page.tsx`'s body with either (a) a shared
  `<AccountScreen title="Profile" .../>` component both routes render, or (b) a redirect from
  `/profile` to `/account` if product doesn't need two distinct URLs. Either removes the
  ~150-line duplicate while keeping `/profile` from 404ing.
- **Regression risk**: low — presentational only, no auth/data-shape change either way.
- See [06_DEAD_CODE_AUDIT.md#dc-2](06_DEAD_CODE_AUDIT.md) for the full evidence trail.

### DU-2 — `WavyText` component vs. `BadaBhaiLogo`'s private `wavyChars()` reimplementation

- **Implementation A**: `apps/payer-web/src/components/ds/wavy-text.tsx` — the documented,
  reusable, exported DS primitive. Zero consumers.
- **Implementation B**: `apps/payer-web/src/components/ds/logo.tsx`'s private `wavyChars()`
  helper (lines 22–30) — reimplements the identical per-letter staggered-wave animation inline.
- **Consumers**: only B is live (via `BadaBhaiLogo`).
- **Preferred implementation**: make `BadaBhaiLogo` compose `WavyText`, or delete `WavyText` if
  the design system doesn't want the primitive exposed generally.
- **Migration strategy**: single-file change either direction; defer to design-engineer.
- **Regression risk**: low — presentational only.

### DU-3 — `emailSchema`/OTP-digits validation duplicated between payer-web and admin-web logins

- **Implementation A**: `apps/payer-web/src/app/login/actions.ts:20-21`
- **Implementation B**: `apps/admin-web/src/app/login/actions.ts:28-29` — byte-identical
  `emailSchema` (`z.string().trim().toLowerCase().email().max(254)`); OTP-digit regex differs
  only in length (6 fixed vs 4–8 range for admin TOTP).
- **Notable**: `payer-web`'s same file already imports a shared schema (`e164PhoneSchema`) from
  `@badabhai/validators`, which has no email/OTP schema despite already housing exactly this
  class of primitive. `admin-web` doesn't even depend on `@badabhai/validators` yet.
- **Preferred implementation**: add `emailSchema`/`otpDigitsSchema` (parameterized length) to
  `@badabhai/validators`.
- **Migration strategy**: low urgency — next time either login flow is touched.
- **Regression risk**: low.

### DU-4 — `shouldUseSecureCookie()` duplicated between payer-web and admin-web

- **Implementation A**: `apps/payer-web/src/lib/auth/session-cookie.ts:24-37` (2026-06-26)
- **Implementation B**: `apps/admin-web/src/lib/auth/session-cookie.ts:30-43` (2026-08-04,
  written by copying A's pattern)
- Same three-signal logic (`NODE_ENV`, `NEXT_PUBLIC_ENVIRONMENT`,
  `NEXT_PUBLIC_SITE_URL`/`VERCEL_URL` https check), differing only in comments.
- **Preferred implementation**: extract to `@badabhai/config` or a new shared web-auth package.
- **Migration strategy**: low urgency, but do it before a third principal copies the pattern a
  third time (e.g. if a worker-app web surface is ever added).
- **Regression risk**: low.

### DU-5 — ₹ (rupee) formatting independently implemented three times, with a shipping inconsistency

- **Implementation A**: `apps/payer-web/src/lib/format.ts` (`formatInr`) — throws on
  non-integer/negative, `en-IN` digit grouping.
- **Implementation B**: `apps/admin-web/src/lib/format.ts` (`formatRupees`/`formatCount`) —
  `Intl.NumberFormat("en-IN")`, no validation.
- **Implementation C**: `apps/web/src/app/ops/pricing/page.tsx:136,171` — raw
  `` `₹${o.value}` ``, **no digit grouping at all**.
- **Real, currently-shipping inconsistency**: a payer sees "₹2,000"; an ops operator on the
  same platform, viewing the same pricing catalog, sees "₹50000". `packages/pricing` (which all
  three apps already depend on for catalog types) has no formatting export.
- **Preferred implementation**: add a shared formatter to `packages/pricing` or
  `@badabhai/config`, given the design system calls out "₹ in mono tabular" as a cross-app
  invariant.
- **Migration strategy**: low priority (apps/web is internal-only) but a real fast-follow.
- **Regression risk**: low.

### DU-6 — Three independent HTTP-retry/rolling-token implementations across the two Flutter apps

- **Implementation A**: `apps/worker-app/lib/core/api/api_client.dart` (`_send`)
- **Implementation B**: `apps/worker-app/lib/core/auth/authed_client.dart` (`send`/`_attempt`/`_refresh`)
- **Implementation C**: `apps/payer-app/lib/core/auth/payer_http.dart` (`send`/`_rawSend`/`_adoptRollingToken`)
- Each independently implements the same 15s `kRequestTimeout` constant, `x-session-token`
  rolling-token adoption, 401→single-refresh→single-retry, and manual `jsonDecode` with
  try/catch fallback — including matching doc-comment language ("single-flight", "rolling
  token").
- **Root cause**: `packages/` contains only TypeScript packages; there is no shared Dart
  package between the two Flutter apps.
- **Preferred implementation**: none yet — this is architectural, not a simple pick-A-over-B.
- **Migration strategy**: not recommended for action now; log as a backlog item to extract a
  shared `packages/flutter_http_core` (timeout const, rolling-token, 401-retry) **if and when**
  a third Flutter client is added — premature to build a shared package for two consumers.
- **Regression risk**: N/A (no action recommended).

### DU-7 — Design-system widget primitives hand-duplicated between worker-app and payer-app, already drifting

- 8 identically-named files exist in both `apps/worker-app/lib/core/widgets/` and
  `apps/payer-app/lib/core/widgets/` (`bb_bottom_nav`, `bb_button`, `bb_chat_bubble`, `bb_chip`,
  `bb_scaffold`, `bb_status_view`, `bb_success_stamp`, `bb_tag.dart`), each re-deriving the same
  `docs/design/` tokens by hand.
- **Evidence of drift**: `bb_chip.dart` differs between apps in which token name maps to the
  selected-chip fill (`AppColors.haldi` vs `AppColors.brand`) for what should be the same
  design-system color; `app_colors.dart` comment provenance has already diverged ("JUL31 kit"
  vs "JUL31 JOSH system" with differently-worded token legends).
- **Preferred implementation**: none yet — same root cause as DU-6 (no shared Flutter package).
- **Migration strategy**: flag to Frontend Product / design-engineer as a token-drift risk
  worth a shared package once there's bandwidth; not urgent enough to action solo.
- **Regression risk**: N/A (no action recommended).

## Deliberate, documented duplication — do not consolidate

### DU-8 — Ops-vs-payer duplicate money/data surfaces in apps/api (3 controller pairs)

| Ops-only (retained) | Payer-scoped (canonical) | Shared service |
|---|---|---|
| `unlocks.controller.ts` | `payer-unlocks.controller.ts` | `UnlockService` |
| `resume-disclosure.controller.ts` | `payer-disclosure.controller.ts` | `ResumeDisclosureService` |
| `posting-plans.controller.ts` | `payer-job-postings.controller.ts` | `PostingPlansService` |

Each ops controller carries an explicit docstring naming its payer-scoped replacement,
stating it "MUST NEVER be network-exposed to payers" and is `@deprecated for the PAYER path`.
`guard-contract.test.ts` pins the one-principal-per-route split
(`Unlocks=[InternalServiceGuard]; PayerUnlocks=[PayerAuthGuard]`), actively guarding against
accidental convergence. **Two named, tracked blockers keep the ops routes alive**: ops-console
admin auth (ADMIN-4..8/OBS-4, deferred) and a headless payer-session mint for
`db:verify:demand` (TD33/TD50). **Recommendation: KEEP both sides** — this is tracked technical
debt with a named unblock path, not an audit finding requiring new action.

**(2026-08-26, #1166): the 4th pair — `posting-plans/capacity.controller.ts` vs
`payer-capacity.controller.ts` — is REMOVED from this table.** The ops `CapacityController`
was retired outright (not kept alongside its payer-scoped twin): it had no caller anywhere
in the repo, its own Flutter capacity-purchase UI had already been removed, and unlike the
other three ops routes above it had no named unblock blocker keeping it alive. The payer-
scoped `payer-capacity.controller.ts` is now the only route onto `PostingPlansService`'s
capacity surface.

### DU-9 — `apps/web` and `apps/payer-web`'s parallel `unlock-view.ts`

Same filename, same no-oracle response-mapper pattern, applied to two different backend
endpoint families (`/unlocks` internal-service vs `/payer/unlocks` payer-JWT) with genuinely
different response shapes (`ContactView`/masked-resume fields exist only in payer-web's). The
payer-web file's own docstring says "mirrors apps/web's unlock-view.ts" — a deliberate,
self-documented parallel implementation of a security invariant, not accidental duplication.
**Recommendation: KEEP both** — the wire types genuinely differ.

### DU-10 — Three independently-built HTTP transport wrappers across the three web apps

`apps/web/src/lib/api.ts`, `apps/payer-web/src/lib/payer-http.ts`,
`apps/admin-web/src/lib/admin-http.ts` share a shape (no-store fetch, JSON body,
status-carrying custom `Error` subclasses, header injection) but each encodes a genuinely
different security boundary (shared internal-service secret vs. two distinct JWT cookie
principals with different `SameSite` policies). `admin-web`'s version has meaningfully more
maturity (request timeout via `AbortSignal.timeout`, 401/403 distinction, malformed-JSON
handling) than the other two. **Recommendation: do not consolidate** — collapsing these into
one shared client would risk conflating three different threat models. Flagged for
completeness only.

### DU-11 — Email pipeline (already consolidated — negative result, recorded to prevent re-flagging)

ZeptoMail was implemented twice historically (payer login channel + org-member invite mailer);
already consolidated as an ADR-0038 prerequisite (`email-notification.service.ts`'s own
docstring documents the history). Both call sites now delegate to the single service. No action
needed.

## Summary table

| ID | Duplication | Type | Recommendation |
|---|---|---|---|
| DU-1 | payer-web `/profile` vs `/account` | Accidental | Consolidate |
| DU-2 | `WavyText` vs `wavyChars()` in `BadaBhaiLogo` | Accidental | Consolidate |
| DU-3 | Email/OTP validation schemas | Accidental | Consolidate into `@badabhai/validators` |
| DU-4 | `shouldUseSecureCookie()` | Accidental (copied) | Consolidate into shared config |
| DU-5 | ₹ formatting (3-way, inconsistent output) | Accidental | Consolidate — real UX inconsistency |
| DU-6 | Flutter HTTP-retry/rolling-token (×3) | Architectural | Defer — no 3rd consumer yet |
| DU-7 | Flutter DS widgets (×2 apps, drifting) | Architectural | Defer — flag to design-engineer |
| DU-8 | Ops-vs-payer controller pairs (×4) | Deliberate | Keep — tracked blockers (TD33/TD50) |
| DU-9 | `unlock-view.ts` (×2) | Deliberate | Keep — different wire types |
| DU-10 | Web HTTP transport wrappers (×3) | Deliberate | Keep — different threat models |
| DU-11 | Email pipeline | Already fixed | No action |
