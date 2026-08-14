# ADR-0031 — Account-deletion 7-day grace window (amends ADR-0026 Phase 5 D1/D2/D4)

- Status: **Accepted** (Prakash, 2026-07-14 — relayed by Divyanshu; scope ratified: 7-day scheduled hard-delete · cancel anytime during grace · payer/job surfaces frozen during grace · actual hard-delete after 7 days)
- Date: 2026-07-14
- Amends: [ADR-0026](0026-production-worker-auth-pin-and-tiered-sessions.md) Phase 5 addendum — decisions **D1** (confirm executes erasure in-request), **D2** (hard-delete now; soft-delete rejected), **D4** (inline synchronous orchestration)
- Deciders: Prakash (TL), Akshit (CEO); drafted by Divyanshu
- Do **not** confuse with DB **migration 0031** (the Phase-5 billing-FK `cascade→set null` migration) — same number, different namespace.

## Context

`POST /auth/account/delete/confirm` verifies a step-up OTP and then runs
`AccountDeletionService.execute(workerId)` **inline** — sessions revoked, storage erased,
`workers` row hard-deleted with cascade, tombstone + `worker.account_deleted` emitted —
all within the request (ADR-0026 Phase 5 D1+D4). Erasure is **immediate and irreversible**
on confirm.

But the **shipped app copy already promises the opposite**
([settings_screen.dart:37-41](../../apps/worker-app/lib/features/settings/presentation/settings_screen.dart)):

> "OTP verify karne ke baad aapka account **7 din mein delete ho jaata hai. Is dauraan aap
> kabhi bhi cancel kar sakte hain.**"

The same promise repeats in the OTP dialog (lines 215-218). Today that promise is **false**:
there is no grace, no cancel path (no endpoint, no UI, no flag — verified repo-wide). A
disclosed-but-unhonored erasure flow is itself a DPDP-transparency defect. This ADR makes the
disclosed behaviour the real behaviour.

## Decision

Convert worker account deletion from **immediate erasure** to a **7-day scheduled
hard-delete with cancel-anytime**:

1. **Confirm schedules, never erases.** After the step-up OTP verifies, set
   `workers.deletion_scheduled_at = now() + ACCOUNT_DELETION_GRACE_DAYS` and emit
   `worker.deletion_scheduled` (PII-free). Return `200 { scheduled_for }` (was `204`).
   Idempotent: a second confirm during grace returns the **same** `scheduled_for` (no
   re-extension — the clock never resets without a cancel).
2. **Cancel anytime.** New `POST /auth/account/delete/cancel` (`WorkerAuthGuard`, id from
   the token — no body id, no IDOR): clears `deletion_scheduled_at`, emits
   `worker.deletion_cancelled` (PII-free). Idempotent: cancel with nothing pending = `200`
   no-op, no event.
3. **Erasure after grace, unchanged.** A sweep finds `deletion_scheduled_at <= now()` and
   calls the existing `AccountDeletionService.execute(workerId)` **unchanged** — the same
   fixed-order, idempotent, best-effort-complete cascade; `worker.account_deleted` stays the
   final erasure event. No erasure logic is duplicated.

### Ruled sub-decisions (drafted 2026-07-14 by Divyanshu; RATIFIED by Prakash the same day — see Sign-off)

| # | Question | Ruling |
|---|----------|--------|
| (a) | Login during grace | **Explicit cancel prompt** — login works normally; the app shows a pending banner with a "Delete cancel karein" action. **No silent auto-cancel**: voiding a formally-confirmed erasure request requires an explicit worker action (and a stolen-SIM login must not cancel a legitimate deletion). |
| (b) | Payer visibility during grace | **Freeze all payer surfaces** — pending-deletion workers are excluded from the reach pool, new unlock/disclosure requests are denied with the existing byte-identical neutral body (no oracle), and re-engagement sends are suppressed. Don't surface or sell someone who is leaving. |
| (c) | Grace duration | **7 days**, config-driven: `ACCOUNT_DELETION_GRACE_DAYS` (default 7). Matches the shipped copy. |

## Answering D2's soft-delete rejection head-on

D2 rejected soft-delete because *"a `status='deleted'` row would retain encrypted phone +
name and fail the erasure intent."* That rationale stands — and this design does **not**
reintroduce what it rejected:

- This is a **scheduled hard-delete**, not a soft-delete end-state. During grace the row is
  simply a **live worker row** (the worker may cancel and continue); after grace the SAME
  D2/D3/D4 hard-delete cascade removes every byte of PII. Erasure intent is fully honored —
  its **timing** moves from "instant" to "as disclosed to the worker" (DPDP requires erasure
  within a reasonable period, not instantaneously; a short, disclosed, worker-cancellable
  window is squarely reasonable and worker-protective).
- D1's rationale ("deletion is irreversible, so it gets the strongest gate") shifts but the
  gate **stays**: scheduling still requires the step-up OTP (it starts a countdown to an
  irreversible act), while **cancel** — a purely recoverable action — needs only the
  authenticated session.

