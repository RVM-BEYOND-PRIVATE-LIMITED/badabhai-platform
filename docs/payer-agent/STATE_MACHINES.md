# State Machines & Lifecycle Enforcement

**Status:** COMPLETE (audited 2026-08-11, dimension re-run after the usage-limit interruption).
**Method:** evidence-based static analysis; every claim carries a `file:line` citation.
**Findings feed** `GAP_REGISTER.md`. Coverage caveats: `AUDIT_STATUS.md`.

---

# State Machines / Lifecycle Enforcement (payer + agency domain)

## Executive summary
I opened every status column in the payer/agency domain (packages/db/src/schema/{payer,job,referral,match}.ts) and traced each one to its writer(s) in apps/api/src. 25 entities carry lifecycle state; 22 have at least one status/lifecycle enum and 3 (credit_ledger, agency_payout_accruals, job_reach) are stateless ledgers/caches whose "state" is a nullable FK or the row's existence. Of the 22, 11 are fully enforced (every illegal transition is rejected by a guarded single-statement UPDATE with the from-state in the WHERE, so there is no read-then-write TOCTOU), 7 are partially enforced (a legal-looking transition is guarded but a declared state is unreachable, or the guard sits in TypeScript rather than in the WHERE), and 4 have a declared state that NO code path can ever write. The transition discipline in this codebase is genuinely good: `job_postings`, `payers`, `jobs`, `payer_members`, `agency_kyc`, `payment_orders` and the unlock spine all put the from-state in the UPDATE's WHERE clause and treat a zero-row result as an idempotent no-op, and the money paths (`payment_orders`, `credit_ledger`, `agency_payout_accruals`, `referral_clicks`) each carry a real DB uniqueness constraint as their idempotency key rather than an application check. The defects are concentrated in three places. First, `posting_plans.applicants_viewed_count` is NEVER incremented by any production code and `applicant.viewed` is a declared-but-never-emitted event — the applicant-visibility quota is priced, sold, topped up for real ₹, and rendered as "Applicant quota used" in payer-web, but no chokepoint consumes or enforces it (apps/api/src/payer-portal/payer-reach.controller.ts:29-30 states this explicitly). Second, the Matching-V1 apply path gates only on the existence of a `job_reach` row and never reads `job_postings.status`, while the feed filters `jp.status = 'open'` — so a worker holding a posting id can apply to a paused, closed or SUSPENDED posting by calling the API directly, which defeats the entire stated purpose of the ADR-0037 suspension cascade. Third, two purchase paths (`buyBoost`, `buyPlan`) are read-then-write with no transaction, no lock and no unique constraint, so a double-submit double-creates a paid entitlement. Beyond that, `agency_payout_requests` can only ever reach `requested` — there is no `paid`/`rejected` writer anywhere in the repo and `agency_payout.paid` is declared but never emitted, so the mock supply-money loop has no terminal state. The `expired` value is dead on four tables (unlocks, posting_plans, posting_boosts, resume_disclosures): expiry is expressed purely as a timestamp predicate at read time, which is behaviourally correct but means the enum lies and no `*.expired` event ever reaches the spine. Cross-checking packages/event-schema/src/registry.ts against every `event_name:` literal in non-test code yields four genuinely never-emitted payer/agency declarations (applicant.viewed, agency_payout.paid, job.available, profile.viewed) and zero emitted-but-undeclared names (the registry is type-enforced through `PayloadInputOf`, so an undeclared emit cannot compile).

## Scope and method

Every `status`-bearing table in `packages/db/src/schema/{payer,job,referral,match}.ts` was enumerated from the schema, then each state value was grepped for its writer across `apps/api/src` (excluding `*.test.ts`). "Enforced" below means the from-state appears **in the SQL WHERE clause** of the transition statement, so a wrong-state row matches zero rows and the service maps that to a 409 — no read-then-write window. "TS-only" means the guard is an `if` in the service between a read and an unguarded write.

Verified entity list against the schema: `payers`, `payer_orgs`, `payer_members`, `job_postings` (+ `verification_status`), `jobs`, `posting_plans`, `posting_boosts`, `unlocks`, `payer_credits`, `credit_ledger`, `payment_orders`, `resume_disclosures`, `payer_capacity`, `pricing_catalog`, `agency_kyc`, `agency_payout_requests`, `agency_payout_accruals`, `agency_invites`, `invites`, `referral_links`, `referral_clicks`, `referral_bonus_accruals`, `applications`, `job_reach`, `payer_job_posting_chat_sessions`. Two additions found beyond the brief: `payer_job_posting_chat_sessions` (ADR-0035, four-state lifecycle) and `job_postings.verification_status` (a second, orthogonal machine on the same row).

---

## 1. `payers` — pending | active | suspended

