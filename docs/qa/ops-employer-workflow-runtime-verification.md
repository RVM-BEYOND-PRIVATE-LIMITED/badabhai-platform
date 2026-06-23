# Ops Employer Workflow — Runtime Verification (runbook + PASS/FAIL report)

> **Why this exists:** the ops-console employer surface (job → ranked feed → unlock →
> reveal → top-up) is **built and CI-green but never exercised by a human**. CI-green ≠ works,
> and this is the **entire employer surface for alpha**. This doc makes the run **turnkey**,
> records what is **statically verifiable from code** (done here), and leaves the **UI click-loop
> for a human** (cannot be done from CI / this env).
>
> **Read first:** [CLAUDE.md](../../CLAUDE.md) · [ADR-0010](../decisions/0010-contact-unlock-and-reveal.md)
> (unlock→reveal spine) · [ADR-0013](../decisions/0013-monetization-and-config-driven-pricing-engine.md)
> (pricing/credits, mock payments) · the identity-masking decision (commit **eafcccc**,
> [resume-disclosure-threat-model-addendum.md](../security/resume-disclosure-threat-model-addendum.md)).
> **Drive:** qa-engineer (verdict) · frontend-engineer (build/run + quick fixes) · security-engineer (reveal-path gate).
> **Scope:** verification + DOCS. No code changed here. Real money is OUT (mock ledger).
>
> **PREP refresh (2026-06-20):** this pass re-pins every per-step event against the CURRENT service
> code, **un-stales the masked-resume row** (the masked employer resume **shipped in PR #103** — see
> TL;DR + Step 4), corrects the migration head + verify-command details, and marks every mutating step
> ⛔ **NOT-RUN** until BUG-2 deploys. **No loop was driven** (BUG-2 is OPEN; reveal/disclosure decrypt
> real PII — CLAUDE.md §7 human-gated). Static / read-only only.
>
> **Not this loop:** the payer **portals** ([#106](../../apps/payer-web) company DEMAND, #107 agency)
> are a **SEPARATE mock/staging surface** (`apps/payer-web`, an in-memory mock store — it does NOT
> write the real backend `events` spine). Do NOT conflate them with this ops console
> (`apps/web` + `apps/api`) loop, which is what this runbook verifies.
>
> **Release-blocker rules (not "bugs"):** a reveal/disclosure that shows a **raw phone** or a **full
> name**, or a top-up that can hit a **real gateway**, is a **release blocker**. All three are
> **code-verified ABSENT** below.

---

## TL;DR verdict (2026-06-20)

| Area | Verdict | Basis |
| ---- | ------- | ----- |
| **Reveal never leaks a raw phone** | ✅ **PASS (code-verified)** | decrypt is transient + single-site; client sees handle only |
| **No real-payment path reachable** | ✅ **PASS (code-verified)** | mock default + boot fail-closed + `real_call:false` |
| **No-oracle (unlock/reveal/disclosure states honest)** | ✅ **PASS (code-verified)** | single neutral body + pure mapper, no cause branch (shared by unlock + disclosure) |
| **Service token stays server-side** | ✅ **PASS (code-verified)** | `process.env` only, in `"use server"` actions |
| **Applicant feed is faceless** | ✅ **PASS (code-verified)** | mappers read opaque `workerId` + signals only |
| **The end-to-end loop actually works** | ⛔ **NOT-RUN** | runtime probe (2026-06-17): employer schema **un-deployed** in the only reachable DB; 0 unlock/contact/payment events ever; needs a seeded staging target + human |
| **API boots + feed resolves in staging** | ✅ **FIXED (code)** · ⏳ run pending | **BUG-1 RESOLVED** via divyuuu's `JobsTableJobSource` (ADR-0015, supersedes the interim #67 `JobPostingsJobSource`); needs a live staging run to confirm |
| **Employer/unlock schema deployed** | ⛔ **NO — BUG-2 (OPEN)** | reachable DB is behind head; `jobs`/`applications`/`unlocks`/`payer_credits`/`credit_ledger`/`unlock_routing`/`job_postings` absent until migrated |
| **Employer-facing resume is masked** | ✅ **BUILT (code-verified)** · ⏳ run-pending | **SHIPPED in PR #103** — `apps/api/src/disclosures/` `ResumeDisclosureService` to `resume.disclosed` event; `maskInitials` ([mask-initials.ts](../../apps/api/src/resume/mask-initials.ts)) renders masked initials ("R***** K."), **NO phone, NO full name**. Reachable via the `InternalServiceGuard` API only (no ops-web UI; the payer-web surface is a MOCK) — see Step 4 |

**Bottom line:** the security-critical guarantees (no raw-phone leak, **no full-name leak on the
masked resume**, no real money, no-oracle, faceless feed, server-only secret) **hold in code**. The
workflow is **still NOT runtime-verified**: a 2026-06-17 runtime probe (below) showed the
employer/unlock schema is **not deployed to any reachable environment** (**BUG-2, still OPEN**). BUG-1
(stub feed source) is fixed in code; the live blocker is **BUG-2 — migrations not applied** (the
reach/unlock tables don't exist in the only DB this repo's `.env` reaches). Deploy a staging target,
migrate to head, seed, then run Phase 2 with a human; driving the mutating loop against a
**shared/real DB** (it decrypts a real worker's phone at reveal AND a real name at masked disclosure)
is a **CLAUDE.md §7 human-gated action** and must target a disposable non-prod DB.

---

## Runtime probe (2026-06-17) — what was actually checked at runtime

> The strict bar for "finished" is **evidence, not code-reading**: the loop driven + the matching
> `events` rows present. This probe is the maximum runtime check executable from this environment
> **read-only** — it does not (and must not) drive writes against the reachable DB (see §boundary).
> **Re-confirmed still-accurate on the 2026-06-20 PREP pass: BUG-2 remains OPEN** (no staging target
> stood up since), so the probe figures below stand as the last evidence on record.

**Environment reachable from this repo:** `DATABASE_URL` to a hosted Supabase Postgres
(`aws-1-ap-south-1.pooler.supabase.com`), `NODE_ENV=development`, `REDIS_URL=localhost:6379`
(not running), **no Docker installed** (can't stand up a fresh full stack), no browser (no
screenshots possible).

| Probe (read-only SQL / config) | Result | What it proves |
| ------------------------------ | ------ | -------------- |
| `events` total / distinct names | **140 rows, 13 names** — all Phase-1 (chat/otp/profile/resume/consent/ai.cost) | the DB is live and exercised, but only for **worker profiling** |
| `events` where name matches the unlock/contact/payment prefix | **0 rows** | the employer monetization loop has **never run** here — not one unlock/reveal/payment event exists |
| Tables present (`information_schema`) | 14 Phase-1 tables; **`jobs`, `applications`, `job_postings`, `unlocks`, `payer_credits`, `credit_ledger`, `unlock_routing` ALL ABSENT** | the loop **cannot** run here — its tables don't exist |
| `drizzle.__drizzle_migrations` | **10 applied** at probe time; repo head is now **24** (0000–0023) | the reachable DB is far behind head — incl. ADR-0009 (jobs/applications), ADR-0010/0012/0015 (unlock/job_postings/reach), ADR-0013 pricing + PR #103 `resume_disclosures` (migration 0016) → **BUG-2** |
| `NODE_ENV` | `development` | a local API boot would bind the **`StubJobSource`**, not the real `JobsTableJobSource` (staging/prod only) — so even a local run wouldn't exercise the real feed |
| `PAYMENTS_ENABLE_REAL` (.env) | absent → default **false** | the payment kill-switch is at its safe default in this env (consistent with the code-verified no-real-gateway finding) |

**Conclusion of the probe:** "CI-green ≠ works" is confirmed in the strongest form — the employer
surface is not merely un-clicked, it is **un-deployed**: there is no environment reachable from
this repo where a single mutating step could land its event. The per-step report below is therefore
**NOT-RUN (environment cannot host the loop)**, not "pending a click."

### §Boundary — why the loop was not driven from here (and must not be, autonomously)
Driving `POST /unlocks` to `/reveal` to top-up requires (a) the schema deployed and (b) writing
`unlocks`/`credit_ledger` rows and, at **reveal, decrypting a real worker's `phoneE164`** — the
single highest-risk PII path in the product (ADR-0010 §Context). The masked-resume disclosure
(`POST /resume-disclosures`, PR #103) likewise **decrypts the real `full_name`** once to derive the
mask. Doing either against the **shared, real** Supabase DB is a **CLAUDE.md §7 escalation** (touches
production data + real PII) and was **not performed**. The correct target is a **disposable non-prod
DB** with migrations applied + a **synthetic** consented worker, where a reveal decrypts a fixture
phone — never a real worker's.

---

## Phase 1 — make it turnkey (PREP — done here; do NOT click / drive writes yet)

### 1.0 Prerequisite gates (must be true or the run is invalid)

1. ✅ **BUG-1 FIXED (2026-06-17).** `apps/api/src/reach/reach.module.ts` binds `JOB_SOURCE` to a
   real source replacing the dev-only `StubJobSource`. **Superseded note:** the interim
   `JobPostingsJobSource` (reading `job_postings`) from #67 was **replaced by divyuuu's
   `JobsTableJobSource`** ([ADR-0015](../decisions/0015-reach-feed-on-real-jobs.md), PR #69),
   which serves the live ADR-0009 `jobs` entity via a faceless `JobSignalRow` projection +
   pure `jobSignalRowToJobSpec` mapper (the no-PII boundary, asserted by a projection test).
   The API now boots in staging and the feed resolves a real `jobs` row. **Still requires a live
   staging run to confirm at runtime.**
2. ⛔ **BUG-2 cleared** — staging DB migrated to head (0023) + seeded (see the BUG-2 row + the
   on-deploy sequence in §1.1a / Phase 3). **OPEN.**
3. **Staging must be deployed** with a concrete HTTPS URL (same blocker as B1 — see
   [b1-device-capstone-runbook.md](b1-device-capstone-runbook.md) prereq #1). Until then the run
   is invalid (local is fine for a dev smoke, NOT for the verification verdict).
4. **INTERNAL_SERVICE_TOKEN** set identically in `apps/api` and `apps/web` envs (the ops writes
   are behind `InternalServiceGuard`; the web attaches it server-side only — never in the browser).
   This is the **ops auth** for the whole loop (there is no per-payer auth — OBS-2 / TD33).

### 1.1 Run API + web against staging, with seed data

```bash
# From repo root.
pnpm install
pnpm build                       # build @badabhai/* first (Turbo order)

# DB — clear BUG-2: migrate to HEAD (0023), then seed.
pnpm db:migrate                                            # apply 0000..0023 (root script; §7 human-credentialed)
pnpm --filter @badabhai/db db:seed                         # base seed (workers/questionnaire scaffolding)
pnpm --filter @badabhai/db db:seed:jobs                    # ADR-0009 swipe jobs/applicants (idempotent, PII-free)
pnpm db:seed:demand                                        # BUG-2 synthetic DEMAND fixture (worker + profile + employer_sharing consent, open job_posting, credited payer)
# (db:seed:questionnaire is available if you need profile questions too)

# API — point at the staging DB/Redis via apps/api env; NODE_ENV=staging is REQUIRED
# (so JobsTableJobSource binds, not the dev StubJobSource):
NODE_ENV=staging pnpm --filter @badabhai/api start

# Web ops console (separate shell). NEXT_PUBLIC_API_URL is the API; INTERNAL_SERVICE_TOKEN in env:
pnpm --filter @badabhai/web build then pnpm --filter @badabhai/web start    # prod-like; or dev
```

> **Script scoping note:** only `db:migrate`, `db:seed:demand`, `db:verify:demand` exist as **root**
> scripts. `db:seed` / `db:seed:jobs` / `db:seed:questionnaire` are **package-scoped** —
> run them via `pnpm --filter @badabhai/db <script>` (or from `packages/db`).
>
> **Seed reality check:** `seed-jobs.ts` seeds the **ADR-0009 swipe `jobs`/`applications`** entity —
> the `/reach/jobs/:jobId/applicants` feed ranks against this table, so `feed.shown` needs it. The
> `db:seed:demand` fixture aligns its worker canonical trade (`cnc_operator`) to the `seed-jobs.ts`
> `cnc_operator` job AND creates the `job_postings` row + an `employer_sharing`-consented worker + a
> credited payer that the **unlock** path needs — so after `db:migrate + db:seed:jobs + db:seed:demand`
> the whole loop is seeded with **no manual SQL**.

### 1.1a One-command demand seed + verify (BUG-2 reproducer + on-deploy run sequence)

`db:seed:demand` removes the manual-fixture step: it builds the whole synthetic, faceless demand-side
fixture in one **idempotent**, **prod-guarded** (`NODE_ENV !== "production"`) command and prints the ids
([seed-demand.ts](../../packages/db/src/seed-demand.ts)). `db:verify:demand` then drives the loop through
the **real HTTP API** and asserts the events spine — so "does the employer/unlock loop work?" becomes one
command instead of a manual click-path ([verify-demand.ts](../../packages/db/src/verify-demand.ts)).

```bash
# After db:migrate + db:seed:jobs, with the API running against the SAME DB and the
# SAME PII_ENCRYPTION_KEY / PII_HASH_PEPPER the seed used:
pnpm db:seed:demand        # prints worker_id / payer_id / job_posting_id (prefix NODE_ENV=staging if the box defaults to production)
API_BASE_URL=https://STAGING-API INTERNAL_SERVICE_TOKEN=TOKEN DATABASE_URL=STAGING-DB pnpm db:verify:demand
```

`db:verify:demand` runs **plan, applicants, unlock, reveal** through the real API
(`POST /job-postings/:id/plan`, `GET /reach/jobs/:jobId/applicants`, `POST /unlocks`,
`POST /unlocks/:id/reveal`) and PASSES only when the `events` table recorded **all six REQUIRED**:
`feed.shown`, `job_posting.purchased`, `payment.authorized`, `payment.captured`, `unlock.granted`,
`contact.revealed` (verified against the `REQUIRED` array in verify-demand.ts). MOCK payments only
(`PAYMENTS_ENABLE_REAL=false`); the synthetic worker phone is encrypted via the **shared crypto** so
the reveal-path decrypt matches (mismatched PII keys mean reveal fails closed, so no `contact.revealed`).
It needs `INTERNAL_SERVICE_TOKEN` (the `/unlocks*` guard) and `DATABASE_URL` (the read-only event
assert). Neither script applies migrations — `db:migrate` against staging stays the **§7
human-credentialed** step.

> **NOTE (verify scope):** `db:verify:demand` asserts the SIX above. It does **NOT** assert
> `job_posting.created` (it purchases a plan on the seed already-`open` posting; it never POSTs a new
> draft posting), nor `resume.disclosed` (the masked-resume disclosure is a separate `/resume-disclosures`
> call), nor `capacity.purchased` / `coupon.redeemed`. Those are exercised by the §1.3 human click-path /
> the disclosure call below, not by the verifier.

**On-deploy run sequence (the moment BUG-2 deploys — every step here is the human/devops path):**
1. ⛔ `pnpm db:migrate` to head (0023) against the disposable non-prod staging DB — **§7 human-credentialed**.
2. ⛔ `pnpm --filter @badabhai/db db:seed:jobs` + `pnpm db:seed:demand` (synthetic, idempotent, prod-guarded).
3. ⛔ `pnpm db:verify:demand` — drives the loop, asserts the six events; PASS = backend proven.
4. ⛔ the human **§1.3 click-path** (UI screenshots + the §1.4 event queries + the no-oracle deny rows + the masked-disclosure check).

Until BUG-2 deploys, **every step above is NOT-RUN.**

> **Deploy-side checklist:** the provision → secrets → migrate → seed → start → verify → rollback
> steps (with an env-var table + a failure-triage table) that make this on-deploy sequence turnkey
> live in [bug2-staging-demand-deploy-runbook.md](../ops/bug2-staging-demand-deploy-runbook.md).
> This doc stays the **verdict** side (§1.3 click-path / §1.4 SQL / PASS-FAIL); that runbook is the
> **deploy** side. BUG-2 stays OPEN until a human reports a staging PASS.

### 1.2 Confirm health, console reachability, seed presence (run BEFORE the click-loop)

| Check | Command / action | Expected |
| ----- | ---------------- | -------- |
| API health | `curl https://STAGING-API/health` | `200 {"status":"ok"}` |
| Schema deployed (BUG-2) | `psql "$DATABASE_URL" -c "\dt"` | rows for `job_postings`, `unlocks`, `payer_credits`, `credit_ledger`, `unlock_routing`, `resume_disclosures`, `jobs`, `applications` all present |
| Migrations at head | `psql "$DATABASE_URL" -c "select count(*) from drizzle.__drizzle_migrations"` | **24** applied (0000..0023) |
| Ops console | open `https://STAGING-WEB/ops` | dashboard renders (no login screen — the console is **network-internal**; there is no auth gate in `apps/web`, protection is deployment-level — **flag if publicly reachable**, OBS-4) |
| Seeded job posting exists | `/ops/job-postings` | at least 1 `open` posting (`db:seed:demand` creates one; or create one in step 1) |
| Applicants exist | `/ops/reach/jobs/SEED-JOB-ID/applicants` | ranked rows render (the `db:seed:demand` worker ranks for the `cnc_operator` seed job) |
| Payer credits readable | `/ops/pricing` then enter a payer UUID then "Load payer & balance" | a numeric balance (the seed payer starts at 25) |

### 1.3 Click-path script (expected UI result + expected event per step — re-pinned 2026-06-20)

> Events link via `payload->>'...'` — the `events` table has **no `worker_id` column** (it carries
> `event_name`, `occurred_at`, `subject_type`, `subject_id`, `correlation_id`, `idempotency_key`,
> `payload` jsonb). Filter unlock/payment events by `payload->>'payer_id'` / `payload->>'unlock_id'`.
> Pattern from [b1-device-capstone-runbook.md](b1-device-capstone-runbook.md); pre-staged SQL in §1.4.
> **Every sequence below is pinned to the real service code** (file refs in Phase 2). Note: the
> unlock/posting-plan/capacity flows emit `unlock.requested` (or the entry audit) FIRST, then fire the
> remaining events **post-commit** in the listed order (the deadlock-fix; see Step 3/5 refs).

| # | Action (UI) | Expected on screen | Expected `events` row(s) — exact ordered sequence |
| - | ----------- | ------------------ | ------------------------------------------------- |
| 1 | **Post job** — `/ops/job-postings/new`, pick a vacancy band, save | posting created as **draft**; lands on the posting | `job_posting.created` (status=`draft`, subject=`job_posting`) — Divyanshu surface; verify, file bugs, do NOT fix |
| 1b | **Buy a posting plan** (activates the posting) — purchase a plan/tier | plan active (capacity enforcement is **INERT by default**, so no pause) | `payment.authorized` then `payment.captured` then `job_posting.purchased` (`real_call:false`; `posting_plan.paused` ONLY if `CAPACITY_ENFORCEMENT_ENABLED` AND over cap) |
| 2 | **Applicant feed** — open the posting applicants | ranked rows: rank + score + flags (HOT/PUSH) + Why; **opaque worker IDs only**, no name/phone | `feed.shown` (UNKEYED, ADR-0011 D7) — one per feed load |
| 3a | **Unlock (happy)** — payer **with at least 1 credit**, candidate **with `employer_sharing` consent**, click "Unlock contact" | row shows **Granted, expires ...** | `unlock.requested` then `payment.authorized` then `payment.captured` then `unlock.granted` (last three `real_call:false`, deferred post-commit, in this order) |
| 3b | **Unlock (no credits)** — payer **with 0 credits**, click Unlock | **single neutral "Unavailable..."** message; the **0-credits note** + Pricing link (payer OWN balance, NOT a worker signal) | `unlock.requested` then `payment.failed` (`reason:insufficient_credits`, `real_call:false`) — **NO per-worker `unlock.denied`** (no-oracle: worker state never consulted) |
| 3c-i | **Unlock (capped)** — a worker past the daily/weekly cap | **the exact same neutral message** as 3b (byte-identical) | `unlock.requested` then `unlock.cap_exceeded` (`cap`=`daily_reveals`/`weekly_payers`) then `unlock.denied` (`reason:capped`) — **internal only, never echoed** |
| 3c-ii | **Unlock (no consent)** — a worker **without `employer_sharing`** consent | **the exact same neutral message** as 3b/3c-i | `unlock.requested` then `unlock.denied` (`reason:no_consent` if the worker exists; `reason:unknown_worker` with `unlock_id:null`, subject=`worker`, if it does not) — **internal only, never echoed** |
| 4 | **Reveal** — on a granted row, click "Reveal contact" | a **Routed relay handle** card: handle + channel + expiry, explicitly **"not a phone number"**; **no phone anywhere** | `contact.revealed` (`channel:in_app_relay` KIND only — never the number/handle; `reveal_count` int) |
| 4b | **Masked resume disclosure** — `POST /resume-disclosures {payer_id, worker_id, job_posting_id}` (InternalServiceGuard API; **NO ops-web UI** — see Step 4) | success body `{ok, disclosure_id, status:"disclosed", resume_url, expires_at}` (short-TTL signed URL to the **masked** PDF) **or** the byte-identical neutral body | `resume.disclosed` (FACT only: `disclosure_id`/`payer_id`/`worker_id`/`job_posting_id`/`resume_ref` — **NEVER** the name, bytes, or URL) |
| 5 | **Top-up** — `/ops/pricing`, load a payer, buy `pack_10` / `pack_25` | **balance increments** (+10 / +25); pricing catalog renders | `payment.authorized` + `payment.captured` with **`real_call:false`** (MOCK), `unlock_id:null`, carrying `pack_code`/`amount_inr`/`amount_credits` |
| 5b | **Buy hiring capacity** (optional, ADR-0016) — purchase a capacity tier | allowance raised; any paused plans auto-resume | `payment.authorized` then `payment.captured` then `capacity.purchased` (`real_call:false`; one `posting_plan.resumed` per auto-resumed plan) |

**STOP conditions (release blockers, not bugs):** at step 4 / 4b, a **raw phone / real number** OR a
**full name** on screen or in any client-visible response/log means **STOP** — security-engineer signs
off the defect before any further work (the masked resume must show only masked initials like
"R***** K." and **no phone**). At step 5 / 5b, if **any path can reach a real gateway** (a non-mock
charge, `real_call:true`) means **STOP**, flag TD34 (human-gated).

### 1.4 Pre-staged events SQL (run after each step against staging)

```sql
-- 0) Schema present (BUG-2 cleared)?
\dt
select count(*) as applied from drizzle.__drizzle_migrations;   -- expect 24 (0000..0023)

-- 1) job posting created (step 1) + plan purchased (step 1b)
select event_name, occurred_at, payload
from events
where event_name in ('job_posting.created','job_posting.purchased')
order by occurred_at desc limit 10;

-- 2) feed shown (step 2) — unkeyed; expect one row per feed load
select event_name, occurred_at, payload->>'job_id' as job_id
from events where event_name = 'feed.shown'
order by occurred_at desc limit 5;

-- 3) the full unlock/payment chain for ONE payer (substitute :payer_id)
select event_name, occurred_at,
       payload->>'unlock_id' as unlock_id,
       payload->>'worker_id' as worker_id,
       payload->>'reason'    as reason,
       payload->>'cap'       as cap,
       payload->>'real_call' as real_call
from events
where payload->>'payer_id' = :'payer_id'
  and event_name in ('unlock.requested','unlock.granted','unlock.denied',
                     'unlock.cap_exceeded','payment.authorized','payment.captured',
                     'payment.failed','contact.revealed','resume.disclosed')
order by occurred_at;

-- 3a happy  : unlock.requested -> payment.authorized -> payment.captured -> unlock.granted
-- 3b nocred : unlock.requested -> payment.failed(insufficient_credits)  [NO unlock.denied]
-- 3c-i  cap : unlock.requested -> unlock.cap_exceeded -> unlock.denied(capped)  (INTERNAL only)
-- 3c-ii nc  : unlock.requested -> unlock.denied(no_consent | unknown_worker)    (INTERNAL only)
-- 4  reveal : contact.revealed  (channel KIND only — assert NO phone/number/handle in payload)
-- 4b disclo : resume.disclosed  (ids + resume_ref only — assert NO name/url/bytes in payload)
-- 5  top-up : payment.authorized + payment.captured, real_call=false (pack_code/amount present)

-- 4) HARD ASSERT — no raw phone anywhere in the events spine (10-digit run / +91)
select event_name, payload
from events
where payload::text ~ '(\+?91)?[6-9][0-9]{9}'
order by occurred_at desc;        -- MUST return ZERO rows

-- 5) HARD ASSERT — resume.disclosed never carries a name/url (FACT only)
select event_name, payload
from events
where event_name = 'resume.disclosed'
  and (payload ? 'full_name' or payload ? 'name' or payload ? 'resume_url' or payload::text ~* 'https?://');
-- MUST return ZERO rows
```

### 1.5 Screenshot / evidence checklist (attach to the Phase-2 report)

- [ ] **S1** `/ops/job-postings/new` filled + the created draft posting — step 1
- [ ] **S1b** posting plan purchased (active) — step 1b
- [ ] **S2** applicant feed: ranked rows, **opaque IDs only**, no name/phone — step 2
- [ ] **S3a** unlocked row "Granted, expires ..." — step 3a (happy)
- [ ] **S3b** neutral "Unavailable..." + own-balance 0-credits note — step 3b (no credits)
- [ ] **S3c** neutral "Unavailable..." — step 3c (**must look byte-identical to S3b**)
- [ ] **S4** reveal card: relay handle + channel + expiry, labelled **"not a phone number"** — step 4
- [ ] **S4b** masked-resume disclosure response: masked initials in the PDF, **no phone, no full name** — step 4b (API/payer surface)
- [ ] **S5** `/ops/pricing` balance incremented after pack purchase — step 5
- [ ] **N1** browser/HTTP network trace for steps 3a/4/4b: **no phone/number/full-name** in any response body
- [ ] **E1** the §1.4 event-chain query outputs (3a/3b/3c/4/4b/5) + BOTH **zero-row** asserts (raw-phone + name/url-in-disclosure)

---

## Phase 2 — per-step PASS/FAIL report

> **Runtime status (2026-06-20): every mutating step is NOT-RUN.** The 2026-06-17 probe shows the
> employer/unlock schema is un-deployed in the only reachable DB (BUG-2, still OPEN) and the loop was
> not driven against a real shared DB (§Boundary). So each step positive mark below is **code-verified
> only**; none has been confirmed by a landed `events` row. The drive becomes possible once BUG-2 is
> cleared on a seeded non-prod target.

**Legend:** ✅ code-verified here · ⏳ PENDING-HUMAN (needs the staging click-loop) · ⛔ NOT-RUN/blocked.

### Step 1 — POST JOB + BUY PLAN (Divyanshu surface — verify, file bugs, do NOT fix)
- ✅ **Events pinned — code-verified.** create() emits `job_posting.created` with status **draft**
  ([job-postings.service.ts:65-75](../../apps/api/src/job-postings/job-postings.service.ts#L65)). The
  plan purchase emits, in order, `payment.authorized` then `payment.captured` then `job_posting.purchased`
  ([posting-plans.service.ts:152-154](../../apps/api/src/posting-plans/posting-plans.service.ts#L152));
  capacity enforcement is **INERT by default** (posture B), so no `posting_plan.paused` unless
  `CAPACITY_ENFORCEMENT_ENABLED` AND over cap ([posting-plans.service.ts:134-167](../../apps/api/src/posting-plans/posting-plans.service.ts#L134)).
- ⛔ **NOT-RUN (BUG-2).** Posting creation/activation + render is Divyanshu surface; verify it works as the
  feed entry point. **File bugs, do not fix.**

### Step 2 — APPLICANT FEED (ranked, faceless)
- ✅ **Faceless — code-verified.** [reach.mappers.ts:1-22,182-198](../../apps/api/src/reach/reach.mappers.ts#L1)
  reads only the opaque `workerId` + canonical signals; name/phone/address live only in workers and are
  never touched here. The web row renders `workerId`/score/flags/Why only
  ([unlock-actions.tsx:187-203](../../apps/web/src/app/ops/reach/jobs/[jobId]/applicants/unlock-actions.tsx#L187)).
- ⛔ Rendering against a real posting — **blocked-on-BUG-2** (no rows to rank in any reachable DB).
- ⏳ rank/score actually rendering — PENDING-HUMAN (after BUG-2).

### Step 3 — UNLOCK (debit + honest states)
- ✅ **Debits exactly one credit, atomically with the grant — code-verified.**
  [unlocks.service.ts:188-215](../../apps/api/src/unlocks/unlocks.service.ts#L188) (debit+grant+ledger in one tx, F-6).
- ✅ **Per-step events pinned — code-verified.** Entry audit `unlock.requested` is emitted FIRST
  ([unlocks.service.ts:107,470-490](../../apps/api/src/unlocks/unlocks.service.ts#L107)); the happy path
  defers `payment.authorized` then `payment.captured` then `unlock.granted` post-commit, in that order
  ([unlocks.service.ts:217-220](../../apps/api/src/unlocks/unlocks.service.ts#L217)). No-credits emits
  `payment.failed(insufficient_credits)` with **no** per-worker deny
  ([unlocks.service.ts:113-121](../../apps/api/src/unlocks/unlocks.service.ts#L113)). Capped emits
  `unlock.cap_exceeded` then `unlock.denied(capped)` ([unlocks.service.ts:178-186](../../apps/api/src/unlocks/unlocks.service.ts#L178)).
  No-consent emits `unlock.denied(no_consent | unknown_worker)`, the unknown-worker case writing NO row and
  carrying `unlock_id:null` ([unlocks.service.ts:157-176](../../apps/api/src/unlocks/unlocks.service.ts#L157)).
- ✅ **No-oracle across no-credits / capped / no-consent / unknown / already-unlocked — code-verified.**
  Single neutral body [unlock-response.ts:24-41](../../apps/api/src/unlocks/unlock-response.ts#L24); pure
  mapper with **no cause branch** [unlock-view.ts:70-79](../../apps/web/src/lib/unlock-view.ts#L70);
  credit precondition is **worker-state-independent and checked first** (BC-1)
  [unlocks.service.ts:109-121](../../apps/api/src/unlocks/unlocks.service.ts#L109). The 0-credits note
  is the payer OWN balance, explicitly not a signal about any candidate
  [unlock-actions.tsx:165-173](../../apps/web/src/app/ops/reach/jobs/[jobId]/applicants/unlock-actions.tsx#L165).
- ⏳ the deny paths rendering identically on screen — PENDING-HUMAN (after BUG-2).

### Step 4 — REVEAL + MASKED DISCLOSURE (routed handle / masked initials, NEVER raw phone or full name) — **the release-blocker surface**
- ✅ **Raw phone never leaves the server — code-verified.** Decrypt is single-site + transient, never
  returned/evented/logged/stored; handle is a fresh UUID not derived from the phone
  [unlocks.service.ts:439-462](../../apps/api/src/unlocks/unlocks.service.ts#L439). The reveal body is
  **handle/channel/expiry only** [unlock-response.ts:51-56](../../apps/api/src/unlocks/unlock-response.ts#L51);
  `contact.revealed` carries channel **KIND only** (in_app_relay) [unlocks.service.ts:571-594](../../apps/api/src/unlocks/unlocks.service.ts#L571).
- ✅ **Client shows handle only, labelled "not a phone number" — code-verified.**
  [unlock-actions.tsx:262-283](../../apps/web/src/app/ops/reach/jobs/[jobId]/applicants/unlock-actions.tsx#L262).
- ✅ **Employer-facing masked resume — BUILT (PR #103), code-verified.** This row was previously
  "N/A — not built"; that is now **STALE and corrected**. `POST /resume-disclosures` (behind
  `InternalServiceGuard`) routes to ResumeDisclosureService, which renders the resume from the
  **name-free** stored snapshot with displayName = maskInitials(realName) — the real name is read ONCE,
  masked, then discarded, **never logged/evented/persisted**
  ([resume-disclosure.service.ts:172-249](../../apps/api/src/disclosures/resume-disclosure.service.ts#L172);
  [mask-initials.ts](../../apps/api/src/resume/mask-initials.ts) maps "Ramesh Kumar" to "R***** K."). Phone
  is **not part of the employer resume at all**. The `resume.disclosed` event is the FACT only (ids +
  resume_ref) — **never** the name, bytes, or signed URL
  ([resume-disclosure.service.ts:224-246](../../apps/api/src/disclosures/resume-disclosure.service.ts#L224)).
  The same fail-closed no-oracle neutral body as unlock guards every deny branch
  ([resume-disclosure.controller.ts:40-50](../../apps/api/src/disclosures/resume-disclosure.controller.ts#L40)).
  **WHERE it is reachable:** the `InternalServiceGuard` API endpoint **only** — there is **NO ops-web
  (apps/web) UI** for masked disclosure. The "View masked resume" UI in **apps/payer-web** (the #106/#107
  portals) is a **MOCK** that returns a fake staging.badabhai.example/masked-resume URL from an in-memory
  store ([payer-api.ts:107-131](../../apps/payer-web/src/lib/payer-api.ts#L107)) — it does **not** call the
  real service. So this surface is verifiable today only by calling the API directly (or wiring a real
  payer client to it), not via the ops console.
- ⏳ on-screen/network confirmation that reveal shows the routed handle (never raw) AND the masked
  disclosure shows masked initials + no phone/name — PENDING-HUMAN (after BUG-2).

### Step 5 — TOP-UP + CAPACITY (MOCK ledger only)
- ✅ **No real money — code-verified.** `PAYMENTS_ENABLE_REAL` default false + boot fail-closed
  ([server.ts:273-293](../../packages/config/src/server.ts#L273), config.test.ts asserts both); the mock
  pack purchase stamps `real_call:false` and emits `payment.authorized` + `payment.captured` with
  pack_code/amount_inr/amount_credits ([unlocks.service.ts:364-385](../../apps/api/src/unlocks/unlocks.service.ts#L364));
  unknown pack means 404, not the no-oracle path
  ([unlocks.controller.ts:102-112](../../apps/api/src/unlocks/unlocks.controller.ts#L102)). Capacity buy
  defers `payment.authorized` then `payment.captured` then `capacity.purchased`
  ([posting-plans.service.ts:281-283](../../apps/api/src/posting-plans/posting-plans.service.ts#L281)).
- ⏳ balance increment + catalog render on screen — PENDING-HUMAN (after BUG-2).

---

## Phase 3 — verdict + filed bugs

**Verdict (2026-06-20, PREP refresh):** the alpha employer surface is **security-sound in code** — no
raw-phone reveal path, **no full-name leak on the masked employer resume (PR #103)**, no reachable
real-payment path, no-oracle preserved (shared by unlock + disclosure), faceless feed, server-only
secret. It is **NOT runtime-verified**: the 2026-06-17 runtime probe gives the concrete, evidenced
blocker — **the employer/unlock schema is not applied to any reachable environment (BUG-2, still
OPEN)** — so every mutating step is **NOT-RUN**, with **0** unlock/contact/payment events ever emitted.
The three release-blockers (raw-phone reveal, full-name on masked resume, real gateway) remain
**code-verified absent**; they **cannot be runtime-confirmed** until the loop is driven against a
seeded non-prod target — a **§7 human-gated** action because reveal/disclosure decrypt real PII (see
§Boundary). No release blocker was found; all three must be re-confirmed on a live trace at steps
4/4b/5 once a proper target exists.

### Filed bugs / observations

| ID | Sev | What | Where | Owner |
| -- | --- | ---- | ----- | ----- |
| **BUG-1** | ~~High~~ → ✅ **FIXED 2026-06-17** | Real JobSource replaces the dev-only stub binding so the API boots in staging and the feed resolves a real job. The interim #67 `JobPostingsJobSource` was **superseded by divyuuu `JobsTableJobSource`** ([ADR-0015](../decisions/0015-reach-feed-on-real-jobs.md), PR #69) reading the live `jobs` entity (faceless projection + mapper, no-PII test). Live staging run still pending. | [reach.module.ts](../../apps/api/src/reach/reach.module.ts), [reach.job-source.ts](../../apps/api/src/reach/reach.job-source.ts) | backend-engineer (done) |
| **BUG-2** | **High (blocks the run) — OPEN** | **The employer/unlock schema is not deployed.** The DB this repo .env reaches had only the Phase-1 worker-profiling tables; `jobs`/`applications`/`job_postings`/`unlocks`/`payer_credits`/`credit_ledger`/`unlock_routing`/`resume_disclosures` are **absent** and the journal is far behind head (10 applied at probe vs **24** in repo, 0000–0023). No environment reachable from here can host a single mutating step (0 unlock/contact/payment events ever). Schema **is on main** — this is a **deploy/migrate gap**, not a code gap. **On-deploy fix sequence (devops + database-architect):** stand up a disposable non-prod staging DB, `pnpm db:migrate` to head (0023), `pnpm --filter @badabhai/db db:seed:jobs` + `pnpm db:seed:demand` (synthetic employer_sharing-consented worker + open job_posting + credited payer; idempotent, prod-guarded), point the API at it with `NODE_ENV=staging` (so the real `JobsTableJobSource` binds), `pnpm db:verify:demand` (asserts the six events), then the §1.3 human click-path. See §1.1a. | `packages/db/migrations/*` + deploy target | devops + database-architect |
| **OBS-2** | Med (launch gate, known) | Payer identity is **unauthenticated** — all unlock/reveal/credits/**disclosure** routes are behind `InternalServiceGuard`; payer_id is trusted from the request body. Any ops actor can act as any payer. Acceptable for alpha **ops-run** only; a real PayerAuthGuard + horizontal-authz test is a hard launch gate. | [unlocks.controller.ts:26-42](../../apps/api/src/unlocks/unlocks.controller.ts#L26) + [resume-disclosure.controller.ts:27-29](../../apps/api/src/disclosures/resume-disclosure.controller.ts#L27) (TD33) | security + backend |
| **OBS-3** | ~~Med (build gate)~~ → ✅ **CLOSED by PR #103** | The employer-facing **masked** resume surface now exists: ResumeDisclosureService + maskInitials (masked initials, NO phone, NO full name) emitting `resume.disclosed`, with the no-oracle neutral body and a single name-decrypt site. Build gate **B-G** is satisfied in code (golden-render: "Ramesh Kumar" to "R***** K."). **Remaining:** reachable only via the `InternalServiceGuard` API (no ops-web UI; payer-web is a mock) — a real payer client + a live masked-render trace are PENDING-HUMAN (after BUG-2). | [resume-disclosure.service.ts](../../apps/api/src/disclosures/resume-disclosure.service.ts) / [mask-initials.ts](../../apps/api/src/resume/mask-initials.ts) | frontend + security |
| **OBS-4** | Low | Ops console has **no auth gate** (apps/web has no middleware/login) — relies on network-internal deployment. Confirm it is not publicly reachable in staging. | `apps/web/src/app/**` (no middleware.ts) | devops |

> No defect was found on the reveal path (raw-phone leak), the masked-disclosure path (full-name leak),
> or the payment path (real gateway). If the human run surfaces any of them at step 4/4b/5, it is a
> **release blocker** — stop, hand to security-engineer (reveal/disclosure) / flag TD34 (payments),
> do not merge.

### Cross-links
[ADR-0010](../decisions/0010-contact-unlock-and-reveal.md) · [ADR-0013](../decisions/0013-monetization-and-config-driven-pricing-engine.md) ·
[contact-unlock threat model](../security/contact-unlock-threat-model.md) ·
[resume-disclosure addendum](../security/resume-disclosure-threat-model-addendum.md) · TD33 (payer auth) · TD34 (real payments) ·
[b1-device-capstone-runbook.md](b1-device-capstone-runbook.md) (staging prereq + event-query pattern).
