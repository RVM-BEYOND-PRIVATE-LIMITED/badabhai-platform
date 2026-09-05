PHASE-ID: E3
STATUS: this phase is a RE-POINT of shipped surfaces, not a build. **The dominant failure
mode is therefore a SECOND COPY, not an absent one** — a new credit table, a new purchase
route, a new résumé disclosure. Items 1-4 look for that first, and every one of them is
GREEN at the phase base. THE CREDIT QUESTION on `E3_BUILD.md` is UNSIGNED: a build that
unmasked a résumé or returned a full profile has settled it, and that is a FAIL (item 5).

INVARIANT: the disclosure chokepoint stays single — nothing outside `apps/api/src/unlocks/`
imports `UnlocksRepository`, and every credit movement this phase's surface can cause still
passes the consent and cap gates before payment.

R-E4 APPLIES TO THIS WHOLE FILE, AND IT IS NOT A FOOTNOTE. The workers on the live database
are testers (owner ruling, 2026-09-05) and `PAYMENTS_ENABLE_REAL` is off, so every purchase
reachable here is a MOCK. **Every item below runs against SEEDED LOCAL DATA against a schema
Prakash has applied.** A balance, a debit or a ledger row observed here is a fact about the
seed, not about revenue. An item needing rows nobody has seeded is recorded NOT EXECUTABLE.

EXPECTED ARTIFACTS: a candidates surface that READS the balance and CALLS the existing
unlock, reveal and résumé routes. **No new route, no new table, no new migration, and no new
unlock component.**

HOW TO READ THE LABELS.
  [GUARD]       — must be GREEN at the phase base. Each was run against `f72a7a79` while this
                  brief was written and its base result is recorded. A GUARD that is red at
                  base cannot distinguish this build from the world; report it as a broken
                  check, never as a FAIL.
  [DELIVERABLE] — must be RED at the phase base.

CONVENTION: grep exits 1 on zero matches. Do not run under `set -e`. Paste raw output AND
the exit code for every item.

1. [GUARD · base: GREEN, exit 1] THE INVARIANT. The chokepoint is still single.
   grep -rn "UnlocksRepository" apps/api/src --include=*.ts | grep -v "^apps/api/src/unlocks/" | grep -E "^[^:]*:[0-9]+:import"
   Base: exit 1. Every real import of `UnlocksRepository` is inside `apps/api/src/unlocks/`
   (payment-gateway.ts, unlocks.module.ts, unlocks.service.ts).
   DO NOT DROP THE SECOND `grep -E "import"`. Three files OUTSIDE that directory MENTION
   `UnlocksRepository` in comments — admin-dashboard.repository.ts:444,
   resume-disclosure.repository.ts:65, referral-link.repository.ts:64 — so the bare
   name-grep is red at base and would point a reader at three innocent docblocks.
   THEN MUTATE AND WATCH IT GO RED. Add an import of `UnlocksRepository` to any module
   outside `apps/api/src/unlocks/` and confirm this item fires. If it does not, the check is
   broken rather than the code being clean.
   PRESCRIBED FAIL SHAPE: say that the SINGLE-WRITER property is gone and name the module
   that broke it, then say what it enables — the fail-closed ordering (credit precondition,
   consent, deletion freeze, caps, then payment) can now be bypassed. A fail sentence that
   says only "extra import" reads as a style nit and will be waved through.

2. [GUARD · base: GREEN] No second billing object, and no migration.
   git diff --stat $(git merge-base origin/main HEAD)..HEAD -- packages/db/migrations packages/db/src/schema
   Expected EMPTY. This phase needs no schema change: `payer_credits`, `credit_ledger`,
   `unlocks` and `resume_disclosures` all exist. A migration here means something was
   rebuilt; read it before accepting it.

3. [GUARD · base: GREEN] No second purchase route, and no second catalog.
   grep -rn '@Post("credits' apps/api/src --include=*.ts | grep -v "\.test\."
   Base: exactly THREE, all in payer-unlocks.controller.ts — `credits` (:143, the mock
   purchase), `credits/order` (:205) and `credits/verify` (:239, the browser-return
   fallback). Expect exactly three. A FOURTH is the FAIL.
   COUNT, DO NOT EYEBALL: `credits/verify` is easy to forget when reading the mock and the
   order route as "the two payment routes", and a check written for two is red at base.
   grep -n "realPaymentsLive" apps/api/src/payer-portal/payer-unlocks.controller.ts
   Base: three hits (:155, :212, :246). Expect three. These are the mutual exclusion that
   stops a free-credit route sitting beside a live paywall; losing one is a paywall bypass,
   not a refactor.

4. [GUARD · base: GREEN, 5 exports] The unlock components were REUSED, not copied.
   grep -c "^export" apps/payer-web/src/components/unlock/index.ts
   Base: 5. Expect 5 — the barrel is the ONE implementation and its own docblock says so.
   grep -rn "from \"../../../components/unlock\"\|components/unlock" apps/payer-web/src --include=*.tsx | grep -v "components/unlock/"
   Expect the new candidates surface among the importers.
   FAIL if the new surface declares its own contact card, spend dialog or résumé card. A
   second copy drifts, and the thing it drifts on is the no-oracle copy: two "unavailable"
   strings that differ by a word turn the UI into the oracle the API refuses to be.