| | |
|---|---|
| **States** | `PayerStatus` TS union, `packages/db/src/schema/payer.ts:45,61`. **No DB CHECK** (unlike `payer_orgs`) |
| **Transitions** | `pending → active` (first OTP verify) · `{pending,active} → suspended` (admin) · `suspended → previous_status ?? pending` (admin reinstate) |
| **Who** | activate: system-on-verify · suspend/reinstate: admin (`AdminAuthGuard`/`AdminRolesGuard`) |
| **Enforced** | **In the DB WHERE, all three.** activate: `apps/api/src/payers/payers.repository.ts:152-157` (`eq(payers.status,"pending")`) · suspend: `apps/api/src/admin/admin-actions.repository.ts:84-98` (`inArray(["pending","active"])`, deliberately not `ne('suspended')` because there is no CHECK) · reinstate: `admin-actions.repository.ts:113-127` (`eq(status,"suspended")`, restores `coalesce(previous_status,'pending')`) |
| **Concurrency** | Single-statement compare-and-set; the service treats `undefined` as a concurrent-writer conflict → 409 (`admin-actions.service.ts:101-127`) |
| **Events** | `payer.activated` only on the real transition (`payer-auth.service.ts:167-177`); `payer.suspended`/`payer.reinstated` + `admin.action_performed` + `payer.inventory_{suspended,reinstated}`, **all inside one transaction** (`admin-actions.service.ts:102-127, 141-167`) |
| **FE can drive illegal?** | No. `PayerAuthGuard` re-reads `{role,status}` per request and 403s anything but `active` (`apps/api/src/payers/payer-auth.guard.ts:106-118`) |

The `previous_status` column plus `coalesce(...,'pending')` closes the backdoor-activation hole (suspend a `pending` payer, reinstate, land `active` without OTP). This is the strongest machine in the domain.

## 2. `payer_orgs` — active | suspended

| | |
|---|---|
| **States** | `payer.ts:94,106` + **DB CHECK** `payer_orgs_status_chk` (`payer.ts:113`) |
| **Transitions** | `active` on create only. **`suspended` is written NOWHERE** |
| **Enforced** | N/A — no transition exists |
| **Read?** | No. `PayerOrgsRepository.resolveOrgForPayer` filters on `payer_members.status='active'`, never on `payer_orgs.status` (`apps/api/src/payers/payer-orgs.repository.ts:93-101`) |
| **Events** | none |

**Dead state.** Suspending an org is expressible in the schema and unreachable in code; nothing would honour it if it were set.

## 3. `payer_members` — invited | active | removed

