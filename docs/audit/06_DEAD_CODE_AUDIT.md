# 06 — Dead Code Audit

Confidence bands per the audit charter: **95–100%** = verified dead via static + git + CI
evidence all agreeing; **80–94%** = strongly suspected, runtime verification recommended;
**50–79%** = ambiguous, default to KEEP; **<50%** = keep, not listed here. **Nothing in this
document is deleted by this audit** — every item is a candidate for a future, separately
authorized, individually-verified removal PR.

## 95–100% confidence

### DC-1 — 6 orphaned Flutter widget files (mobile-engineer)

| File | Class | Evidence |
|---|---|---|
| `apps/payer-app/lib/core/widgets/bb_scaffold.dart` | `BbScaffold` | Zero references outside its own declaration; every payer-app screen calls the raw Flutter `Scaffold(` directly. No test file. |
| `apps/payer-app/lib/core/widgets/bb_success_stamp.dart` | `BbSuccessStamp` | Zero references, no test file. |
| `apps/payer-app/lib/core/widgets/bb_switch_row.dart` | `BbSwitchRow` | Zero references, no test file. |
| `apps/payer-app/lib/core/widgets/bb_tag.dart` | `BbTag` | Zero references, no test file. |
| `apps/worker-app/lib/core/widgets/bb_festive_card.dart` | `BbFestiveCard` | Zero imports; superseded by `BbJobCard`. Old comments in `job_deck.dart` still reference it as historical context. |
| `apps/worker-app/lib/core/widgets/bb_otp_row.dart` | `BbOtpRow` | Zero references anywhere, including comments; `otp_verify_screen.dart` builds OTP boxes inline instead. |