## Design

### Schema (migration 0044, expand-only)
- `workers.deletion_scheduled_at timestamptz` **NULL** (NULL = active; set = pending). No
  change to `status` / `WORKER_STATUSES` — one column is the single source of truth; no
  second state machine.
- Partial index `workers_deletion_due_idx ON workers (deletion_scheduled_at) WHERE
  deletion_scheduled_at IS NOT NULL` for the sweep.
- Backward-compatible; rollback = drop column + index (safe: feature-gated readers only).

### Config (`packages/config` server schema)
- `ACCOUNT_DELETION_GRACE_DAYS: z.coerce.number().int().positive().default(7)` (days-unit
  precedent: `SESSION_TTL_DAYS`).
- `ACCOUNT_DELETION_SWEEP_INTERVAL_HOURS: z.coerce.number().positive().default(1)` (cadence
  precedent: `PACE_WAVE_INTERVAL_HOURS`).
- `ACCOUNT_DELETION_COOLDOWN_SECONDS` (post-erasure re-registration cool-down) is **untouched
  and unrelated** — grace runs *before* erasure, cool-down *after*. (Recon found the cool-down
  tombstone is currently written but never read — tracked as TD80, not fixed here.)

### Events (`packages/event-schema`, count 105 → 107)
- `worker.deletion_scheduled` v1 `.strict()`: `{ worker_id: uuid, scheduled_for: ISO-8601 }`.
- `worker.deletion_cancelled` v1 `.strict()`: `{ worker_id: uuid }`.
- Both PII-free (opaque id + timestamp only — never phone/phone_hash/name). First
  `*_scheduled`/`*_cancelled` pair in the registry (paired-verb precedent:
  `job_posting.paused`/`resumed`). `worker.account_deleted` v1 is **not mutated** (§2.8).

### Sweep (BullMQ — already fully wired in apps/api; DB marker authoritative)
- Dedicated `ACCOUNT_DELETION_QUEUE` + in-process processor (idiom: the five live queues).
  Hourly repeatable/self-rescheduling job (PACE `scheduleNextWave` delayed-job precedent).
- Each run: select due ids via the partial index → per worker, **atomically re-check** the row
  is still due (guards the cancel-vs-sweep race) → `execute(workerId)` one at a time,
  best-effort (a per-worker failure logs and continues; `execute` is idempotent and no-ops on
  already-gone workers). A lost Redis job is harmless — the DB marker is authoritative and the
  next sweep catches it. Residual race (cancel landing between the re-check and `revokeAll`)
  is a milliseconds window after a 7-day grace — accepted and documented.
- **Correction (security review, 2026-07-17):** "a lost job is harmless, the next sweep catches
  it" holds for a lost **job** but NOT for a failed **registration** — there is then no next
  sweep, so overdue rows accumulate unerased with nothing reporting it (a silent DPDP-erasure
  stop; a non-outage cause like a Redis ACL or a bullmq API mismatch fails identically on every
  healthy boot). The registration is therefore (a) **retried** on a bounded backoff (1 attempt +
  4 retries, ~80s — sized for the transient cause; unbounded retries would only hide the
  permanent ones) and (b) **surfaced** as `checks.deletion_sweep` on `GET /health`, which does a
  live lookup of the scheduler in Redis (not a process-local flag, so it also catches an
  out-of-band flush and stays true across replicas). It is reported but does NOT gate the
  200/503: a dead clock delays erasure without breaking a request path, and 503-ing would fail
  the CD health-gate + staging smoke — turning a delayed erasure into an outage. Both paths are
  fail-safe: never throws out of boot, never touches the marker. Alert threshold +
  triage: [observability-runbook.md](../observability-runbook.md) §7.

### Auth during grace
- Login/refresh **work unchanged** (the row is live). The OTP-verify login response gains an
  optional PII-free `deletion_scheduled_for` field so the app can show the pending banner
  (the Flutter `OtpVerifyResult` parser must read it explicitly — it drops unknown fields).
- Confirm no longer wipes the session: the worker keeps using the app so they *can* cancel.
- **Correction (security review, 2026-07-17) — the login response is NOT sufficient.** Only the
  OTP-verify path returns `deletion_scheduled_for`; PIN-unlock and refresh re-bridge a session
  without it, and persistent auth defaults ON, so the NORMAL cold start (bootstrap → locked →
  unlockWithPin → authenticated) left the app with no pending state — no banner, no cancel
  action, for the rest of the grace. That unhonors the shipped "kabhi bhi cancel kar sakte
  hain" copy and ruling (a)'s persistent banner (the exact defect class this ADR exists to
  fix). **`GET /auth/me` therefore also returns the optional PII-free `deletion_scheduled_for`**
  (ISO-8601, present ONLY while pending, omitted otherwise — absent ⇔ nothing pending, never
  `null`), read via an explicit projection (`WorkersRepository.findSelfView` — never SELECT *).
  `/auth/me` is the single seam every entry path can reach, and being a re-read it also stays
  correct when the state changes mid-session or on another device. `PinVerifyResponse` is
  deliberately **not** widened: /auth/me closes the gap for every path, the PIN path does not
  otherwise load the `workers` row (adding the field would add a query to the unlock hot path),
  and a snapshot on a strict no-oracle 401 surface is the wrong place to disclose it.

