# Production Release Runbook

> **There is no staging for this release** (owner ruling, 2026-07-31). Everything ships to
> production behind expand-only migrations and reversible flags, verified by a canary account.
> That is workable only if the discipline below is followed exactly: **one flip at a time, a
> named abort lever for each, and a canary smoke between every one.**
>
> Companion: [matching-v1-migration-runbook.md](matching-v1-migration-runbook.md) (the SQL train
> and its verify queries) · [rollback-guide.md](../rollback-guide.md) ·
> [observability-runbook.md](../observability-runbook.md).

---

## P0 — Owner actions. Code cannot do these, and some of them are legal gates.

Nothing in P4 may proceed past the item that depends on it.

| # | Action | Gates | Status |
| - | ------ | ----- | ------ |
| 1 | **Sarvam DPA + written terms signed** | The `stt_transcription` flip. Audio cannot be pseudonymized before the provider hears it — this is the compliance condition for real worker voice leaving the platform. **Hard legal gate.** | ☐ |
| 2 | **Google (Gemini) + Anthropic DPAs in place** | `AI_ENABLE_REAL_CALLS`. Pseudonymized text is still worker data. **Hard legal gate.** | ☐ |
| 3 | **Grievance Officer NAMED and published** | Public launch. Legally required under DPDP. **Hard legal gate.** | ☐ |
| 4 | **R32 decision recorded** — accept-at-launch in the risks register, or harden first | `AI_ENABLE_REAL_CALLS`. R32 (an un-cued third-party name reaching LLM input) is NARROWED, not closed; the gazetteer approach was measured dead and reverted. Someone must own the residual in writing. | ☐ |
| 5 | **Razorpay**: account, KYC, live key id + key secret, webhook secret, webhook URL registered | `PAYMENTS_ENABLE_REAL`. | ☐ |
| 6 | **`app.badabhai.in` DNS + TLS serving payer-web**, and the **Play App Signing SHA-256** exported from Play Console into `assetlinks.json` | App Links verification, therefore the whole attribution chain. Until this is real, shared links open a browser and fresh installs lose the referral code. | ☐ |
| 7 | **Play Console**: store listing, App Links domain verification, staged-rollout track ready | P5 client release. | ☐ |
| 8 | **Confirm `AGENCY_PAYOUTS_ENABLED` stays OFF** | ADR-0022 gate. Explicitly out of scope for this release; the agency ledger stays mock. | ☐ |
| 9 | **Production database backup/snapshot taken and its restore verified** | P1. A rehearsed restore, not an assumed one. | ☐ |
| 10 | **`INTERNAL_SERVICE_TOKEN` set — to the SAME value — on both the API and the ops console (`apps/web`)** | **The entire ops API.** See the note below; this one is new and it is load-bearing. | ☐ |
| 11 | **Ops API not publicly routable** (private network / VPN / IP allowlist in front of `apps/api`'s ops routes) | Defence in depth for the same surface. Owner ruling 2026-07-31: guard in code **and** infra, so a single misconfiguration on either side is not fatal. | ☐ |
| 12 | **Physically print and scan the agency invite QR sheet** (B5, batch invite minting) | The overflow + blank-print-sheet fixes are reasoned from box-model/`:has()` CSS logic, not observed — nobody running this build can open a browser or print a page. Confirm on a real phone camera against a real printed sheet before treating the QR flow as launch-ready. | ☐ |

### Status as of 2026-08-01

**Merged to `main` (`f28279f`):** the whole Matching V1 + B5 release — ranked feed on
`job_postings`, agency engagement view, batch invite minting (mutation-verified, 14 security
conditions closed, ADR-0022 Amendment 3), the ops-API closure (R28, `InternalServiceGuard` on
all 43 routes), and the prod-canary rewritten to probe all 43 routes with a drift test pinning
coverage. Branch protection is now live on `main` (`ci-required` + 1 review required).
`feat/matching-v1` deleted post-merge (true merge commit, nothing lost).

**Item 4 (R32) is now DONE** — #528 merged (`5028692`) with the owner ruling recorded in
`team-decisions.md` and the risk register. This is the only P0 item that has moved.

**Still open, blocking P1 onward:** items 1/2/3/5/6/7 (legal DPAs, Razorpay, DNS/Play Console —
all owner-only, untouched), item 9 (backup/restore rehearsal — no evidence found it has run,
and P1 cannot start without it), item 10 (`INTERNAL_SERVICE_TOKEN` — status still unconfirmed),
item 11 (ops API network restriction — infra, not done), item 12 (QR print/scan — added this
session, unchecked).

PR #525 (an earlier attempt at recording the R28 fix + owner rulings) was **closed**, superseded
by #528 (merged) — #525's code changes were redundant with what `main` already shipped, but its
docs content (the 8 owner rulings, and the fact that `risks-register.md`/`BLOCKERS.md`/
`.claude/project-memory.md` still read R28 as OPEN despite the fix being live) was real and
landed in #528.

**Staging contradiction — resolved, fix merged in #527** (`b467464`): `RELEASE_READINESS.md`'s
"NOT READY (not deployed)" was stale. Staging was deployed manually (owner-confirmed
2026-08-01), just never through `staging-cd.yml`, which has zero recorded runs — that pipeline
gap (automation exists, never exercised) is tracked as TD123, separately from the contradiction
itself.

**P1 (migration train) has not started.** The Matching V1 train (`0052`–`0057`) is authored,
not applied. Rehearsal against a restored snapshot is mandatory per this file's own P1 section,
and item 9 (backup/restore verified) is unconfirmed — so P1 cannot honestly start until item 9
is closed, even though nothing code-side blocks it.

### P0-10 — why this is suddenly load-bearing

Until 2026-07-31 the ops-internal API had **no guard at all**, and the ops console sent **no
credential**. Those two facts cancelled out, so nothing failed and nothing looked wrong — while on
a public internet an anonymous caller could `POST /job-postings` → `PATCH /:id {status:"open"}` →
`POST /:id/verify` and put a **verified** job into real workers' feeds, read the whole audit spine
via `GET /events`, and enumerate workers and ranked candidates.

Fifteen routes are now behind `InternalServiceGuard`, and the console authenticates on every call.
That guard **fails closed**: with the secret unset it denies every request. So:

- **If the token is missing on the API**, the ops console is completely dead (every page errors).
- **If the two values differ**, same outcome.

That is the intended failure mode — a missing secret breaks the console loudly instead of silently
re-opening the API — but it means the console is now a *hard* dependency on this env var, and a
deploy that forgets it looks like a total ops outage. Set it before P2, not during it.

`POST /consent/accept` is now worker-authed too, and takes the worker from the session rather than
the request body. Old worker-app builds still send `worker_id`; the field is **stripped**, not
rejected, so old and new clients both work and P5 can roll out at its own pace.

---

## P1 — Migrations. Applied manually by Divyanshu.

Locked convention: migrations are always manual; coding agents never run them. The full ordered
train, with a verify query and a rollback note per step, is in
[matching-v1-migration-runbook.md](matching-v1-migration-runbook.md).

Every migration in this release is **expand-only** — new tables, new nullable columns, new
indexes. Nothing is dropped or renamed, so the code can be rolled back independently of the
schema at any point. The contract phase (dropping the legacy path) is deliberately deferred.

**Rehearsal first, not optional:** restore the P0-9 snapshot into a local Postgres, run the whole
train plus the backfills against it, and record the real row counts and durations in the
migration runbook. Worker PII is application-layer ciphertext, so a local restore does not expose
plaintext — but treat the restore as production data regardless and destroy it afterwards.

**STOP if:** any verify query returns an unexpected count, any step takes materially longer than
the rehearsal predicted, or the backfill's ops worklist is non-empty in a way nobody has triaged.

---

## P2 — Deploy the code, dormant.

API, ai-service, payer-web deploy with **every new flag off**. `MATCH_V1_ENABLED=false`,
`AI_ENABLE_REAL_CALLS=false`, `PAYMENTS_ENABLE_REAL=false`, `SKILL_CANONICALIZE_ENABLED=false`.

Run the canary smoke against the **mock** paths. The point of this phase is to prove the new code
changed nothing while it is switched off. If anything moves here, the problem is not a flag.

---

## P3 — Backfills and seeders.

Data scripts D1–D6, then `verify-match-v1`. All are idempotent and re-runnable; each prints
counts. The one that matters most for cutover continuity is the seeded-jobs conversion — without
it, the worker feed is empty the moment `MATCH_V1_ENABLED` goes true.

The skill-alias embedding seeder refuses to run under `NODE_ENV=production` by design. The
sanctioned override is two deliberate acts (an env var **and** a CLI flag), it logs an audit line,
and it requires `skill_embedding` to be allowlisted first — so it belongs *inside* P4, after that
step, not here.

---

## P4 — Flag flips. One at a time. Canary smoke between every one.

Order matters: each flip's precondition is the previous one.

| # | Flip | Precondition | Abort lever |
| - | ---- | ------------ | ----------- |
| 1 | `AI_INTERNAL_TOKEN` set on **both** ai-service and api | — | Unset (both sides); service auth fails closed |
| 2 | `AI_SPEND_REDIS_URL` | Redis reachable | Unset → falls back to per-process caps (weaker, still capped) |
| 3 | Spend caps set **explicitly** (`AI_MAX_USER_DAILY_COST_INR=6`, `AI_MAX_DAILY_COST_INR=200`, `AI_MAX_TOTAL_COST_INR=1000`, `AI_MAX_CALL_COST_INR=10`) | #2 | Lower them; they are read per call |
| 4 | `AI_ENABLE_REAL_CALLS=true` + `AI_REAL_CALL_TASKS=profile_extraction` | P0-2, P0-4, #1–#3 | `AI_REAL_CALLS_KILL_SWITCH=true` (checked first, blocks everything) |
| 5 | `+resume_generation` in the allowlist | #4 canary clean | Remove from allowlist |
| 6 | `+skill_embedding` in the allowlist | #5 | Remove from allowlist |
| 7 | Run the embed-skill-aliases seeder in production (two-act override) | #6 | Re-runnable; `--reset-embeddings` to redo |
| 8 | `SKILL_CANONICALIZE_ENABLED=true` | #7, embedded-row count verified | Flag off → phrases stay free text, exactly as today |
| 9 | `+stt_transcription` in the allowlist | **P0-1 (Sarvam DPA)**, private voice bucket confirmed, **`GEMINI_FLASH_API_KEY` set** (see note) | Remove from allowlist, or the kill switch |
| 10 | `CHAT_ONE_SHOT_OPENER_ENABLED=true` | — | Flag off → client fallback copy |
| 11 | `PAYMENTS_ENABLE_REAL=true` + all three secrets | P0-5 | Flag off → mock purchases resume; captured real payments still honored via webhook |
| 12 | `MATCH_V1_ENABLED=true` | P1 + P3 complete and verified | **Flag off** → legacy feed and payer list return; the legacy code is still present until the retirement change |

**On STT (#9), an accepted coupling worth knowing before you hit it:** closing the STT gating
hole meant routing it through the single `real_calls_blocked_reason()` helper — which is what
finally puts real audio behind the kill switch and the allowlist. That helper also requires
`GEMINI_FLASH_API_KEY`, so **real STT now needs the LLM master credential even if you are
enabling nothing but transcription.** The direction is fail-closed and there is now exactly one
definition of "real calls are on", which is the point. But an environment that intended to run
voice without any LLM will refuse to transcribe until that key is present, and the error will
name the credential rather than the coupling.

**On canonicalization (#8), one honest number:** measured precision is 1.000 and anchor-domain
recall is 0.350. A miss leaves the raw phrase exactly as the flag-off path does, so enabling it is
strictly additive coverage with no correctness downside — and every miss feeds
`unresolved_phrase`, which is the growth loop. Accepted at launch; the multi-domain fix that lifts
recall is tracked separately. Do not quote 0.800 (the oracle-domain figure) anywhere.

---

## P5 — Clients last.

Worker-app Play release via staged rollout: 10% → observe → 50% → 100%. Every server change in
this release is additive, so **old clients keep working throughout** — that is what makes a staged
rollout safe rather than a coin flip. payer-web deploys continuously.

Ship in this build: the persona copy fixes, the voice transcript-confirmation turn, App Links +
Play Install Referrer, and Firebase Remote Config/Analytics. App Links verification only takes
effect at install time, so **P0-6 must be live before the release is promoted**, not after.

---

## Canary smoke

Run after every P2/P4 step.

**First, the automated posture check** — `PROD_API_BASE_URL=https://… node scripts/prod-canary.mjs`.
Read-only and write-free; safe to run as often as you like. It proves `/health` is up, that **all
43 routes behind `InternalServiceGuard` reject an anonymous caller**, and that the DPDP consent
gate holds. Set `PROD_CANARY_OPS_TOKEN` as well and it also proves the ops token is *accepted* —
which is the P0-10 failure mode, since the guard fails closed and a missing or mismatched token
presents as a total ops-console outage.

> The route list was measured against Nest's own metadata, not assembled by hand. An earlier
> version probed 6 routes while describing itself as the closure claim, so 37 guarded routes —
> including `PUT /pricing/catalog`, `POST /unlocks/:id/reveal` and the whole job-posting
> verify chain — were never checked. If you add a route behind `InternalServiceGuard`, add it to
> `OPS_ROUTES` in that script; an unprobed route is exactly how the original hole survived.

**Then the human steps** the script deliberately does not fake. They need a real OTP to a
team-held handset and a real card, and `TEST_LOGIN_ENABLED` cannot be armed in production, so
there is no honest way to automate them. Uses a synthetic canary worker (a team-held real phone —
Fast2SMS OTP is already live) and a canary payer account, both flagged in the database so
analytics can exclude them.

1. **Worker:** OTP → consent → chat opener from the server → answers → extraction completes →
   resume ready.
2. **Voice** (after #9): record → transcript shown → `Yeh theek hai?` confirm → merged into chat.
3. **Loop** (after #12): payer signs up → 50 free credits present → posts a job (form *and* AI
   chat) → related skills pre-ticked with a live reach count → publish → **the canary worker sees
   it in `/feed`** → applies → payer sees the ranked candidate list with the related badge →
   unlocks → credit decrements → drain to zero → `payer.credits_exhausted` observed in the event
   spine.
4. **Payment** (after #11): buy the smallest pack with a real card → ledger row, `payment.captured`
   event, balance correct.

Step 3 is the one that matters most: it is the first time in the product's life that a
payer-posted job reaches a worker. If it fails, flip #12 back and stop — nothing downstream is
worth debugging until the loop closes.

---

## What to watch in the first 48 hours

- **Spend** — `/ai/spend` against the ₹6/user/day and ₹200/day ceilings. The per-user cap is the
  one that catches an abusive or looping session.
- **Zero-reach postings** — a payer publishing into an empty list is the failure the pre-pay
  warning exists to prevent. If it fires often, the vocabulary bridges are wrong, not the payer.
- **Feed emptiness** — workers with no `job_reach` rows. Expected for off-wedge trades; alarming
  for CNC workers.
- **Repeat-unlock rate** — the hero metric, and the early-warning signal for over-contact. The
  caps (5/day, 10 payers/week, 3 attempts) hold numerically but concentrate on top-ranked
  profiles.
- **Resolved-source share on referrals** — target ≥95%. Below that, attribution is still leaking
  and agent payouts cannot be defended.

## Rollback posture

Every phase is reversible by a different mechanism, and they compose:

- **P4** — flip the flag back. Seconds. This covers every provider and the matching cutover.
- **P2/P5** — redeploy the previous image / halt the staged rollout. The schema stays; expand-only
  means old code runs against new columns without noticing them.
- **P1** — the only phase that is not casually reversible. That is why the rehearsal and the
  snapshot are mandatory, and why the contract phase is deferred: as long as nothing is dropped,
  "rollback" means rolling back *code*, which is always safe.

If two things go wrong at once, flip **#12 first** — it is the widest blast radius and the
cheapest revert.
