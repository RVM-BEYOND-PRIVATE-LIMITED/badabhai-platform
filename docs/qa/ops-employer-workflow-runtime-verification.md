# Ops Employer Workflow — Runtime Verification (runbook + PASS/FAIL report)

> **Why this exists:** the ops-console employer surface (job → ranked feed → unlock →
> reveal → top-up) is **built and CI-green but never exercised by a human**. CI-green ≠ works,
> and this is the **entire employer surface for alpha**. This doc makes the run **turnkey**,
> records what is **statically verifiable from code** (done here), and leaves the **UI click-loop
> for a human** (cannot be done from CI / this env).
>
> **Read first:** [CLAUDE.md](../../CLAUDE.md) · [ADR-0010](../decisions/0010-contact-unlock-and-reveal.md) ·
> the identity-masking decision (commit **eafcccc**, [resume-disclosure-threat-model-addendum.md](../security/resume-disclosure-threat-model-addendum.md)).
> **Drive:** qa-engineer (verdict) · frontend-engineer (build/run + quick fixes) · security-engineer (reveal-path gate).
> **Scope:** verification + DOCS. No code changed here. Real money is OUT (mock ledger).
>
> **Release-blocker rules (not "bugs"):** a reveal that shows a **raw phone**, or a top-up that
> can hit a **real gateway**, is a **release blocker**. Both are **code-verified ABSENT** below.

---

## TL;DR verdict (2026-06-17)

| Area | Verdict | Basis |
| ---- | ------- | ----- |
| **Reveal never leaks a raw phone** | ✅ **PASS (code-verified)** | decrypt is transient + single-site; client sees handle only |
| **No real-payment path reachable** | ✅ **PASS (code-verified)** | mock default + boot fail-closed + `real_call:false` |
| **No-oracle (unlock/reveal states honest)** | ✅ **PASS (code-verified)** | single neutral body + pure mapper, no cause branch |
| **Service token stays server-side** | ✅ **PASS (code-verified)** | `process.env` only, in `"use server"` actions |
| **Applicant feed is faceless** | ✅ **PASS (code-verified)** | mappers read opaque `workerId` + signals only |
| **The end-to-end loop actually works** | ⛔ **NOT-RUN** | runtime probe (2026-06-17): employer schema **un-deployed** in the only reachable DB → 0 unlock/contact/payment events ever; needs a seeded staging target + human |
| **API boots + feed resolves in staging** | ✅ **FIXED (code)** · ⏳ run pending | **BUG-1 RESOLVED** via divyuuu's `JobsTableJobSource` (ADR-0015, supersedes the interim #67 `JobPostingsJobSource`); needs a live staging run to confirm |
| **Employer/unlock schema deployed** | ⛔ **NO** | **BUG-2** — reachable DB is **9 migrations behind**; `jobs`/`applications`/`unlocks`/`payer_credits`/`credit_ledger`/`job_postings` all absent |
| **Employer-facing resume is masked** | ➖ **N/A — not built** | no employer resume surface exists; masking is build-gate **B-G** ([addendum](../security/resume-disclosure-threat-model-addendum.md)) |