| | |
|---|---|
| **States** | `payer.ts:128,141` + CHECK `payer_members_status_chk` (`payer.ts:159`) |
| **Transitions** | `→ invited` (owner invites; upsert on `(org_id,email_hash)` also revives a `removed` row) · `invited → active` (invitee accepts) · `active → removed` (owner removes, recruiters only) |
| **Who** | invite/remove: `owner` — `@OrgRoles("owner")` + `PayerOrgRoleGuard` on `POST`/`DELETE` (`apps/api/src/payer-portal/payer-org-members.controller.ts:34,45-46,58-59`) · accept: any authenticated payer holding the token (`payer-org-invites.controller.ts:17-23`) |
| **Enforced** | **In the WHERE.** accept: `payer-orgs.repository.ts:225-250` re-checks `id + token_hash + status='invited' + not expired` in one UPDATE and nulls the token (strictly single-use) · remove: `payer-orgs.repository.ts:259-273` re-checks `org_id + org_role='recruiter' + status<>'removed'` |
| **Concurrency** | accept/remove are race-safe. **The seat cap is NOT**: `countActiveOrInvited` then `inviteMember` with no lock and no constraint (`apps/api/src/payer-portal/payer-org-members.service.ts:92-98` → `payer-orgs.repository.ts:131-137,163-193`). N concurrent invites for N distinct emails all read `seats < MAX` and all insert |
| **Events** | `payer_member.invited` / `.accepted` / `.removed`, all PII-free, all emitted |
| **FE illegal?** | No — backend owns the owner-only gate. (payer-web's `/team` is a 404 for every real user because `getOrgRole()` stubs to `recruiter`, but that is a UX P0, not an authz hole) |

## 4. `job_postings` — draft | open | paused | suspended | closed

| | |
|---|---|
| **States** | `@badabhai/types` `JobPostingStatus`; CHECK `job_postings_status_chk` (`packages/db/src/schema/job.ts:179-182`) + CHECK `job_postings_previous_status_chk` (`job.ts:188-191`, forces `previous_status` NULL unless `suspended`) |
| **Transitions** | `→ draft` (create; client status ignored — `job-postings.service.ts:479`) · `draft → open` (PATCH `status:"open"`) · `open ↔ paused` · `{draft,open} → closed` · `{open,paused} → suspended` / `suspended → previous_status` (admin cascade) · `* → closed` (admin force-close) |
| **Who** | ops (`InternalServiceGuard`) and the owning payer (`PayerAuthGuard`, payer_id in every WHERE); admin for suspend/force-close |
| **Enforced** | **In the WHERE for every lifecycle move.** close: `job-postings.repository.ts:157-175` / `closeOwned:240-262` (`eq(status, previousStatus)`) · pause/resume: `transitionOwned:265-283` (`eq(status, fromStatus)`) · cascade: `admin-actions.repository.ts:159-182` (`inArray(["open","paused"])`) / `203-224` (`eq("suspended")`) · force-close: `admin-actions.repository.ts:319-330` (`ne("closed")`, clears `previous_status` — required, the CHECK rejects otherwise) |
| **In TS, not the DB** | `prepareUpdate` rejects edits on `closed` and rejects `→open` from anything but `draft` (`job-postings.service.ts:500-506`); `assertCloseable` rejects `paused`/`suspended`/`closed` (`job-postings.service.ts:674-691`). But the underlying `updateOwned` (`repository.ts:220-234`) has **no status predicate**, so these two are read-then-write. A field edit racing a close can land on a closed row. Low impact (no money), but it is the one place the pattern is broken |
| **Events** | `job_posting.created/updated/closed/paused/resumed/verification_updated` — all emitted via `emitParams` (`job-postings.service.ts:640-655`). `payer.inventory_suspended/reinstated` carry the cascade counts |
| **FE illegal?** | No. postings-manager.tsx:152-185 disables buttons by status, and the backend 409s independently (`postings/actions.ts:36-115` collapses 409 to a retryable message) |

### 4b. `job_postings.verification_status` — unverified | verified | rejected

CHECK at `job.ts:192-195`. Written only by ops `verify`/`reject` (`job-postings.service.ts:188-229`), idempotent (returns early if unchanged), emits `job_posting.verification_updated`. **No transition constraint at all** — `rejected → verified → rejected` is freely allowed, and it is written through the generic `repo.update` with no from-state in the WHERE. Orthogonal to `status` by design.

## 5. `jobs` (agency demand) — open | closed | suspended

| | |
|---|---|
| **States** | `job.ts:268`. **No DB CHECK** on `jobs.status` |
| **Transitions** | `→ open` (agency creates, `agency.service.ts:183`) · `open → closed` · `open → suspended` / `suspended → open` (cascade) |
| **Enforced** | close: `agency-jobs.repository.ts:143` `closeOwnedIfOpen` (`payer_id + status='open'` in the WHERE) ✅ · cascade: `admin-actions.repository.ts:175-181, 217-222` (`eq(status,'open')` / `eq(status,'suspended')`) ✅ |
| **Gaps** | **`pauseJob` IS `closeJob`** — `agency.service.ts` pause calls the same `closeOwnedIfOpen` and only differs in which event it emits (documented at the `pauseJob` docblock). The payer-web "Pause" affordance therefore drives an **irreversible terminal close**; there is no reopen path anywhere. **`updateJob` blocks only `closed`** (`agency.service.ts:227-230`) — a `suspended` job is editable if the payer is somehow active while a job is still frozen (possible only if the reinstate cascade partially failed; the cascade is transactional so this is narrow) |
| **Events** | `job.created` / `job.updated` / `job.closed` all emitted. `job.available` is **declared and never emitted** (TD64, explicitly deferred at `agency.service.ts:195-197`) |

## 6. `posting_plans` — draft | active | expired | paused

| | |
|---|---|
| **States** | `payer.ts:389` + CHECK `posting_plans_status_chk` (`payer.ts:465`) |
| **Transitions written** | insert as `active` **or** `paused` (the capacity decision, `posting-plans.service.ts:208-221`) · `paused → active` (auto-resume on capacity purchase, `service.ts:463-475` → `repository.ts:138-143`) |
| **Never written** | `draft` (the column default, but every insert supplies an explicit status) and **`expired`** — no sweeper, no cron, nothing |
| **Enforced** | The capacity chokepoint is genuinely atomic: `withTransaction` + `lockPayer` (per-payer `pg_advisory_xact_lock`) wraps `countActivePlansForPayer` → `insertPlan` (`posting-plans.service.ts:195-241`). Reads inside the lock use `tx`, never a second pool connection (documented deadlock discipline). Auto-resume runs under the same lock (`service.ts:445-481`) |
| **Not enforced** | `setPlanStatus` (`repository.ts:138-143`) has **no from-state in the WHERE** — safe only because its single caller already holds the advisory lock and pre-filtered `status='paused'` |
| **Concurrency hole** | **There is no uniqueness or idempotency on (job_posting_id) for plans.** `buyPlan` never checks whether the posting already has an active plan. A double-submitted `POST /payer/job-postings/:id/plan` creates two paid plan rows on one posting, each consuming a capacity slot. `findActivePlanForPostingAndPayer` even documents the case ("if a posting somehow carries more than one active plan", `repository.ts:222-227`) rather than preventing it |
| **Quota** | `applicant_visibility_quota` (immutable receipt) + `quota_topup_count` (accumulates). `addQuotaTopup` IS atomic and re-guards `payer_id + status='active' + not expired` in the WHERE (`repository.ts:257-279`) — that half is correct. **`applicants_viewed_count` is never incremented by any production code** (see §16) |
| **Events** | `job_posting.purchased`, `posting_plan.paused` (only when enforcement is ON — shadow mode logs instead of emitting, `service.ts:228-239`, honest), `posting_plan.resumed`, `posting_plan.quota_topped`, `payment.authorized/captured`. **No event when a plan lapses** — the payer's paid entitlement silently stops serving with nothing on the spine |

## 7. `posting_boosts` — active | expired

| | |
|---|---|
| **States** | `payer.ts:398` + CHECK (`payer.ts:496`) |
| **Transitions** | insert as `active` only. **`expired` is never written** |
| **Guard** | "no overlapping active boost" (B-R3) is **TS-only**: `findActiveBoost` read (`posting-plans.service.ts:287`) then `insertBoost` (`service.ts:309`) — **no transaction, no advisory lock, no unique index**. `insertBoost` is a bare INSERT (`repository.ts:168-173`) |
| **Race** | Two concurrent `POST /payer/job-postings/:id/boost` both read "no active boost", both insert a receipt, and both call `extendPostingBoostWindow` — which is `GREATEST(now(), boosted_until) + N days` (`repository.ts:192-203`), so the window is extended **twice**. Two receipts, two `job_posting.boosted` events, two `payment.captured` events, double the boost days |
| **Events** | `job_posting.boosted`, `job_posting.boost_refused` (supply floor), `payment.*`, `coupon.redeemed` — all emitted. `payment.authorized` is emitted **before** the insert (`service.ts:308`) but after the supply gate (deliberate, `service.ts:302-304`) |

## 8. `unlocks` — requested | granted | revealed | expired | denied

| | |
|---|---|
| **States** | `payer.ts:188` (+ `deny_reason` CHECK at `payer.ts:260`, NULL unless denied). No status CHECK |
| **Transitions** | `→ granted` (upsert on `(payer_id, worker_id)`, `unlocks.repository.ts:183-222`) · `→ denied` (upsert with a `CASE` that **refuses to downgrade a live grant**, `repository.ts:229-262`) · `granted → revealed` + `reveal_count+1` (`repository.ts:265-278`). **`expired` is never written** — expiry is a timestamp predicate at read time (`unlocks.service.ts:194,390-395`) |
| **Enforced** | This is the model implementation. One transaction per grant/reveal, per-worker `pg_advisory_xact_lock` (`repository.ts:103-106`), `SELECT ... FOR UPDATE` on the unlock row (`repository.ts:139-147`), atomic conditional debit `WHERE balance >= amount` (`repository.ts:368-375`) plus the DB CHECK `balance >= 0`. Cap check and grant write are in the same locked tx (F-2/F-6). Events are collected as deferred thunks and fired **post-commit** to avoid a pool-vs-lock deadlock (`unlocks.service.ts:59-99, 460-472`) |
| **Ownership** | Reveal binds to the session payer and returns the byte-identical neutral body for a foreign unlock (`unlocks.service.ts:332-334`) — no cross-tenant oracle |
| **Events** | `unlock.requested/granted/denied/cap_exceeded`, `contact.revealed`, `payment.authorized/captured/failed`, `payer.credits_exhausted`. `unlock.granted` and `payer.credits_exhausted` carry idempotency keys. No `unlock.expired` event exists (consistent with the dead state) |
| **Trade-off recorded in code** | Post-commit emission means an emit failure cannot roll back committed state; logged and continued (`unlocks.service.ts:94-98`). Accepted and documented |

## 9. `payer_credits` + `credit_ledger` (balance / append-only ledger)

| | |
|---|---|
| **State** | No status column. `balance >= 0` CHECK (`payer.ts:280`); ledger is append-only |
| **Debit** | `tryDebit` — one statement, `WHERE payer_id AND balance >= amount`, returning the new balance (`unlocks.repository.ts:368-375`). Ledger append in the **same tx** as the grant (`unlocks.service.ts:265-270`). Cannot drift, cannot go negative |
| **Credit** | `creditPackWithinTx` upserts the balance and inserts the ledger row in one tx (`unlocks.repository.ts:439-471`). Admin grants dedupe on `credit_ledger_idempotency_key_uq` and **only move the balance when a new ledger row was actually inserted** (`admin-actions.repository.ts:244-290`) — the strongest exactly-once pattern in the repo |
| **Hole** | `POST /payer/credits` (`apps/api/src/payer-portal/payer-unlocks.controller.ts:129-139` → `unlocks.service.ts:515-538` → `payment-gateway.ts:166+ purchasePackMock`) grants a full credit pack with **no money and no flag gate**. It is behind `PayerAuthGuard` only. It is not disabled when `PAYMENTS_ENABLE_REAL=true` — the mock path and the real path coexist, so flipping the payments flag does not close it |

## 10. `payment_orders` — created | paid | failed

| | |
|---|---|
| **States** | `payer.ts:597,626` + CHECK `payment_orders_status_chk` (`payer.ts:651`) |
| **Transitions** | `→ created` (order intent) · `created → paid` · `{created} → failed` |
| **Idempotency key** | `uniqueIndex("payment_orders_provider_order_uq").on(provider, provider_order_id)` — **a DB constraint, not an application check** (`payer.ts:632-640`) |
| **Webhook idempotent by order id?** | **Yes, provably.** `claimPaymentOrderPaidWithinTx` is a compare-and-set: `UPDATE ... SET status='paid' WHERE provider=$ AND provider_order_id=$ AND status <> 'paid' RETURNING *` (`unlocks.repository.ts:548-569`). Under READ COMMITTED the loser re-evaluates the WHERE against the winner's committed row and updates 0 rows. The credit grant runs in the **same transaction** as the claim (`payment-gateway.ts:285-291`), so "claimed" and "granted" commit together. The browser-verify fallback and the webhook converge on this one path (`unlocks.service.ts:721-738`) |
| **Late failure delivery** | `markPaymentOrderFailed` carries `ne(status,"paid")` (`unlocks.repository.ts:577-593`) so an out-of-order `payment.failed` cannot walk back a settled capture |
| **Events** | `payment.authorized` keyed on the order row, `payment.captured` keyed on the order row and emitted **only by the caller that actually granted** (`unlocks.service.ts:721-738`), `payment.failed` keyed on the order, plus `payer.suspended_payment_captured` (fail-open alert, `service.ts:761-793`) |
| **Terminal** | `paid` is terminal (no refund path exists anywhere — stated at `unlocks.service.ts:741-749`) |

## 11. `resume_disclosures` — requested | granted | disclosed | denied | expired

| | |
|---|---|
| **States** | `payer.ts:400` + `deny_reason` CHECK (`payer.ts:541-544`) |
| **Transitions written** | `→ granted` / `→ denied` inside the locked tx (`resume-disclosure.service.ts:154-158, 307-320`) · `granted → disclosed` post-render (`service.ts:259`) · `disclosed → granted` on a re-request after expiry (the `updateStatus` at `service.ts:156`). **`requested` (the column default) and `expired` are never written** |
| **Enforced** | Same spine as unlocks: per-worker advisory lock **on the same key**, so the daily/weekly cap is a single budget shared with unlock reveals (`service.ts:102-131, 293-305`). Re-use of a live disclosure short-circuits before any second grant or second event (`service.ts:139-152`) |
| **Ownership** | payer-scoped; unknown/no-consent/capped/no-resume all return the byte-identical neutral body |
| **Events** | `resume.disclosed`, keyed on the disclosure id, emitted only on a real render (`service.ts:262-278`). **No event for `denied`** — the deny row is written but nothing reaches the spine (unlike `unlock.denied`, which does exist). Asymmetry between the two otherwise-mirrored chokepoints |

## 12. `agency_kyc` — pending | verified | rejected

| | |
|---|---|
| **States** | `referral.ts:184,200` + `reject_reason` CHECK (`referral.ts:212`) |
| **Transitions** | `→ pending` (agency submit/resubmit — upsert forces `pending`, `agency-kyc.repository.ts:44,54`) · `pending → verified` · `pending → rejected` |
| **Enforced** | **In the WHERE.** `markVerified` / `markRejected` both carry `eq(status,"pending")` and return the transition timestamp only when a row moved (`agency-kyc.repository.ts:92-114`). Double-verify is a no-op |
| **Re-KYC** | `verified → pending` via resubmit is allowed by the upsert. This is a privilege **downgrade**, so it is safe, but it means a verified agency can silently lose the payout gate |
| **Who** | submit: the agency (`PayerAuthGuard` + `PayerRoleGuard` + `@PayerRoles("agent")`, `agency-payouts.controller.ts:20-22,30`) · verify/reject: ops (`InternalServiceGuard`, `agency-kyc-ops.controller.ts:21-22,33,40`) |
| **Events** | `agency_kyc.submitted`/`.verified`/`.rejected` all emitted, keyed per decision so a re-decision after a resubmit is not deduped off the spine |

## 13. `agency_payout_requests` — requested | paid | rejected

| | |
|---|---|
| **States** | `referral.ts:225,235`. **No status CHECK** |
| **Transitions written** | `→ requested` only (`agency-payout.repository.ts:175`). **`paid` and `rejected` have NO writer anywhere in the repo** — grep for a settle/reject endpoint across `apps/api/src/admin` and `apps/web` returns nothing |
| **Gate** | `requestPayout` requires `AGENCY_PAYOUTS_ENABLED` (defence-in-depth after `AgencyPayoutsEnabledGuard`), `kyc='verified'`, and `requestable >= threshold` (`agency-payout.service.ts:136-177`) |
| **Claim atomicity** | Correct: one transaction inserts the request then `UPDATE agency_payout_accruals SET payout_request_id = $ WHERE agency_payer_id = $ AND payout_request_id IS NULL RETURNING amount` — two concurrent requests claim disjoint sets, and a below-threshold claim throws `PayoutBelowThresholdError` to roll the whole thing back (`agency-payout.repository.ts:162-209`) |
| **TOCTOU** | The KYC status is read **outside** the claim transaction (`service.ts:142` vs `repository.ts:168`) and is stamped into `kyc_snapshot_status` from that stale read. A KYC rejection landing in between produces a `requested` payout whose snapshot says `verified` |
| **Events** | `agency_payout.accrued` (keyed on `source_unlock_id`), `.requested` (keyed on the request id), `.blocked`. **`agency_payout.paid` is declared in the registry and never emitted** — consistent with the missing transition |
| **Accruals** | `agency_payout_accruals` is idempotent by `uniqueIndex(source_unlock_id)` with `ON CONFLICT DO NOTHING ... RETURNING`, so the accrued event fires exactly once per accrual (`agency-payout.repository.ts:88-105`, constraint at `referral.ts:287`) |

## 14. `invites` / `agency_invites` — created | clicked | accepted

| | |
|---|---|
| **States** | `referral.ts:41` (shared union, aliased at `referral.ts:101`) |
| **`→ clicked`** | **TS-only guard.** Service reads the row, checks `status === "created"`, then calls an **unguarded** UPDATE: `invite.repository.ts:29-34` (`markClicked`, WHERE is `id` alone) and `agency-invites.repository.ts:70-75` (`setStatus`, WHERE is `id` alone). Callers: `invite.service.ts:61-70`, `agency.service.ts:628-650`. An accept landing between the read and the write **regresses `accepted → clicked`**. `invited_worker_id` survives, so attribution is not lost, but the funnel status lies |
| **`→ accepted`** | **Enforced in the WHERE**: `isNull(invited_worker_id)` in both (`invite.repository.ts:36-43`, `agency-invites.repository.ts:82-93`). Single-winner, and the agency side stamps `attributed_at` (the 90-day payout anchor) in the same statement |
| **Consent gate** | Enforced above both seams in `ReferralAttributionService.attribute` (`referral-attribution.service.ts:74-78`); the agency seam re-checks (`agency.service.ts:683-690`), the worker seam does not — hence the shared gate |
| **Events** | `invite.created/clicked/accepted`, `agency_invite.created/clicked/accepted`, `invite.install`. Clicks are **deliberately unkeyed** (repeatable behavioural fact); accepts are keyed |

## 15. `referral_links` / `referral_clicks` / `referral_bonus_accruals`

| | |
|---|---|
| **State** | No status enums. `referral_clicks` has a claim pair with CHECK `(claimed_by_worker_id IS NULL) = (claimed_at IS NULL)` (`referral.ts:507-510`) |
| **First-touch claim** | **Both halves present**: `pg_advisory_xact_lock` on the worker inside the claim transaction + the partial unique index `referral_clicks_claimed_worker_uq` (`referral.ts:496-498`, code at `referral-link.repository.ts:81-141`). The schema comment correctly notes the index is the half that actually holds |
| **Bonus fraud rule** | `uniqueIndex(invited_worker_id)` — one bonus per referred worker **ever**, regardless of claimant (`referral.ts:329`) |
| **Events** | `referral.link_created/link_clicked/install_claimed/bonus_accrued` all emitted |

## 16. `applications` — applied | skipped (+ the V1 rank snapshot)

| | |
|---|---|
| **States** | `ApplicationAction` (`job.ts:283`); `reason` CHECK only on skip (`job.ts:473`); `applications_job_ref_chk` requires exactly one job reference (`job.ts:508-511`) |
| **Transitions** | Upsert, last-write-wins on `(worker_id, job_id)` / partial unique on `(worker_id, job_posting_id)` (`job.ts:467, 478-480`). `applied → skipped` is **blocked in TS** (`applications.service.ts:203-206`); `skipped → applied` is allowed |
| **Legacy path gate** | `findJobById` carries `eq(jobs.status,"open")` in the WHERE (`applications.repository.ts:157-164`) — a closed/suspended job cannot be applied to ✅ |
| **V1 path gate — BROKEN** | `applyV1` gates **only** on the existence of a `job_reach` row: `buildSnapshot` → `findReachRow` (raw SQL, `worker-skills.repository.ts:381-398`, **no status predicate**) and `findPostingSkillSets` (`worker-skills.repository.ts:345-367`, **no status predicate**). Meanwhile the feed filters `AND jp.status = 'open'` (`match-feed.repository.ts:143`). `job_reach` is explicitly **not** cleared on pause (`job-postings.service.ts:344-350`) and is not cleared on close or on the suspension cascade. Net: a worker holding a posting id can apply to a `paused`, `closed` or `suspended` posting by calling the API directly |
| **Counter** | `incrementApplicantsReceived` is a single in-SQL `+1` (race-safe) gated on insert-or-flip (`applications.service.ts:165-171`, repo at `applications.repository.ts:227-238`) |
| **Silent state change** | `application.submitted` is keyed `application.submitted:{worker}:{job}` (`applications.service.ts:184`), and `EventsRepository.insert` dedupes on `events.idempotency_key` with `onConflictDoNothing` (`events.repository.ts:42-43`). A `skipped → applied` flip is a genuine state change **and** bumps `applicants_received`, yet the second `application.submitted` is silently dropped. Event-First gap |

## 17. `posting_plans.applicants_viewed_count` — the quota that is sold but never consumed

This is the largest single finding, so it gets its own section.

- Column exists with the comment "Atomic check-and-increment at the single view chokepoint" (`packages/db/src/schema/payer.ts:454`) and a non-negative CHECK (`payer.ts:466`).
- **grep across `apps/api/src` + `packages` for `applicantsViewedCount` returns exactly three non-test hits, all READS**: `posting-plans.service.ts:127,133,172`. There is **no writer**.
- The only applicant-list route for a payer is `GET /payer/reach/jobs/:jobId/applicants`, whose own docblock states: *"Reach is INFORMATION-ONLY — no quota consumption, no credit debit, no payment"* (`apps/api/src/payer-portal/payer-reach.controller.ts:29-30`). Neither branch (legacy `ReachService.applicantsForOwnedJob`, `reach.service.ts:103-142`; V1 `MatchCandidatesService.listForPosting`) touches the plan.
- `applicant.viewed` is declared in `packages/event-schema/src/registry.ts` and emitted nowhere.
- Meanwhile the quota is real money: `buyPlan` stamps `applicantVisibilityQuota` from the catalog (`posting-plans.service.ts:215`) and `topUpQuotaForPayer` sells more views through the pricing engine with `payment.authorized`/`payment.captured` events (`posting-plans.service.ts:365-420`), and payer-web renders "Applicant quota used" tiles (`apps/payer-web/src/app/(portal)/plans/page.tsx:81,131-147`; `capacity/page.tsx:90-97`) and a "Top-up applied — added N applicant views" notice (`postings/actions.ts:87`).

The payer pays for a cap that is never checked and a counter that is permanently 0.

## 18. `payer_job_posting_chat_sessions` — active | draft_ready | published | abandoned

CHECK at `payer.ts:724-727`. Written: `active` on create (`job-posting-chat.repository.ts:42`), `draft_ready` when the AI says so (`job-posting-chat.service.ts:234`), `published` on publish (`repository.ts:177`). **`abandoned` is never written** — grep for `abandoned` in non-test API code returns only unrelated occupation-service usages. Dead state; abandoned sessions stay `active`/`draft_ready` forever and are re-offered by the "continue where I left off" list (`postings/ai/new/page.tsx:36`).

---

## (a) Transitions enforced ONLY by the frontend hiding a button

| # | Transition | How the FE hides it | How the backend accepts it |
|---|---|---|---|
| **a1** | **Apply to a non-open posting (V1)** | The feed query filters `AND jp.status = 'open'` (`match-feed.repository.ts:143`), so a paused/closed/suspended posting never renders a card | `applyV1` → `buildSnapshot` → `findReachRow` (`worker-skills.repository.ts:381-398`) + `findPostingSkillSets` (`:345-367`), **neither reads `status`**. `job_reach` survives pause (`job-postings.service.ts:344-350`), close and the suspension cascade. `POST /jobs/:postingId/apply` with a known id succeeds. This defeats the entire stated rationale of `suspendPayerInventory` — *"every existing discovery query already filters status='open'"* (`admin-actions.repository.ts:136-144`) — which is true of the READ path and false of the WRITE path |
| **a2** | **Exceeding the applicant-visibility quota** | payer-web shows "Applicant quota used N/M" and offers a top-up (`plans/page.tsx:81-88`) | Nothing enforces M. `applicants_viewed_count` has no writer; `/payer/reach/jobs/:id/applicants` returns the full list unconditionally (`payer-reach.controller.ts:29-30, 63-85`). The only real bound is the hourly scrape cap |
| **a3** | **Second plan on one posting** | `postings-manager.tsx` offers "Buy plan" contextually | `POST /payer/job-postings/:id/plan` has no per-posting uniqueness, no existing-plan check and no idempotency key (`posting-plans.service.ts:177-249`). Two calls = two paid plans on one posting |
| **a4** | **Overlapping boost** | UI offers one boost | The B-R3 rule is a TS `if` between an unlocked read and a bare INSERT (`posting-plans.service.ts:287-289` → `repository.ts:168-173`) |
| **a5** | **Reopening a "paused" agency job** | The agency UI labels the action "Pause" | The backend implements pause as `closeOwnedIfOpen` (terminal `closed`), and no reopen route exists. Here the FE *label* is the lie rather than the gate, but the effect is the same class of defect |

`payer_members` owner-only writes, posting pause/resume/close, and every money transition are **not** in this list — they are genuinely enforced server-side.

## (b) Races that double-spend or double-create

| Path | Protection | Verdict |
|---|---|---|
| **Unlock + credit deduction** | `db.transaction` + `pg_advisory_xact_lock(worker)` + `SELECT ... FOR UPDATE` + conditional `WHERE balance >= 1` + CHECK `balance >= 0` (`unlocks.repository.ts:92-106,139-147,368-375`; `payer.ts:280`) | **SAFE** |
| **Credit top-up + ledger** | Same transaction for balance + ledger (`unlocks.repository.ts:439-471`); admin grants dedupe on `credit_ledger_idempotency_key_uq` and only move the balance when a ledger row was actually inserted (`admin-actions.repository.ts:252-289`; index at `payer.ts:330`) | **SAFE** |
| **Payment webhook + browser verify** | `uniqueIndex(provider, provider_order_id)` (`payer.ts:640`) + compare-and-set `ne(status,'paid')` (`unlocks.repository.ts:548-569`) + grant in the same tx (`payment-gateway.ts:285-291`) | **SAFE — idempotent by order id, as a DB constraint** |
| **Quota top-up** | Single atomic `+delta` UPDATE re-guarding `payer_id + status='active' + not expired` (`posting-plans.repository.ts:257-279`), performed **before** the payment emits | **SAFE** (though it can be repeated N times — that is intended, each is a purchase) |
| **Plan purchase / capacity** | `withTransaction` + `lockPayer` around count-and-write (`posting-plans.service.ts:195-241`) | **Capacity accounting SAFE; plan creation NOT** — no uniqueness on `(job_posting_id)`, so a double-submit double-creates (a3) |
| **Boost purchase** | none | **DOUBLE-CREATE** (a4). No tx, no lock, no unique index |
| **Batch invite creation** | `agency_invites_code_uq` on a `randomUUID`-derived code (`referral.ts:160`) + a per-batch cap (`agency-invites-batch-cap.test.ts` exists) | **SAFE** (collision is the only failure mode and the unique index catches it) |
| **Member invite accept** | One guarded UPDATE re-checking `id + token_hash + status='invited' + not expired`, consuming the token (`payer-orgs.repository.ts:225-250`) | **SAFE** |
| **Member seat cap** | `countActiveOrInvited` → `inviteMember`, no lock, no constraint (`payer-org-members.service.ts:92-98`) | **RACE** — concurrent invites over-provision seats |
| **Payout claim** | `payout_request_id IS NULL` UPDATE inside one tx, rollback below threshold (`agency-payout.repository.ts:162-209`) | **SAFE for the claim**; the KYC gate read is outside the tx (TOCTOU on `kyc_snapshot_status`) |
| **Referral first-touch** | advisory lock + partial unique on `claimed_by_worker_id` (`referral.ts:496-498`) | **SAFE** |
| **Referral bonus** | `uniqueIndex(invited_worker_id)` (`referral.ts:329`) | **SAFE** |

## (c) Silent state changes and registry drift

**Declared in `packages/event-schema/src/registry.ts` and NEVER emitted in production code** (derived by diffing all registry names against every `event_name:` literal in non-`*.test.ts` files under `apps/api/src`):

| Event | Why |
|---|---|
| `applicant.viewed` | The view chokepoint does not exist (§17) |
| `agency_payout.paid` | No `paid` transition exists (§13) |
| `job.available` | Deferred pending a matcher — explicitly commented at `agency.service.ts:195-197` |
| `profile.viewed` | Only referenced by the notification DTO mapping (`notifications.dto.ts:165`) |

(The AI/chat/pin names that appeared in the raw diff are false positives — they are emitted from `apps/ai-service` or via computed literals such as `inbound ? "chat.message_received" : "chat.message_sent"` at `chat.service.ts:691`.)

**Emitted but undeclared: none.** `EventsService.emit` is typed through `PayloadInputOf<N>` over the registry, so an undeclared name cannot compile.

**State changes with no event at all (Event-First violations):**

1. Any `posting_plans` plan lapsing past `expires_at` — the payer's paid entitlement stops serving with nothing on the spine. Same for `posting_boosts`, `unlocks`, `resume_disclosures`.
2. `resume_disclosures → denied` writes a row and emits nothing (contrast `unlock.denied`, which does emit) — `resume-disclosure.service.ts:307-320`.
3. `applications` `skipped → applied` — the row changes and `applicants_received` increments, but the `application.submitted` re-emit is dropped by the permanent idempotency key (`applications.service.ts:184` + `events.repository.ts:42-43`).
4. `job_postings.verification_status` changes are evented, but the ops `update` path that writes them shares the generic `repo.update` with no from-state, so a concurrent double-decision emits twice with contradictory `previous_status`.
5. `posting_plan.paused` is deliberately **not** emitted in shadow mode (`posting-plans.service.ts:231-239`) — this is correct behaviour (no state changed) and is called out here only to distinguish it from the real gaps above.