### Payer-surface freeze (ruling (b) — seams verified by recon)
- **Reach pool** ([reach.repository.ts](../../apps/api/src/reach/reach.repository.ts)
  `listSignalRows`): exclude pending-deletion workers via a JOIN to `workers` (the pool reads
  `worker_profiles`). **Doctrinal note:** D8 "sort-never-block" bars *relevance* filtering;
  this is an *eligibility* (membership) exclusion — same class as a deleted worker, documented
  at the query. Side effect (intended): PACE supply counts stop counting leavers.
- **Unlock + disclosure** ([unlocks.service.ts](../../apps/api/src/unlocks/unlocks.service.ts),
  [resume-disclosure.service.ts](../../apps/api/src/disclosures/resume-disclosure.service.ts)):
  deny new requests for pending-deletion workers with the **existing** `neutralUnavailable()`
  no-oracle body, mirroring the Phase-5 "worker gone" (SET-NULL) guards already in reveal
  (pre-lock + in-tx + TOCTOU re-read).
- **Re-engagement** ([reengagement.service.ts](../../apps/api/src/messaging/reengagement.service.ts)):
  suppress sends to pending-deletion workers (single per-send gate — there is no batch
  selector), with the existing `messaging.suppressed` reason mechanism.

### Worker app
- Confirm success → **`scheduled` state** ("Account 7 din mein delete hoga — <date>"), creds
  **not** wiped; settings shows a persistent pending banner + "Delete cancel karein".
- Post-login (grace, per ruling (a)): banner + explicit cancel prompt in the OTP-verify
  success seam; never auto-cancel.
- `AccountDeleteCubit`: `scheduled` status carrying `scheduled_for`, `cancelDelete()`; keep
  the fail-closed mapping (401 = bad OTP, 429 = rate-limit).

## Security & privacy invariants
- No raw PII in the two new events, the new column, the login-response field, or logs —
  opaque `worker_id` + timestamps only.
- Worker id from the token on every route (never body/param — no IDOR on cancel).
- Step-up OTP still gates **scheduling**; OTP verification stays fail-closed (bad OTP ⇒
  nothing scheduled). Known pre-existing gap (unchanged here, severity *reduced* by grace):
  login and deletion OTPs share one Redis code slot with no purpose-binding.
- **Mandatory gate:** `bb-security-review` (security-engineer) before merge, which must
  confirm this ADR is **Accepted** (signed) first.

> **Numbering note (2026-07-17, at build/rebase time):** this ADR was drafted against
> `main` at #218. By the time the build landed, upstream had claimed migration `0038`
> and the event registry had grown, so the numbers above are the RECONCILED ones —
> migration **0044** (was 0038), event count **105 → 107** (was 100 → 102), and the
> cool-down-tombstone debt row is **TD80** (TD64 was taken by the interview-kit row).
> The design is unchanged; only the identifiers moved.

## Consequences
- [worker-account-deletion-runbook.md](../worker-account-deletion-runbook.md) must be
  rewritten (its "confirm → 204 → done, no undo, no operator action" flow is obsolete;
  verification/partial-failure/rollback sections all assume immediate erasure).
- Registers: append the grace model to **R25**; new TD row for the never-read
  `deleted_phone` cool-down tombstone; decisions-log rows for ADR-0031 **and** the missing
  ADR-0026 entry (the log currently skips 0023-0029).
- Event-count test 105 → 107 (+ title enumeration). Existing deletion tests change meaning:
  confirm now **schedules** (asserts no `hardDelete` call, event emitted); new tests for
  cancel, sweep (erases only overdue; never a cancelled row; idempotent), login-while-pending.
- CLAUDE.md §3 said "BullMQ (deferred wiring)" when this was drafted; upstream has since
  corrected it to "live — extraction/transcription/deletion sweeps queued", which already
  anticipates this ADR's sweep. No CLAUDE.md change is owed here.

## Sign-off

| Who | Role | Decision | Date |
|-----|------|----------|------|
| Prakash | TL | **Approved** ("7-day scheduled hard-delete; cancel allowed during 7 days; payer/job surfaces frozen during grace; actual hard-delete after 7 days") — ruling relayed 2026-07-14; **CONFIRMED first-hand 2026-07-17** on the build PR (#400), closing the bb-security-review's relayed-approval condition. | 2026-07-14 (confirmed 2026-07-17) |
| Akshit | CEO | — (TL approval sufficient per §7 routing for this change) | |