**Git evidence**: all 6 last touched by the same commit, `14f2b994` ("JUL31 kit redesign
…(#579)", 2026-08-05) — scaffolding/superseded remnants of one redesign, ~8 days stale.
**CI evidence**: `flutter_lints` (both apps' `analysis_options.yaml`) does not flag unused
top-level public classes/files — only unused imports and unused *private* members — so a green
`flutter analyze` gives zero signal against any of these 6. No `export` statements exist in
either app's `lib/` (`grep -rn "^export"` → 0 hits), so the Dart import graph is conclusive:
there is no indirect/barrel path that could construct these classes.
**Risk**: low — presentational, no data/auth surface, each has zero consumers.
**Recommended verification**: confirm with the worker-app/payer-app owner (Rishi) before a
cleanup PR — the audit's own static evidence is conclusive but a human sign-off on Flutter
UI-library cleanup is still worth a quick check given no automated gate catches this class of
regression. Delete file + any DS-story/index reference together, in one PR per app.

### DC-2 — `apps/payer-web/src/app/(portal)/profile/page.tsx` (frontend-engineer)

A ~95%-verbatim, ~150-line duplicate of `apps/payer-web/src/app/(portal)/account/page.tsx`
(same JSX structure — error state, identity panel, `AccountForm` embed, agent-only KYC/bank
alert cards — differing only in title text, sub-copy, and the component name). Not imported
from `nav-model.ts` (deliberately dropped from nav per that file's own comment); has **zero**
test files, while `account/` has two. Git evidence: `account/page.tsx` predates `profile/`
by five weeks; `profile/page.tsx` was added inside an unrelated feature commit (`e8f07445`,
ADR-0035 job-posting-chat work) rather than as a deliberate "preserve legacy route" refactor —
the `nav-model.ts` comment framing it as a pre-existing orphaned surface postdates the page's
actual introduction by 12 days.

This is **not a delete candidate** — `/profile` must keep resolving as a URL (bookmarks/old
links) — it is a **consolidation candidate**: replace the duplicated body with a shared
component or a redirect to `/account`. See
[07_DUPLICATION_AUDIT.md](07_DUPLICATION_AUDIT.md#du-1) for the consolidation recommendation.

## 80–94% confidence

### DC-3 — `apps/ai-service/app/corpus/` package (ai-engineer)

5 files (`__init__, assemble, consent_gate, deidentify, finetune_sample.py`, 436 lines) + test
files (255 lines) implementing the ADR-0018 model-training-corpus/fine-tune track. Zero
importers anywhere in `apps/ai-service` outside its own package/tests. No CLI entrypoint. The
ADR it implements (`docs/decisions/0018-model-training-corpus-and-finetune.md`) does not exist
on `origin/main` — only in two stale worktrees. `docs/architecture/overview.md` states the
service's current scope as "exactly three jobs: pseudonymize, embed, parse," with no mention of
corpus assembly. All 5 files were added in the `29e65fd5` squash-point commit (see
[17_GIT_HISTORY_AUDIT.md](17_GIT_HISTORY_AUDIT.md)), so their true introduction date is
unknown. **Risk of removal**: low technically, but medium in substance — this implements a
real privacy-sensitive consent/de-identification pipeline; if a training-corpus initiative is
still planned, it may be intentionally-parked scaffolding. **Recommended verification**: ask
the human owner whether ADR-0018 is active, shelved, or should be formally archived (either
restore the ADR doc, or remove the package + tests together).

### DC-4 — `apps/ai-service/app/ai/embeddings.py::embed_aliases` + `AliasStore` Protocol (ai-engineer)

Zero concrete `AliasStore` implementation anywhere; every call site of `embed_aliases()` is in
its own test file. The actually-live batch-embed path is the HTTP route
`/embeddings/skill-alias`, called by `packages/db/src/embed-skill-aliases.ts` — that route's
own test comment explicitly notes engineers already know the runner doesn't go through
`embed_aliases`. Matches the documented DB-free service architecture (this function presupposes
a direct DB-backed store the service was never built to have). **Risk**: low, well-isolated.
**Recommended verification**: confirm with PR #214 (TAX-3) whether this was an earlier design
iteration abandoned in favor of the runner-owns-DB pattern before removing.

### DC-5 — Legacy Pydantic/Zod profiling contracts (ai-engineer) — cross-language, Architect-owned

`ProfilingTurnInput/Output`, `ProfilingOpeningInput/Output` in
`apps/ai-service/app/contracts.py:602-649` and their Zod mirrors in
`packages/ai-contracts/src/conversation.ts:122-179`. No route uses them — the live
`/profiling/turn` route uses a different class (`LlmTurnInput`/`LlmTurnOutput`). Referenced
only by the cross-language parity-test harness. `routers/profiling.py`'s own module docstring
states this file "was DELETED by the OIE Phase 8 cutover... these are that old shape, kept
alive only by the parity-test harness." **This crosses the Zod↔Pydantic contract seam the
Chief Software Architect owns** — not a routine dead-code removal. **Recommended
verification**: Architect confirms no external/mobile consumer expects this shape, then
removes from both sides + the parity fixture together.

### DC-6 — `apps/payer-web/src/components/ds/wavy-text.tsx` (`WavyText`) (frontend-engineer)

Exported from the DS barrel; zero JSX usage anywhere (`grep "<WavyText"` → 0). The **only** DS
primitive missing from the DS0.2 render-test's mount list. The stronger signal:
`components/ds/logo.tsx`'s `BadaBhaiLogo` hand-rolls its own private `wavyChars()` helper that
reimplements the exact same staggered-wave animation `WavyText` already provides, instead of
composing it — so the CSS/animation is genuinely live, just not through the reusable component
built for it. Added 2026-06-27, never modified or consumed since. **Risk**: low, presentational.
**Recommended verification**: either delete `wavy-text.tsx` + its barrel export, or make
`BadaBhaiLogo` compose `WavyText` and delete the duplicate `wavyChars()` — defer to
design-engineer/Frontend Product on which.

## 50–79% confidence (default to KEEP — listed for awareness only)

- **DC-7** — `packages/reach-learn` (entire package, 8 source files, ADR-0017 offline
  learn-to-rank layer). Zero runtime importers anywhere (system-architect and backend-engineer
  both independently confirmed this). Actively maintained (commits through 2026-07-31), fully
  tested, documented as "promotion to live ranking is a SEPARATE human-gated decision." This is
  a **build-ahead-of-use asset**, not orphaned debris — confidence it has zero consumers is
  95–100%, but confidence it is "dead" in the pejorative sense is 50–79% given the deliberate
  design intent. **Recommended verification**: confirm with the Architect/product owner whether
  a human-run calibration job is planned before the next reach-ranking iteration.
- **DC-8** — `packages/db/src/schema/payer.ts`'s `payerFormDrafts` table. Zero
  repository/service consumers. The table's own code comment explicitly self-flags:
  *"DELIBERATE FORWARD SCAFFOLDING — NOT DEAD CODE... if no future workstream claims it within
  a reasonable window it should be RECONSIDERED (via an ADR) rather than silently deleted."*
  This audit defers to that instruction — a human/PM decision on whether "a reasonable window"
  has passed is the only next step, not a removal recommendation.
- **DC-9** — `packages/db/src/score-wedge.ts`, a manually-invoked TAX-5 recalibration CLI
  script with no `package.json` alias (the sole `src/*.ts` CLI file without one). Introduced
  2026-07-15, part of an active, documented, human-gated recalibration workflow. Flagged only
  as a discoverability gap (should get a `db:score:wedge` alias), not as abandonment.
- **DC-10** — `apps/ai-service/app/ai/errors.py`'s `TRANSPORT_REASON_CODES` frozenset —
  defined, never referenced anywhere including its own test file (the individual `REASON_*`
  constants it aggregates *are* used). Negligible risk either way; a `ruff` unused-symbol pass
  would need a non-default rule to catch it.
- **DC-11** — 6 DS primitives in `apps/payer-web/src/components/ds/*`
  (`IconButton, Checkbox, Radio, Switch, Tooltip, JobCard`) — exported and story-tested, but no
  real-screen JSX usage. `ThemeToggle` notably hand-rolls its own switch instead of using the DS
  `Switch`. Not flagged as dead: each has a matching design-contract file under
  `docs/design/BadaBhai Design System/components/*.d.ts`, consistent with a component-library-
  built-ahead-of-consuming-screens pattern already established elsewhere in this repo (DC-7,
  DC-8). Token/primitive removal requires design-engineer/Frontend Product sign-off regardless.
- **DC-12** — `apps/payer-web/src/lib/invite-landing.ts`'s `pingInviteClick` and
  `apps/payer-web/src/app/(portal)/agency/invites.controller`'s agent-scoped
  `POST /payer/agency/invites/:code/click` — the latter has no confirmed frontend caller
  (payer-web/payer-app reference the public `/i/` and `/r/` funnels instead). Plausible QA/demo
  tool from the ADR-0022 mock phase; no strong negative signal beyond absence of a caller.

## Explicitly checked and ruled out (false leads — recorded so Batch 2 doesn't re-flag them)

- **Worker-app `voice_form` sub-feature** (`preflight_screen.dart`, `voice_form_entry_chooser.dart`,
  `profiling_entry.dart`, `voice_form_screen.dart`) — unreachable from `router.dart` with
  95–100% confidence by Dart import-graph, but this is **active, in-flight development**, not
  legacy debt: gated by a documented remote-config kill switch
  (`kKeyVoiceFormHidden`/`kDefaultVoiceFormHidden = true`, comment: "flipped on only once
  staging validates it"), introduced 5 days ago (2026-08-08) and touched again today
  (2026-08-13, commit `1438477d`, #806/#818), with 16 active test files under
  `test/features/voice_form/`. **Do not treat as a deletion candidate** — flag to the
  worker-app owner to confirm whether the router integration is a pending follow-up.
- **Agency "parked modules"** (`payer-web/agency/dashboard/parked-modules.tsx`,
  `agency/bulk-upload/page.tsx`) — look experimental but are deliberate, documented, tested,
  nav-linked product decisions (KYC/payouts/bulk-upload are legal/money-gated by design).
- **`apps/web/src/lib/unlock-view.ts` vs `apps/payer-web/src/lib/unlock-view.ts`** — same
  pattern name, but two intentionally-parallel implementations of the same no-oracle invariant
  for two different backend endpoint families with different response shapes. The payer-web
  file's own docstring says "mirrors apps/web's unlock-view.ts" — self-documented, not
  accidental duplication.
- **Mock-mode Flutter paths** (`kUseMocks`, `MockApiClient`/`MockPayerApiClient`) — REAL is
  default (confirms PR #201 held), but the mock classes remain a live, actively-tested dev/test
  seam (15 worker-app + 21 payer-app test files inject them directly), not dead code.
- **Email pipeline "duplication"** — the task brief specifically calls out duplicated
  email/notification code paths as a risk area; checked directly and found **already fixed**:
  `email-notification.service.ts`'s own docstring documents a prior duplication (ZeptoMail
  implemented twice) that was consolidated as an ADR-0038 prerequisite. `zeptomail-email-login-
  channel.ts` and `member-invite.mailer.ts` both now delegate to the single service. No action
  needed — recorded as a negative result.
- **Unreferenced-file sweep** across `apps/web`, `apps/payer-web`, `apps/admin-web` surfaced
  only one candidate (`apps/admin-web/src/lib/auth/index.ts`), which was a false positive (a
  barrel consumed via directory-style imports). No TODO/FIXME/`@deprecated`/commented-out code
  found anywhere in any of the three apps' `src/`.

## Summary table

| ID | Item | Confidence | Type |
|---|---|---|---|
| DC-1 | 6 orphaned Flutter widget files | 95–100% | Delete candidate |
| DC-2 | payer-web `/profile` page duplicate | 95–100% (duplication, not deadness) | Consolidate — see DU-1 |
| DC-3 | ai-service `app/corpus/` package | 80–94% | Verify with owner (ADR-0018 status) |
| DC-4 | `embed_aliases`/`AliasStore` | 80–94% | Verify with PR #214 author |
| DC-5 | Legacy profiling contracts (Zod+Pydantic) | 80–94% | Architect decision required |
| DC-6 | `WavyText` component | 80–94% | Consolidate into `BadaBhaiLogo` or delete |
| DC-7 | `packages/reach-learn` | 50–79% (deliberate) | Keep; confirm calibration timeline |
| DC-8 | `payerFormDrafts` table | 50–79% (self-flagged) | Keep; ADR decision on window |
| DC-9 | `score-wedge.ts` | 50–79% (discoverability only) | Keep; add package script alias |
| DC-10 | `TRANSPORT_REASON_CODES` | 50–79% | Keep; negligible |
| DC-11 | 6 unused DS primitives | 50–79% (deliberate) | Keep; design-engineer call |
| DC-12 | Agent-scoped invite click ping | 50–79% | Verify with FE re: QA/demo use |