5. [GUARD · base: GREEN] The unsigned credit question was NOT settled by building.
   grep -rn "maskInitials" apps/api/src/disclosures/resume-disclosure.service.ts
   Base: hits at :19 (the import) and :235 (the render). Expect both. FAIL if the masking was
   removed — that is a §2 raw-PII egress decision and an owner act.
   grep -rniE "unmask|full_profile|fullProfile" apps/api/src/payer-portal apps/api/src/disclosures apps/payer-web/src --include=*.ts --include=*.tsx | grep -v "\.test\."
   Base: exit 1. Any new full-profile route or view is the FAIL.
   KEEP THE PATHSPEC. Run unscoped over `apps/api/src` this is RED at base on three innocent
   admin docblocks about unmasked chat transcripts (admin-worker-journey.dto.ts:17,
   admin-worker-journey.repository.ts:533, admin.module.ts:251) — a different surface with a
   different ruling. Positive control that the pattern still works:
   `grep -rniE "unmask" apps/api/src/admin --include=*.ts` must return hits at exit 0. If it
   does not, your grep is broken, not the tree clean.
   PRESCRIBED FAIL SHAPE: name it as an unsigned ADR-0010/ADR-0013 amendment and a §2
   privacy call, not as a scope overrun. The two read very differently to whoever triages it,
   and only one of them gets escalated.

6. [GUARD · base: GREEN, exit 1] No payment surface reached a Flutter app.
   git diff --stat $(git merge-base origin/main HEAD)..HEAD -- apps/payer-app apps/worker-app
   Expected EMPTY. Additionally:
   grep -n "kShowBuyCreditsOnWeb" apps/payer-app/lib/features/credits/presentation/credits_screen.dart
   Base: three hits (:55 declaring it `false`, :204 the comment, :208 the `visible:` binding).
   Expect `= false` at :55 to be UNCHANGED. Flipping it re-enables a surface switched off for
   a documented Play-Store anti-steering reason, and `docs/agent/BUILD_RULES.md:29` bars a
   payment surface in a Flutter app independently.

7. [GUARD · base: GREEN] The deny reason still cannot reach a payer.
   grep -n "deny_reason\|denyReason" apps/api/src/unlocks/unlock-response.ts
   Base: hits at :8-11 — the internal enum NEVER crosses the HTTP boundary, and *"There is
   intentionally NO `reason` field on this type, so a leak is a compile error, not a review
   miss."* Expect the guarantee intact and no `reason` field on the response type.
   THIS ITEM CANNOT BE PROVEN BY GREP ALONE and you must say so: the guarantee is a
   compile-time property of the response type. Run the type check
   (`pnpm --filter @badabhai/api exec tsc --noEmit`) and record whether it passed; a grep
   that finds nothing proves only that nothing is spelled that way.

8. [DELIVERABLE] The balance and the packs are beside the results, and DECOUPLED.
   Read the new page. FAIL if a balance-read failure can blank the candidate list — the two
   concerns must have separate try/catch blocks and separate degraded states, exactly as the
   applicants page does (apps/payer-web/src/app/(portal)/postings/[id]/applicants/page.tsx:22-24
   states the rule in its own words).
   MUTATE AND WATCH IT: make the balance read throw and confirm the list still renders. A
   page that goes blank has coupled them, and the failure will only ever be seen in
   production, on the day the credits service is slow.

9. [DELIVERABLE] The surface calls the existing routes and adds none.
   Read the new server actions. Every unlock, reveal and résumé call must land on
   `POST /payer/unlocks` (apps/api/src/payer-portal/payer-unlocks.controller.ts:66),
   `POST /payer/unlocks/:unlockId/reveal` (`:87`) and `POST /payer/resume-disclosures`
   (apps/api/src/payer-portal/payer-disclosure.controller.ts:52).
   git diff --stat $(git merge-base origin/main HEAD)..HEAD -- apps/api/src/unlocks apps/api/src/disclosures
   Expected EMPTY. This phase changes no backend disclosure code at all.

10. NOT EXECUTABLE WITHOUT SEEDED ROWS AND AN APPLIED SCHEMA. The end-to-end proof — a
    seeded payer with a balance unlocks a seeded consenting worker from the SEARCH page, the
    balance falls by one, one `credit_ledger` row appears with reason `unlock_debit`, and the
    masked résumé renders — needs both. If either is missing, write "NOT EXECUTABLE: <which>"
    and do NOT record a PASS. Items 1 and 8 are the unit-level evidence; this is the
    integration-level evidence, and neither substitutes for the other.

RECORD IN THE VERDICT, do not check: the credit question (what a credit buys, and whether
the résumé is free and masked) is unsigned and is an owner act. State that the build followed
the SHIPPED meaning. Do not treat the divergence from the described flow as a defect — it is
the correct outcome of an unsigned ruling.
