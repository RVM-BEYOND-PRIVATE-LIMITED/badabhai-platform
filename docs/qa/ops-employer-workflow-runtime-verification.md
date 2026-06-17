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
| **The end-to-end UI loop actually works** | ⏳ **UNVERIFIED** | needs staging + a human click-loop (Phase 2) |
| **API boots + feed resolves in staging** | ✅ **FIXED (code)** · ⏳ run pending | **BUG-1 RESOLVED** — `JobPostingsJobSource` implemented + env-bound; needs a live staging run to confirm |
| **Employer-facing resume is masked** | ➖ **N/A — not built** | no employer resume surface exists; masking is build-gate **B-G** ([addendum](../security/resume-disclosure-threat-model-addendum.md)) |

**Bottom line:** the security-critical guarantees (no raw-phone leak, no real money, no-oracle)
**hold in code**. The workflow **cannot be runtime-verified yet** — it is blocked on (a) staging
not deployed and (b) **BUG-1** (the reach feed still serves the dev-only stub, which refuses to
boot in staging). Clear BUG-1 + deploy staging, then run Phase 2 with a human.

---

## Phase 1 — make it turnkey (before anyone clicks)

### 1.0 Prerequisite gates (must be true or the run is invalid)

1. ✅ **BUG-1 FIXED (2026-06-17).** `apps/api/src/reach/reach.module.ts` now binds `JOB_SOURCE`
   environment-dependently: dev/test → `StubJobSource` (unchanged), **staging/production →
   `JobPostingsJobSource`** ([reach.job-postings-source.ts](../../apps/api/src/reach/reach.job-postings-source.ts)),
   which reads the real `job_postings` table and maps rows → `JobSpec` (faceless; `roleTitle`
   canonicalized via `@badabhai/taxonomy`; demand signals the stored-only posting lacks are omitted
   → engine neutral-defaults). The API now boots in staging and the feed resolves a real posting.
   Covered by `reach.job-postings-source.test.ts` (11 tests) + the existing D6-gate test; full API
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

**Legend:** ✅ code-verified here · ⏳ PENDING-HUMAN (needs the staging click-loop) · ⛔ blocked.

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

**Verdict:** the alpha employer surface is **security-sound in code** — no raw-phone reveal path,
no reachable real-payment path, no-oracle preserved, faceless feed, server-only secret. It is
**NOT yet runtime-verified**, and is **currently un-runnable in staging** until BUG-1 is fixed and
staging is deployed. No release blocker (raw-phone leak / real gateway) was found; both are verified
absent in code and must be re-confirmed on the live trace by the human at steps 4–5.

### Filed bugs / observations

| ID | Sev | What | Where | Owner |
| -- | --- | ---- | ----- | ----- |
| **BUG-1** | ~~High (blocks the run)~~ → ✅ **FIXED 2026-06-17** | `JobPostingsJobSource` implemented + env-bound (dev/test stub unchanged; staging/prod reads `job_postings` → `JobSpec`, faceless, taxonomy-canonicalized role). API boots in staging; feed resolves a real posting. Tests + typecheck + lint + build green. Live staging run still pending. | [reach.job-postings-source.ts](../../apps/api/src/reach/reach.job-postings-source.ts), [reach.module.ts](../../apps/api/src/reach/reach.module.ts) | backend-engineer (done) |
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