**Bottom line:** the security-critical guarantees (no raw-phone leak, no real money, no-oracle)
**hold in code**. The workflow is **still NOT runtime-verified**, and a 2026-06-17 runtime probe
(below) shows *why*, with hard evidence: **the employer/unlock schema is not deployed to any
reachable environment.** BUG-1 (stub feed source) is fixed in code; the live blocker is now
**BUG-2 — migrations not applied** (the reach/unlock tables don't exist in the only DB this repo's
`.env` reaches). Deploy a staging target with the full schema + seed, then run Phase 2 with a human;
driving the mutating loop against a **shared/real DB** (it decrypts a real worker's phone at reveal)
is a **CLAUDE.md §7 human-gated action** and must target a disposable non-prod DB.

---

## Runtime probe (2026-06-17) — what was actually checked at runtime

> The strict bar for "finished" is **evidence, not code-reading**: the loop driven + the matching
> `events` rows present. This probe is the maximum runtime check executable from this environment
> **read-only** — it does not (and must not) drive writes against the reachable DB (see §boundary).

**Environment reachable from this repo:** `DATABASE_URL` → a hosted Supabase Postgres
(`aws-1-ap-south-1.pooler.supabase.com`), `NODE_ENV=development`, `REDIS_URL=localhost:6379`
(not running), **no Docker installed** (can't stand up a fresh full stack), no browser (no
screenshots possible).

| Probe (read-only SQL / config) | Result | What it proves |
| ------------------------------ | ------ | -------------- |
| `events` total / distinct names | **140 rows, 13 names** — all Phase-1 (chat/otp/profile/resume/consent/ai.cost) | the DB is live and exercised, but only for **worker profiling** |
| `events` where name `~ '^(unlock\|contact\|payment)\.'` | **0 rows** | the employer monetization loop has **never run** here — not one unlock/reveal/payment event exists |
| Tables present (`information_schema`) | 14 Phase-1 tables; **`jobs`, `applications`, `job_postings`, `unlocks`, `payer_credits`, `credit_ledger`, `unlock_routing` ALL ABSENT** | the loop **cannot** run here — its tables don't exist |
| `drizzle.__drizzle_migrations` | **10 applied**; repo has **19** | the reachable DB is **9 migrations behind** — incl. ADR-0009 (jobs/applications) + ADR-0010/0012/0015 (unlock/job_postings/reach) → **BUG-2** |
| `NODE_ENV` | `development` | a local API boot would bind the **`StubJobSource`**, not the real `JobsTableJobSource` (staging/prod only) — so even a local run wouldn't exercise the real feed |
| `PAYMENTS_ENABLE_REAL` (.env) | absent → default **false** | the payment kill-switch is at its safe default in this env (consistent with the code-verified no-real-gateway finding) |

**Conclusion of the probe:** "CI-green ≠ works" is confirmed in the strongest form — the employer
surface is not merely un-clicked, it is **un-deployed**: there is no environment reachable from
this repo where a single mutating step could land its event. The per-step report below is therefore
**NOT-RUN (environment cannot host the loop)**, not "pending a click."

### §Boundary — why the loop was not driven from here (and must not be, autonomously)
Driving `POST /unlocks` → `/reveal` → top-up requires (a) the schema deployed and (b) writing
`unlocks`/`credit_ledger` rows and, at **reveal, decrypting a real worker's `phoneE164`** — the
single highest-risk PII path in the product (ADR-0010 §Context). Doing that against the **shared,
real** Supabase DB is a **CLAUDE.md §7 escalation** (touches production data + real PII) and was
**not performed**. The correct target is a **disposable non-prod DB** with migrations applied + a
**synthetic** consented worker, where a reveal decrypts a fixture phone — never a real worker's.

---

## Phase 1 — make it turnkey (before anyone clicks)

### 1.0 Prerequisite gates (must be true or the run is invalid)

1. ✅ **BUG-1 FIXED (2026-06-17).** `apps/api/src/reach/reach.module.ts` binds `JOB_SOURCE` to a
   real source replacing the dev-only `StubJobSource`. **Superseded note:** the interim
   `JobPostingsJobSource` (reading `job_postings`) from #67 was **replaced by divyuuu's
   `JobsTableJobSource`** ([ADR-0015](../decisions/0015-reach-feed-on-real-jobs.md), PR #69),
   which serves the live ADR-0009 `jobs` entity via a faceless `JobSignalRow` projection +
   pure `jobSignalRowToJobSpec` mapper (the no-PII boundary, asserted by a projection test).
   The API now boots in staging and the feed resolves a real `jobs` row. Covered by
   ADR-0015's JobsTableJobSource tests + the existing D6-gate test; full API
   suite 326/326, typecheck/lint/build green. **Still requires a live staging run to confirm at runtime.**
2. **Staging must be deployed** with a concrete HTTPS URL (same blocker as B1 — see
   [b1-device-capstone-runbook.md](b1-device-capstone-runbook.md) prereq #1). Until then the run
   is invalid (local is fine for a dev smoke, NOT for the verification verdict).
3. **`INTERNAL_SERVICE_TOKEN`** set identically in `apps/api` and `apps/web` envs (the ops writes
   are behind `InternalServiceGuard`; the web attaches it server-side).

### 1.1 Run API + web against staging, with seed data

```bash
# From repo root.
pnpm install
pnpm build                       # build @badabhai/* first (Turbo order)

# DB: apply migrations + seed jobs/questionnaire (seed scripts exist).
pnpm db:migrate
pnpm --filter @badabhai/db exec tsx src/seed.ts             # base seed
pnpm --filter @badabhai/db exec tsx src/seed-jobs.ts        # seeded jobs/applicants (ADR-0009)
pnpm db:seed:demand                                         # BUG-2: synthetic DEMAND fixture (worker+profile+employer_sharing consent, open job_posting, credited payer)
# (seed-questionnaire.ts is available if you need profile questions too)

# API (point at the staging DB/Redis via apps/api env; NODE_ENV=staging|production):
pnpm --filter @badabhai/api start

# Web ops console (separate shell). NEXT_PUBLIC_API_URL → the API; INTERNAL_SERVICE_TOKEN in env:
pnpm --filter @badabhai/web dev      # or `build && start` for a prod-like run
```

> **Seed reality check:** `seed-jobs.ts` seeds the **ADR-0009 swipe `jobs`/`applications`** entity.
> The **employer feed** (`/ops/reach/jobs/[jobId]/applicants`) reads via `JOB_SOURCE` — which, once
> BUG-1 is fixed, is the **`job_postings`** entity (a *different* table). So you also need a real
> **job posting** (the other dev's surface, step 1 below) plus worker profiles that rank for it.

### 1.1a One-command demand seed + verify (BUG-2 reproducer)

`db:seed:demand` removes the manual-fixture step: it builds the whole synthetic, faceless demand-side
fixture in one **idempotent**, **prod-guarded** (`NODE_ENV !== "production"`) command and prints the ids.
`db:verify:demand` then drives the loop through the **real HTTP API** and asserts the events spine — so
"does the employer/unlock loop work?" becomes one command instead of a manual click-path.

```bash
# After db:migrate + db:seed:jobs, with the API running against the SAME DB and the
# SAME PII_ENCRYPTION_KEY / PII_HASH_PEPPER the seed used:
pnpm db:seed:demand        # prints worker_id / payer_id / job_posting_id (prefix NODE_ENV=staging if the box defaults to production)
API_BASE_URL=https://<staging-api> INTERNAL_SERVICE_TOKEN=<token> pnpm db:verify:demand
```

`db:verify:demand` runs **plan → applicants → unlock → reveal** and PASSES only when the `events` table
recorded all six: `feed.shown`, `job_posting.purchased`, `payment.authorized`, `payment.captured`,
`unlock.granted`, `contact.revealed`. MOCK payments only (`PAYMENTS_ENABLE_REAL=false`); the synthetic
worker's phone is encrypted via the **shared crypto** so the reveal-path decrypt matches. Neither script
applies migrations — `db:migrate` against staging stays the **§7 human-credentialed** step.
Sources: [seed-demand.ts](../../packages/db/src/seed-demand.ts) · [verify-demand.ts](../../packages/db/src/verify-demand.ts).

### 1.2 Confirm health, console reachability, seed presence

| Check | Command / action | Expected |
| ----- | ---------------- | -------- |
| API health | `curl https://<staging-api>/health` | `200 {"status":"ok"}` |
| Ops console | open `https://<staging-web>/ops` | dashboard renders (no login screen — the console is **network-internal**; there is no auth gate in `apps/web`, protection is deployment-level — flag if exposed publicly) |
| Seeded job posting exists | `/ops/job-postings` | ≥1 `open` posting (create one in step 1 if empty) |
| Applicants exist | `/ops/reach/jobs/<postingId>/applicants` | ranked rows render (needs ranked worker profiles in the DB) |
| Payer credits readable | enter a payer UUID → "Load payer & balance" | a numeric balance (0 is fine) |

### 1.3 Click-path script (expected result + expected event per step)

> Run staging DB queries with the event-chain pattern from
> [b1-device-capstone-runbook.md](b1-device-capstone-runbook.md) — events link via
> `payload->>'...'`, the `events` table has **no `worker_id` column**. Filter unlock/payment
> events by `payload->>'payer_id'` / `payload->>'unlock_id'`.

| # | Action (UI) | Expected on screen | Expected `events` row(s) |
| - | ----------- | ------------------ | ------------------------ |
| 1 | **Post job** — `/ops/job-postings/new`, pick a vacancy band, save | posting created; lands on the posting; an **applicants counter** is present (`applicants_received`) | `job_posting.created` *(other dev's surface — verify, file bugs, don't fix)* |
| 2 | **Applicant feed** — open the posting's applicants | ranked rows: **rank + score + flags (HOT/PUSH) + Why**; **opaque worker IDs only**, no name/phone | `feed.shown` (UNKEYED, ADR-0011 D7) |
| 3a | **Unlock (happy)** — load a payer **with ≥1 credit**, click "Unlock contact" | row shows **Granted · expires …** | `unlock.requested` → `payment.authorized` → `payment.captured` → `unlock.granted` |
| 3b | **Unlock (no credits)** — load a payer **with 0 credits**, click Unlock | **single neutral "Unavailable…"** message; the **0-credits note** + link to Pricing shows (payer's *own* balance, not a worker signal) | `unlock.requested` → `payment.failed` (`insufficient_credits`) — **no `unlock.denied` per-worker row** (no-oracle) |
| 3c | **Unlock (capped/no-consent)** — a worker past cap or without `employer_sharing` | **the exact same neutral message** as 3b (indistinguishable) | `unlock.requested` → `unlock.cap_exceeded`+`unlock.denied` (capped) **or** `unlock.denied` (no_consent) — internal only, **never echoed** |
| 4 | **Reveal** — on a granted row, click "Reveal contact" | a **Routed relay handle** card: handle + channel + expiry, **explicitly "not a phone number"**; **no phone anywhere** | `contact.revealed` (`channel` KIND only — never the number/handle) |
| 5 | **Top-up** — `/ops/pricing`, load a payer, buy a pack | **balance increments**; pricing catalog renders | `payment.authorized` + `payment.captured` with **`real_call:false`** (MOCK) |

**STOP conditions (release blockers, not bugs):** at step 4 a **raw phone / real number** appears
on screen or in any network response/log the client sees → STOP, security-engineer signs off the
defect before any further work. At step 5 if **any path can reach a real gateway** (e.g. a non-mock
charge, `real_call:true`) → STOP, flag TD34 (human-gated).

---

## Phase 2 — per-step PASS/FAIL report

> **Runtime status (2026-06-17): every mutating step is ⛔ NOT-RUN.** The probe above shows the
> employer/unlock schema is un-deployed in the only reachable DB (BUG-2) and the loop was not driven
> against a real shared DB (§Boundary). So each step's positive marks below are **code-verified only**;
> none has been confirmed by a landed `events` row. The drive becomes possible once BUG-2 is cleared
> on a seeded non-prod target.

**Legend:** ✅ code-verified here · ⏳ PENDING-HUMAN (needs the staging click-loop) · ⛔ NOT-RUN/blocked.

### Step 1 — POST JOB (other dev's surface — verify, file bugs, don't fix)
- ⏳ **PENDING-HUMAN.** Posting creation + `applicants_received` counter render is the other dev's
  surface; `applicants_received` (migration 0017, additive) exists in schema. Verify it works as the
  feed's entry point; **file bugs, do not fix.**

### Step 2 — APPLICANT FEED (ranked, faceless)
- ✅ **Faceless — code-verified.** [reach.mappers.ts:1-22,182-198](../../apps/api/src/reach/reach.mappers.ts#L1)
  reads only the opaque `workerId` + canonical signals; "Name/phone/address live only in `workers` and
  are never touched here." The web row renders `workerId`/score/flags/Why only
  ([unlock-actions.tsx:187-203](../../apps/web/src/app/ops/reach/jobs/[jobId]/applicants/unlock-actions.tsx#L187)).
- ⛔ **Rendering against a real posting — BLOCKED by BUG-1** (stub won't boot in staging).
- ⏳ rank/score actually rendering for a real posting → PENDING-HUMAN (after BUG-1).

### Step 3 — UNLOCK (debit + honest states)
- ✅ **Debits exactly one credit, atomically with the grant — code-verified.**
  [unlocks.service.ts:188-215](../../apps/api/src/unlocks/unlocks.service.ts#L188) (debit+grant+ledger in one tx, F-6).
- ✅ **No-oracle across no-credits / capped / no-consent / unknown / already-unlocked — code-verified.**
  Single neutral body [unlock-response.ts:24-41](../../apps/api/src/unlocks/unlock-response.ts#L24); pure
  mapper with **no cause branch** [unlock-view.ts:70-79](../../apps/web/src/lib/unlock-view.ts#L70);
  credit precondition is **worker-state-independent and checked first** (BC-1)
  [unlocks.service.ts:109-121](../../apps/api/src/unlocks/unlocks.service.ts#L109). The 0-credits note
  is the payer's **own** balance, explicitly "not a signal about any candidate"
  [unlock-actions.tsx:165-173](../../apps/web/src/app/ops/reach/jobs/[jobId]/applicants/unlock-actions.tsx#L165).
- ⏳ the three paths (happy / no-credits / capped) rendering identically on screen → PENDING-HUMAN.

### Step 4 — REVEAL (routed handle, NEVER raw phone) — **the release-blocker surface**
- ✅ **Raw phone never leaves the server — code-verified.** Decrypt is single-site + transient,
  "NEVER returned, evented, logged, or stored," handle is a fresh UUID not derived from the phone
  [unlocks.service.ts:439-462](../../apps/api/src/unlocks/unlocks.service.ts#L439). The reveal body is
  **handle/channel/expiry only** [unlock-response.ts:51-56](../../apps/api/src/unlocks/unlock-response.ts#L51);
  `contact.revealed` carries `channel` **KIND only** [unlocks.service.ts:571-594](../../apps/api/src/unlocks/unlocks.service.ts#L571).
- ✅ **Client shows handle only, labelled "not a phone number" — code-verified.**
  [unlock-actions.tsx:262-283](../../apps/web/src/app/ops/reach/jobs/[jobId]/applicants/unlock-actions.tsx#L262).
  Server actions never log the handle/result [actions.ts:30-33,101-113](../../apps/web/src/app/ops/reach/jobs/[jobId]/applicants/actions.ts#L30).
- ➖ **Employer-facing masked resume — N/A, NOT BUILT.** `maskInitials` exists only in the decision
  doc (commit eafcccc); the renderer takes a real `displayName`/null and applies **no mask**
  ([resume-renderer.service.ts:7-18](../../apps/api/src/resume/resume-renderer.service.ts#L7)). There is
  **no employer-facing resume surface** in the ops flow — so nothing to mask and nothing leaks. The
  masked render is **build gate B-G** and MUST precede any future employer resume surface.
- ⏳ on-screen confirmation that reveal shows masked/routed (never raw) + a clean network trace →
  PENDING-HUMAN. (Code says it cannot leak; the human confirms the live trace.)

### Step 5 — TOP-UP (MOCK ledger only)
- ✅ **No real money — code-verified.** `PAYMENTS_ENABLE_REAL` default false + boot fail-closed
  ([server.ts:273-293](../../packages/config/src/server.ts#L273), config.test.ts asserts both); mock
  purchase stamps `real_call:false` [payment-gateway.ts:71-83](../../apps/api/src/unlocks/payment-gateway.ts#L71);
  unknown pack → 404, not the no-oracle path [unlocks.controller.ts:102-112](../../apps/api/src/unlocks/unlocks.controller.ts#L102).
- ⏳ balance increment + catalog render on screen → PENDING-HUMAN.

---

## Phase 3 — verdict + filed bugs

**Verdict (2026-06-17, after the runtime probe):** the alpha employer surface is **security-sound in
code** — no raw-phone reveal path, no reachable real-payment path, no-oracle preserved, faceless
feed, server-only secret. It is **NOT runtime-verified**, and the runtime probe upgrades the reason
from "staging not deployed" to a concrete, evidenced blocker: **the employer/unlock schema is not
applied to any reachable environment (BUG-2)** — every mutating step is **NOT-RUN**, with **0**
unlock/contact/payment events ever emitted. The two release-blockers (raw-phone reveal, real
gateway) remain **code-verified absent**; they **cannot be runtime-confirmed** until the loop is
driven against a seeded non-prod target — which is a **§7 human-gated** action because reveal
decrypts real PII (see §Boundary). No release blocker was found; both must be re-confirmed on a live
trace at steps 4–5 once a proper target exists.

### Filed bugs / observations

| ID | Sev | What | Where | Owner |
| -- | --- | ---- | ----- | ----- |
| **BUG-1** | ~~High (blocks the run)~~ → ✅ **FIXED 2026-06-17** | Real `JobSource` replaces the dev-only stub binding so the API boots in staging and the feed resolves a real job. The interim #67 `JobPostingsJobSource` was **superseded by divyuuu's `JobsTableJobSource`** ([ADR-0015](../decisions/0015-reach-feed-on-real-jobs.md), PR #69) reading the live `jobs` entity (faceless projection + mapper, no-PII test). Live staging run still pending. | [reach.module.ts](../../apps/api/src/reach/reach.module.ts), [reach.job-source.ts](../../apps/api/src/reach/reach.job-source.ts) | backend-engineer (done) |
| **BUG-2** | **High (blocks the run)** — found by the 2026-06-17 runtime probe | **The employer/unlock schema is not deployed.** The DB this repo's `.env` reaches has only the 14 Phase-1 worker-profiling tables; `jobs`/`applications`/`job_postings`/`unlocks`/`payer_credits`/`credit_ledger`/`unlock_routing` are **absent** and the journal is **9 migrations behind** (10 applied vs 19 in repo). No environment reachable from here can host a single mutating step (0 unlock/contact/payment events ever). **Fix:** stand up a staging/non-prod DB, `pnpm db:migrate` to head, then seed in one command — `pnpm db:seed:jobs` + `pnpm db:seed:demand` (the synthetic `employer_sharing`-consented worker + open job_posting + credited payer; idempotent, prod-guarded), point the API at it with `NODE_ENV=staging` (so the real `JobsTableJobSource` binds), and run `pnpm db:verify:demand` to drive the loop and assert the events. See §1.1a. | `packages/db/migrations/*` (0009/0010/0012/0014/0015 unapplied) + deploy target | devops + database-architect |
| **OBS-2** | Med (launch gate, known) | Payer identity is **unauthenticated** — all unlock/reveal/credits routes are behind `InternalServiceGuard`; `payer_id` is trusted from the request body. Any ops actor can act as any payer. Acceptable for alpha **ops-run** only; a real `PayerAuthGuard` + horizontal-authz test is a hard launch gate. | [unlocks.controller.ts:26-42](../../apps/api/src/unlocks/unlocks.controller.ts#L26) (TD33) | security + backend |
| **OBS-3** | Med (build gate) | No employer-facing **masked** resume surface exists; `maskInitials` is doc-only. Before ANY employer resume surface ships, build gate **B-G** (masked initials, no phone, golden-render test) must land in the same change. | [addendum](../security/resume-disclosure-threat-model-addendum.md) / [resume-renderer.service.ts](../../apps/api/src/resume/resume-renderer.service.ts) | frontend + security |
| **OBS-4** | Low | Ops console has **no auth gate** (`apps/web` has no middleware/login) — relies on network-internal deployment. Confirm it is not publicly reachable in staging. | `apps/web/src/app/**` (no `middleware.ts`) | devops |

> No defect was found on the reveal path (raw-phone leak) or the payment path (real gateway). If the
> human run surfaces either at step 4/5, it is a **release blocker** — stop, hand to security-engineer
> (reveal) / flag TD34 (payments), do not merge.

### Cross-links
[ADR-0010](../decisions/0010-contact-unlock-and-reveal.md) · [contact-unlock threat model](../security/contact-unlock-threat-model.md) ·
[resume-disclosure addendum](../security/resume-disclosure-threat-model-addendum.md) · TD33 (payer auth) · TD34 (real payments) ·
[b1-device-capstone-runbook.md](b1-device-capstone-runbook.md) (staging prereq + event-query pattern).
