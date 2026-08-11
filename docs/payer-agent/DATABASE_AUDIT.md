# Database Audit — Payer + Agency Surface

**Status:** COMPLETE (audited 2026-08-11)
**Method:** evidence-based read of `packages/db/src/schema/*`, `packages/db/migrations/*`, and every payer/agency repository in `apps/api/src`. Every claim carries a `file:line` citation.
**Findings:** 18 (1 P0, 2 P1, 10 P2, 5 P3) + 4 ambiguities. See `GAP_REGISTER.md` for the rows.

> **Ruling applied 2026-08-11 — ambiguity 1 is resolved: ORG-AS-TENANT.**
> The recommendation recorded below in ambiguity 1 (option (c), park Team behind a flag) was
> **not** taken; the owner ruled for full org tenancy. `PAY-DB-01` therefore becomes active work
> (`IMPLEMENTATION_PLAN.md` Phase 3), not a parked item. The governing constraint from that
> ambiguity still holds and is now the plan's sequencing rule: a **partial** org migration is the
> worst outcome, so the migration, the predicate rewrite, and the backend Owner gates ship as one
> coordinated change.
>
> Ambiguities 2, 3 and 4 remain **open**. Ambiguity 4 (which migrations are applied per
> environment) is being resolved by the owner directly against staging and production.

---

> Scope: the DATABASE layer behind apps/payer-web (both personas) and the `/payer/*` + `/payer/agency/*` API surface. All line cites are against the working tree at `feat/747a-spoken-digit-redaction` (0 ahead / 1 behind origin/main).

---

## 1. Table register — every table backing the payer/agency surface

Legend for **RLS**: `E+F+R` = `ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY` + `REVOKE ALL` from PUBLIC/anon/authenticated/service_role, carried by the creating migration. **Every one of the 65 tables in the schema is `E+F+R` and ZERO have a `CREATE POLICY`** (verified: `grep -c 'CREATE POLICY' packages/db/migrations/*.sql` → 0 matches). This is a Supabase Data-API lockout, not per-tenant row filtering; the API connects as a BYPASSRLS role.

### 1.1 Payer identity + tenancy

| table | schema file:line | purpose | owning tenant col | FKs | indexes | unique | CHECK | status enums | audit fields | soft-delete | RLS |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `payers` | payer.ts:47-84 | the payer account (employer OR agent); B2B contact PII at rest (AES-GCM + keyed HMAC) | **self** (`id`) | none outbound | `payers_admin_keyset_idx` (created_at DESC, id DESC) | `payers_email_hash_uq` (email_hash) | **NONE** | `role` = employer\|agent (payer.ts:44) · `status` = pending\|active\|suspended (:45) · `previous_status` same union (:75) — **all three unconstrained in SQL** | created_at, updated_at | none (suspend via `status`) | E+F+R (0009/0011) |
| `payer_orgs` | payer.ts:95-115 | tenant root for the payer surface (ADR-0027/B5.1) | `root_payer_id` | `root_payer_id → payers.id` ON DELETE **restrict** | — | `payer_orgs_root_payer_id_uq` (root_payer_id) | `payer_orgs_status_chk` | `status` = active\|suspended | created_at, updated_at | none | E+F+R |
| `payer_members` | payer.ts:129-161 | org membership + invite→accept→remove lifecycle | **`org_id`** (the ONLY org_id column in the schema) | `org_id → payer_orgs.id` cascade · `member_payer_id → payers.id` set null · `invited_by → payers.id` set null | `payer_members_org_id_idx`, `payer_members_member_payer_id_idx` | `payer_members_org_email_uq` (org_id, email_hash) | `..._role_chk`, `..._status_chk` | `org_role` = owner\|recruiter · `status` = invited\|active\|removed | invited_at, accepted_at, removed_at, created_at, updated_at, `invited_by` | **yes** — `removed_at` + `status='removed'` (payer-orgs.repository.ts:259-273) | E+F+R |

### 1.2 Money + entitlements (the "faceless rails" — `payer_id` is an opaque uuid with **NO FK**)

| table | schema file:line | purpose | owning tenant col | FKs | indexes | unique | CHECK | status enums | audit fields | soft-delete | RLS |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `unlocks` | payer.ts:225-262 | one routed-contact grant per (payer, candidate) | `payer_id` (**no FK**, :230) | `worker_id → workers.id` set null (nullable, DSAR) · `job_id → jobs.id` set null | `unlocks_worker_id_idx`, `unlocks_payer_id_idx` | `unlocks_payer_worker_uq` (payer_id, worker_id) | `unlocks_deny_reason_chk` (deny_reason NULL unless status='denied') | `status` = requested\|granted\|revealed\|expired\|denied (:188) — **no CHECK** · `deny_reason` = no_consent\|capped\|payment_required\|unknown_worker (:195) — **no CHECK** | created_at, updated_at, granted_at, expires_at | none | E+F+R (0014) |
| `payer_credits` | payer.ts:266-282 | materialized credit balance, one row per payer | `payer_id` (**no FK**) | none | — | `payer_credits_payer_id_uq` | `payer_credits_balance_nonneg_chk` (balance ≥ 0) | — | created_at, updated_at | none | E+F+R |
| `credit_ledger` | payer.ts:287-339 | **APPEND-ONLY** signed credit movements; source of truth for balance | `payer_id` (**no FK**) | `unlock_id → unlocks.id` set null | `credit_ledger_payer_id_idx`, `credit_ledger_payer_keyset_idx` (payer_id, created_at DESC, id DESC), `credit_ledger_admin_keyset_idx` (created_at DESC, id DESC) | `credit_ledger_idempotency_key_uq` (idempotency_key, NULLS DISTINCT) | **NONE** | `reason` = pack_purchase\|unlock_debit\|refund\|grant (:204) — **no CHECK** | created_at only (correctly no updated_at — append-only) | n/a | E+F+R |
| `unlock_routing` | payer.ts:349-370 | server-side routing token → channel + expiring relay handle | via `unlock_id` | `unlock_id → unlocks.id` cascade | `unlock_routing_unlock_id_idx` | `unlock_routing_routing_token_uq` | **NONE** | `channel` = in_app_relay\|proxy_number (:211) — **no CHECK** | created_at, expires_at | none | E+F+R |
| `payment_orders` | payer.ts:600-653 | one row per Razorpay checkout intent | `payer_id` (**no FK**, :606) | none | `payment_orders_payer_created_idx` (payer_id, created_at ASC), `payment_orders_admin_keyset_idx` (created_at DESC, id DESC) | **`payment_orders_provider_order_uq` (provider, provider_order_id) — THE payment idempotency key** | `..._amount_pos_chk` (>0), `..._credits_pos_chk` (>0), `..._status_chk` | `status` = created\|paid\|failed — **has CHECK** | created_at, updated_at | none | E+F+R (0058) |
| `pricing_catalog` | payer.ts:408-430 | ops-editable pricing catalog, one ACTIVE jsonb row + history | none (global) | none | — | `pricing_catalog_active_uq` (is_active) WHERE is_active | **NONE** | — | created_at, updated_at, **`updated_by`** (opaque, no FK) | history-by-row | E+F+R |
| `posting_plans` | payer.ts:434-469 | paid plan attached to a job_posting; the immutable receipt | `payer_id` (**no FK**) | `job_posting_id → job_postings.id` cascade | `posting_plans_job_posting_id_idx`, `posting_plans_payer_id_idx` | **NONE** ← see DB-UQ-01 | `..._tier_chk`, `..._status_chk`, `..._viewed_nonneg_chk`, `..._topup_nonneg_chk` | `tier` = standard\|pro · `status` = draft\|active\|expired\|paused — **both have CHECKs** | created_at, updated_at, paid_at, expires_at | none | E+F+R |
| `posting_boosts` | payer.ts:472-498 | booster receipt on a job_posting | `payer_id` (**no FK**) | `job_posting_id → job_postings.id` cascade | `posting_boosts_job_posting_id_idx`, `posting_boosts_payer_id_idx` | **NONE** | `..._tier_chk` (widened additively in 0059), `..._status_chk` | `tier` = all_candidates\|boost_7\|boost_15\|boost_30 · `status` = active\|expired | created_at, updated_at, boost_starts_at, boost_ends_at | none | E+F+R |
| `resume_disclosures` | payer.ts:511-546 | one resume-download grant (FREE but a PII disclosure) | `payer_id` (**no FK**) | `worker_id → workers.id` set null (nullable) · `job_posting_id → job_postings.id` set null · `resume_ref → generated_resumes.id` set null | `resume_disclosures_worker_id_idx`, `resume_disclosures_payer_id_idx` | `resume_disclosures_payer_worker_posting_uq` (payer_id, worker_id, job_posting_id) — **NULLS DISTINCT, so pure-search rows never dedupe** | `..._deny_reason_chk` | `status` = requested\|granted\|disclosed\|denied\|expired (:400) — **no CHECK** · `deny_reason` (:402) — **no CHECK** | created_at, updated_at, disclosed_at, expires_at | none | E+F+R |
| `payer_capacity` | payer.ts:556-578 | per-payer allowance of concurrently-active vacancies | `payer_id` (**no FK**, :561) | none | — | `payer_capacity_payer_id_uq` | `payer_capacity_max_nonneg_chk` | `source_tier` = free text, **no CHECK, no enum** (:566) | created_at, updated_at, expires_at | none | E+F+R (0019) |

### 1.3 Job / posting entities

| table | schema file:line | purpose | owning tenant col | FKs | indexes | unique | CHECK | status enums | audit fields | soft-delete | RLS |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `job_postings` | job.ts:47-217 | THE served job entity (payer self-serve + ops) | `payer_id` **nullable, no FK** (:59) | `source_job_id → jobs.id` set null | `job_postings_status_created_at_idx`, `job_postings_payer_id_status_idx` (0062), `job_postings_payer_id_idx` (payer_id, created_at), `job_postings_feed_idx` (status, published_at DESC), `job_postings_reach_gin` (GIN jsonb_path_ops on reach_skill_ids) | `job_postings_source_job_id_uq` | vacancy_band, status, previous_status, verification_status, pay_nonneg, pay_order, shift, needed_by (8 CHECKs) | `status` = draft\|open\|paused\|suspended\|closed · `verification_status` = unverified\|verified\|rejected · `previous_status` same as status | created_at, updated_at, closed_at, published_at, **`created_by`** (opaque, no FK) | closed_at / status='closed' | E+F+R (0015) |
| `jobs` | job.ts:300-394 | legacy faceless feed rows; **the ONLY entity the agency job CRUD writes** | `payer_id` **nullable, no FK** (:322) | none | `jobs_status_created_at_idx`, `jobs_status_trade_city_created_at_idx`, `jobs_payer_id_status_idx` (0062) | **NONE** | applicants_received, pay_nonneg, pay_order, experience_nonneg, experience_order, needed_by, shift (7 CHECKs) | `status` = open\|closed\|suspended (:268) — **no CHECK** | created_at, updated_at | status='closed' | E+F+R |
| `applications` | job.ts:423-524 | apply/skip decision + the frozen V1 rank snapshot | via `worker_id` / job side | `job_id → jobs.id` cascade (nullable since 0056) · `job_posting_id → job_postings.id` **cascade** · `worker_id → workers.id` cascade | `applications_job_id_idx`, `applications_applied_idx` (partial), `applications_applied_posting_idx` (partial), **`applications_rank_idx`** (7-col partial), `applications_admin_keyset_idx` | `applications_worker_job_uq`, `applications_worker_posting_uq` (partial) | reason, job_ref, match_tier, snapshot_months (4 CHECKs) | `action` = applied\|skipped (:283) — **no CHECK** | created_at, updated_at | none | E+F+R |
| `job_reach` | match.ts:141-175 | materialized (posting, worker) reach cache | n/a | `job_posting_id → job_postings.id` cascade · `worker_id → workers.id` cascade · `matched_skill_id → skill.skill_id` | `job_reach_worker_idx` (+ hand-appended INCLUDE) | PK (job_posting_id, worker_id) | `job_reach_match_tier_chk` | `match_tier` ∈ (1,2) | computed_at | n/a (rebuildable) | E+F+R (0055) |
| `match_config` | match.ts:197-219 | V1 rank-rule knobs, one ACTIVE jsonb row | none (global) | none | — | `match_config_active_uq` (is_active) WHERE is_active | **NONE** | — | created_at, updated_at, `updated_by` | history-by-row | E+F+R (0057) |

### 1.4 Agency / referral

| table | schema file:line | purpose | owning tenant col | FKs | indexes | unique | CHECK | status enums | audit fields | soft-delete | RLS |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `agency_invites` | referral.ts:107-171 | agency→worker attribution intent (deep link) | `inviter_payer_id` **(real FK!)** | `inviter_payer_id → payers.id` **cascade** · `invited_worker_id → workers.id` set null | `agency_invites_inviter_payer_id_idx`, `agency_invites_invited_worker_id_idx` | `agency_invites_code_uq` | `agency_invites_medium_chk` only | `status` = created\|clicked\|accepted — **no CHECK** · `channel` — **no CHECK** · `medium` = organic\|paid — **has CHECK** | created_at, updated_at, attributed_at (0048) | none | E+F+R |
| `agency_kyc` | referral.ts:185-214 | agency PAN + bank, AES-GCM at rest | `payer_id` **(real FK)** | `payer_id → payers.id` cascade | **NONE beyond the two uniques** | `agency_kyc_payer_id_uq`, `agency_kyc_pan_hash_uq` | `agency_kyc_reject_reason_chk` | `status` = pending\|verified\|rejected (:184) — **no CHECK** | created_at, updated_at, verified_at, **`verified_by`** (nullable, never written — repo:95-97) | none | E+F+R (0048) |
| `agency_payout_requests` | referral.ts:226-248 | MOCK payout request claiming unpaid accruals | `agency_payer_id` **(real FK)** | `agency_payer_id → payers.id` cascade | `agency_payout_requests_agency_payer_id_idx` | `agency_payout_requests_idempotency_key_uq` | `..._amount_nonneg_chk` | `status` = requested\|paid\|rejected (:225) — **no CHECK** · `kyc_snapshot_status` — **no CHECK** | created_at, updated_at | none | E+F+R |
| `agency_payout_accruals` | referral.ts:262-292 | **APPEND-ONLY** commission accrual ledger | `agency_payer_id` **(real FK)** | `agency_payer_id → payers.id` cascade · `source_unlock_id → unlocks.id` cascade · `payout_request_id → agency_payout_requests.id` set null | `..._agency_payer_id_idx`, `..._payout_request_id_idx` | `agency_payout_accruals_source_unlock_id_uq` ← exactly-once per unlock | `..._amount_nonneg_chk` | — | created_at only (correct) | n/a | E+F+R |
| `referral_links` | referral.ts:389-432 | the resolver primitive (`/r/<code>`) | `agent_payer_id` **(real FK)** or `owner_worker_id` | `agent_payer_id → payers.id` cascade · `owner_worker_id → workers.id` set null | `..._agent_payer_id_idx`, `..._owner_worker_id_idx`, `..._campaign_idx` (partial) | `referral_links_code_uq` | `..._single_owner_chk`, `..._kind_chk`, `..._medium_chk` | `kind` = agent\|worker\|campaign · `medium` = organic\|paid — **both have CHECKs** | created_at, expires_at | none (expiry) | E+F+R (0060) |
| `referral_clicks` | referral.ts:465-512 | click log; the row first-touch claim locks | via link/worker | `referral_link_id → referral_links.id` cascade · `claimed_by_worker_id → workers.id` set null | `..._code_clicked_idx`, `..._hash_idx`, `..._link_idx` | `referral_clicks_claimed_worker_uq` (partial) | `..._medium_chk`, `..._claim_pair_chk` | `platform` = android\|desktop\|other — **no CHECK** | clicked_at, claimed_at | none | E+F+R |
| `invites` | referral.ts:43-69 | worker→worker funnel (upstream signal for agency payout) | n/a (worker) | both worker FKs set null | `invites_inviter_worker_id_idx` | `invites_code_uq` | **NONE** | `status`, `channel` — **no CHECK** | created_at, updated_at | none | E+F+R |
| `referral_bonus_accruals` | referral.ts:311-341 | ₹20 worker referral bonus, one per referred worker ever | n/a (worker) | both worker FKs **cascade** | `..._inviter_idx` | `referral_bonus_accruals_invited_uq` | `..._amount_pos_chk`, `..._no_self_chk` | — | qualified_at | n/a | E+F+R (0058) |

### 1.5 Payer AI chat + drafts (ADR-0035, migration 0050)

| table | schema file:line | purpose | owning tenant col | FKs | indexes | unique | CHECK | audit fields | RLS |
|---|---|---|---|---|---|---|---|---|---|
| `payer_job_posting_chat_sessions` | payer.ts:692-729 | AI job-posting interview container (cross-device) | `payer_id` **(real FK)** | `payer_id → payers.id` cascade · `published_job_posting_id → job_postings.id` set null | `..._payer_id_idx` | **NONE** | `..._status_chk` (active\|draft_ready\|published\|abandoned) | started_at, last_message_at, ended_at — **NO created_at, NO updated_at** | E+F+R |
| `payer_job_posting_chat_messages` | payer.ts:734-761 | transcript; denormalized `payer_id` owner | `payer_id` **(real FK)** | `session_id` cascade · `payer_id → payers.id` cascade | `..._session_id_idx`, `..._payer_id_idx` | **NONE** | **NONE** (direction / message_type unconstrained) | created_at only | E+F+R |
| `payer_form_drafts` | payer.ts:775-794 | generic cross-device draft primitive — **deliberate forward scaffolding, ZERO consumers** (:765-771) | `payer_id` **(real FK)** | `payer_id → payers.id` cascade | — | `payer_form_drafts_payer_form_uq` (payer_id, form_type) | **NONE** | updated_at only — **NO created_at** | E+F+R |

---

## 2. MISSING / WEAK — indexes matched against actual repository query predicates

This section was derived by opening each repository and reading its WHERE / ORDER BY, then comparing against §1.

### 2.1 The applicant list cannot use the index built for it (DB-IDX-01)

`applications_rank_idx` is a 7-column partial index created **specifically** for the payer applicant list (job.ts:486-501; DDL at migrations/0056_applications_v1_snapshot.sql:103):

```sql
CREATE INDEX "applications_rank_idx" ON "applications" USING btree (
  "job_posting_id","match_tier",
  "skill_months" DESC NULLS LAST,"industry_months" DESC NULLS LAST,
  "last_worked_at" DESC NULLS LAST,"created_at" DESC NULLS LAST,"id"
) WHERE "applications"."action" = 'applied';
```

The only query it exists for is `MatchFeedRepository.listCandidates` (apps/api/src/match/match-feed.repository.ts:242-266), reached from `PayerReachController.applicants` → `MatchCandidatesService.listForPosting` (match-candidates.service.ts:72):

```sql
ORDER BY CASE WHEN a.match_tier > 1 AND COALESCE(a.skill_months,0) >= $tierFloorMonths THEN 1
              ELSE COALESCE(a.match_tier, 2) END ASC,
         COALESCE(a.skill_months, -1) DESC,
         COALESCE(a.industry_months, -1) DESC,
         a.last_worked_at DESC NULLS LAST,
         a.created_at DESC,
         a.id ASC
```

Three independent reasons the index's sort order cannot be matched:
1. The **leading** sort key is a `CASE` expression over a runtime bind parameter (`tierFloorMonths` comes from `match_config`), not the bare `match_tier` column the index stores.
2. Keys 2 and 3 are `COALESCE(col, -1)`, a different expression from `col` — semantically equivalent here (both columns are `>= 0` by CHECK, so `-1` sorts last exactly like `NULLS LAST`), but the planner compares pathkeys by expression identity, not semantics.
3. `a.created_at DESC` emits NULLS FIRST; the index column is `DESC NULLS LAST`.

The index still serves the **WHERE** (leading `job_posting_id` + the `action='applied'` partial predicate), so the read is not a seq scan — but the "in rank order, straight out of the index" claim at job.ts:486-490 and migrations/0056:53-54 is false, and every payer applicant-list read sorts the posting's full applied set before applying `LIMIT 500` (`OPS_LIST_CAP`, apps/api/src/common/pagination.ts:16).

### 2.2 Systemic NULLS-ordering mismatch on every keyset index (DB-IDX-02)

Drizzle's `desc()` compiles to a bare `"col" desc` — verified in the installed package source (`node_modules/.pnpm/drizzle-orm@0.38.4.../drizzle-orm/sql/expressions/select.js`, function `desc`). Postgres defaults `DESC` to `NULLS FIRST`. Every keyset index shipped in 0064/0065 is declared `DESC NULLS LAST`:

| index | DDL | the query that uses it | matches? |
|---|---|---|---|
| `credit_ledger_payer_keyset_idx` | 0064: `("payer_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST)` | `listCreditLedgerByPayer` → `.orderBy(desc(creditLedger.createdAt))` (unlocks.repository.ts:358) | **no** — bare `desc` = NULLS FIRST, and `id` is not in the ORDER BY at all |
| `payment_orders_admin_keyset_idx` | 0065 | admin reads only | n/a to payer surface |
| `applications_admin_keyset_idx` | 0064 | admin reads only | n/a to payer surface |

The repository itself documents this exact rule at packages/db/src/schema/ops.ts:167-173: *"It must say `desc nulls last` explicitly — Postgres defaults DESC to NULLS FIRST, and pathkeys compare `nulls_first` strictly, so a bare `ORDER BY created_at DESC` does NOT match this index and the planner adds a Sort."* The rule was applied to `ai_jobs_extraction_session_idx` and its caller, and not to the keyset family.

**Verification owed:** an `EXPLAIN (ANALYZE)` on a populated DB. I can prove the textual mismatch; I cannot prove the planner's behaviour without a cluster.

### 2.3 Owner-scoped lists that sort on an unindexed second key

Every one of these is `WHERE <owner> = $1 ORDER BY created_at DESC`, and in every case the owner index is single-column:

| repository read | file:line | predicate | index available | gap |
|---|---|---|---|---|
| `UnlocksRepository.listByPayer` | unlocks.repository.ts:601-608 | `payer_id` / ORDER BY created_at DESC / LIMIT 500 | `unlocks_payer_id_idx` (payer_id) | needs `(payer_id, created_at DESC)` |
| `ResumeDisclosureRepository.listByPayer` | resume-disclosure.repository.ts:278-284 | `payer_id` / ORDER BY created_at DESC / LIMIT 500 | `resume_disclosures_payer_id_idx` (payer_id) | needs `(payer_id, created_at DESC)` |
| `AgencyPayoutRepository.listRequests` | agency-payout.repository.ts:147-153 | `agency_payer_id` / ORDER BY created_at DESC / **no LIMIT** | `..._agency_payer_id_idx` | composite + a bound |
| `AgencyKycRepository.listByStatus` | agency-kyc.repository.ts:76-82 | `status` / ORDER BY created_at DESC / **no LIMIT** | **none** — `agency_kyc` has only its two unique indexes | full seq scan + sort, unbounded |
| `AgencyJobsRepository.listOwned` | agency-jobs.repository.ts:114-120 | `payer_id` / ORDER BY created_at DESC / **no LIMIT** | `jobs_payer_id_status_idx` (payer_id, status) | second key is `status`, not `created_at`; also unbounded |
| `PayerOrgsRepository.listMembers` | payer-orgs.repository.ts:108-114 | `org_id` + `status <> removed` / ORDER BY invited_at ASC / **no LIMIT** | `payer_members_org_id_idx` | bounded in practice by the seat cap (:131-137), acceptable |
| `JobPostingChatRepository.listSessions` | job-posting-chat.repository.ts:81-91 | `payer_id` / ORDER BY `coalesce(last_message_at, started_at)` DESC / LIMIT 50 | `..._payer_id_idx` | needs an **expression** index on the coalesce |
| `JobPostingChatRepository.listMessages` | job-posting-chat.repository.ts:107-113 | `session_id` / ORDER BY created_at DESC / LIMIT 200 | `..._session_id_idx` | needs `(session_id, created_at DESC)` — **migration 0067 added exactly this for the WORKER twin (`chat_messages_session_created_idx`) and skipped the payer table** |

`job_postings.listByPayer` (job-postings.repository.ts:199-214) is the one that is correctly served: `job_postings_payer_id_idx` is `(payer_id, created_at)` (job.ts:157).

### 2.4 Coupon-cap enforcement scans the whole event spine (DB-IDX-05)

`PostingPlansRepository.couponUsage` (posting-plans.repository.ts:286-297) enforces `totalUsageCap` / `perPayerLimit` at purchase with two counts:

```ts
eq(events.eventName, "coupon.redeemed"),
sql`${events.payload} ->> 'coupon_code' = ${couponCode}`
... and sql`${events.payload} ->> 'payer_id' = ${payerId}`
```

`events` has `events_event_name_idx` (ops.ts:102) which bounds the scan by name, but there is no expression index on `payload->>'coupon_code'` or `payload->>'payer_id'`. The event spine is append-only with **no retention policy**, so this cost grows monotonically on a path that gates money.

### 2.5 Missing unique constraints that allow duplicate business state

| what | where | consequence |
|---|---|---|
| `posting_plans` has **no unique** on `(job_posting_id)` or `(job_posting_id, payer_id) WHERE status='active'` | payer.ts:461-468 | a posting can carry N simultaneously-active paid plans. The code already assumes this may happen: `findActivePlanForPostingAndPayer` orders `desc(paidAt) LIMIT 1` with the comment *"if a posting somehow carries more than one active plan, the most recent receipt is the one topped up"* (posting-plans.repository.ts:225-227, 244-245). Quota top-ups then land on one plan while the capacity count (`countActivePlansForPayer`, :59-71) counts them all. |
| `posting_boosts` has no unique or exclusion constraint on overlapping windows | payer.ts:487-497 | B-R3 ("reject overlapping boosts") is enforced only by a read (`findActiveBoost`, :206-219) with no lock — a TOCTOU window between the check and `insertBoost` (:168-173, no `tx`). |
| `resume_disclosures_payer_worker_posting_uq` is NULLS DISTINCT on `job_posting_id` | payer.ts:534-538 | a pure-search disclosure (`job_posting_id IS NULL`) can be inserted unboundedly for the same (payer, worker). The comment acknowledges this (:532-533). |
| `agency_kyc` has no constraint tying `verified_at` to `status='verified'` | referral.ts:200-212 | only `reject_reason` is guarded; a `verified_at` on a pending/rejected row is representable. |

### 2.6 Missing FKs

`payer_id` has **no foreign key** on: `unlocks` (payer.ts:230), `payer_credits` (:271), `credit_ledger` (:291), `posting_plans` (:442), `posting_boosts` (:479), `resume_disclosures` (:515), `payer_capacity` (:561), `payment_orders` (:606), `job_postings` (job.ts:59), `jobs` (job.ts:322). This is the deliberate ADR-0010 §Decision 0 "faceless rails" posture, documented at payer.ts:29-43. **But `payers` now exists** and eight *other* tables (`agency_invites`, `agency_kyc`, `agency_payout_*`, `referral_links`, `payer_members`, and all three payer-chat tables) *do* carry a real FK to it. The result is a split posture: deleting a `payers` row cascades the agency side and silently orphans every credit, ledger row, paid order, unlock and posting on the money side, with no referential integrity and no cleanup path.

Other gaps: `job_postings.created_by` (job.ts:52), `pricing_catalog.updated_by` (payer.ts:420), `match_config.updated_by` (match.ts:209), `worker_flags.flagged_by_admin_id` and `agency_kyc.verified_by` (referral.ts:203) are all opaque uuids with no FK.

### 2.7 Missing audit fields

| table | missing |
|---|---|
| `payer_job_posting_chat_sessions` | **no `created_at`, no `updated_at`** (payer.ts:716-718 has only started_at / last_message_at / ended_at) |
| `payer_form_drafts` | **no `created_at`** (payer.ts:787 — only `updated_at`) |
| `jobs` | no `created_by` (job.ts:300-357) — `job_postings` has one, its sibling does not |
| `payer_members` | no `removed_by` (payer.ts:143 has `invited_by` only) — you cannot tell who removed a teammate from the row |
| all money tables | no `created_by` / actor column — the actor lives only on the `events` spine |

### 2.8 Nullable columns business logic assumes non-null

| column | file:line | assumption | guarded? |
|---|---|---|---|
| `unlocks.worker_id` | payer.ts:234 | reveal, cap counts, agency accrual join | **yes** — explicit null guards at unlocks.service.ts:338 and `isNotNull` in agency-payout.repository.ts:68 |
| `agency_invites.attributed_at` | referral.ts:155 | the 90-day payout window anchor; rows accepted before 0048 are NULL and silently excluded from accrual | **yes** — `isNotNull` at agency-payout.repository.ts:69 |
| `posting_plans.paid_at` | payer.ts:455 | the deterministic auto-resume ORDER BY key (`asc(postingPlans.paidAt)`, posting-plans.repository.ts:134) | **no** — nullable + ASC ⇒ Postgres NULLS LAST; a draft/never-paid plan that reaches `paused` resumes last non-deterministically among its peers |
| `job_postings.payer_id` | job.ts:59 | every payer-scoped read; ops-created postings are NULL | yes — always in the WHERE |
| `payment_orders.provider_payment_ref` | payer.ts:628 | only set on settle | yes |
| `agency_kyc.verified_by` | referral.ts:203 | never written at all (repo:95-97 sets only status/verified_at) | column is dead |

---

## 3. Tenancy / isolation — the P0

**`org_id` appears on exactly one table in the entire 65-table schema.** Verified by `grep -n 'orgId|org_id' packages/db/src/schema/` → 4 hits, all in packages/db/src/schema/payer.ts (:90 a comment, :133 the column, :154 and :157 its indexes), all on `payer_members`.

Nineteen payer-owned tables carry **only** `payer_id` — the individual login's id — and no org reference:

`unlocks` · `payer_credits` · `credit_ledger` · `posting_plans` · `posting_boosts` · `resume_disclosures` · `payer_capacity` · `payment_orders` · `job_postings` · `jobs` · `agency_invites` · `agency_kyc` · `agency_payout_requests` · `agency_payout_accruals` · `referral_links` · `payer_job_posting_chat_sessions` · `payer_job_posting_chat_messages` · `payer_form_drafts` · (and `applications` via the posting)

**`payer_orgs.root_payer_id` is never used to widen a data-access predicate.** Repo-wide grep for `rootPayerId|root_payer_id` in apps/api/src returns 6 hits, all inside `PayerOrgsRepository` (payer-orgs.repository.ts:32, 46, 56, 59, 60, 65) and all within `ensureSoloOrg` — i.e. writing the row, never reading it as a scope. Likewise `orgId` in apps/api/src appears only in `PayerOrgsRepository`, `PayerOrgRoleGuard` and `PayerOrgMembersService` — the team-management surface itself. **Zero business reads are org-scoped.**

The consequence, traced end to end:

1. A recruiter must sign up first to be authenticated. `PayerAuthService` calls `ensureSoloOrg(id)` unconditionally at signup (payer-auth.service.ts:91), minting them their own `payer_orgs` row (root = themselves) and an `active` OWNER membership in it.
2. They then accept the invite (`PayerOrgMembersService.accept`, payer-org-members.service.ts:148-186), which flips the inviting org's `payer_members` row to `active` with a later `accepted_at`.
3. `resolveOrgForPayer` picks the most-recently-accepted active membership (payer-orgs.repository.ts:93-101, `orderBy(desc(acceptedAt)) LIMIT 1`) → the inviting org, role `recruiter`. So far, correct.
4. But every business read still filters on `payer_id = <the recruiter's own id>`: `job_postings.listByPayer` (job-postings.repository.ts:199-214), `unlocks.listByPayer` (:601), `getBalance` (:326), `AgencyJobsRepository.listOwned` (:114), `JobPostingChatRepository.listSessions` (:77) — none of them ever consults `req.payerOrg`.

**A recruiter who accepts an invite sees an empty portal: zero postings, zero credits, zero candidates, zero unlocks.** They also lose access to the solo org they own, because `resolveOrgForPayer` now returns the inviting org. This is not a frontend stub — the schema cannot express the shared tenancy the Team feature promises. Fixing it is a migration on 19 tables plus a rewrite of every owner-scoped predicate; it is not a patch.

**Secondary isolation note:** RLS is `ENABLE + FORCE` on all 65 tables with **zero policies** and `REVOKE ALL` from PUBLIC/anon/authenticated/service_role. The API connects as a BYPASSRLS role (apps/api/src/database/database.module.ts). So the DB provides a Supabase Data-API lockout and *no* per-tenant row filtering whatsoever. Tenancy is 100% app-layer (`apps/api/src/payers/payer-scope.ts` + `payer_id` in every WHERE). Adding `org_id` would at least make DB-enforced tenancy *possible*; today it is not.

---

## 4. Money integrity

### 4.1 Is the ledger append-only?

**Structurally, no; behaviourally, yes.** `credit_ledger` has no `updated_at` and no UPDATE/DELETE path in any repository (the only writers are `appendLedger` — unlocks.repository.ts:378-397 — and `creditPackWithinTx` :459-467, plus the raw INSERT in free-tier.service.ts:49-53). But nothing in SQL prevents an UPDATE or DELETE: **there are zero triggers and zero rules in the entire migration set** (`grep 'CREATE TRIGGER|CREATE OR REPLACE FUNCTION|CREATE FUNCTION' packages/db/migrations/*.sql` → 0 matches). Same for `agency_payout_accruals`.

### 4.2 Is there a balance-vs-ledger invariant, and where is it enforced?

**There is no invariant anywhere — not in SQL, and not in TypeScript either.** There is no constraint, no trigger, and no reconciliation job asserting `payer_credits.balance = SUM(credit_ledger.delta) WHERE payer_id = ...`. What exists instead:

- `payer_credits_balance_nonneg_chk` (payer.ts:280) — balance ≥ 0, enforced in SQL.
- `tryDebit` (unlocks.repository.ts:368-375) — an atomic conditional `UPDATE ... SET balance = balance - n WHERE payer_id = $1 AND balance >= n RETURNING balance`. No read-then-write window.
- Both writers pair the balance mutation and the ledger append **inside one transaction**: the unlock grant path at unlocks.service.ts:244-270 (`tryDebit` then `appendLedger` inside `repo.withTransaction`), and `creditPackWithinTx` at unlocks.repository.ts:451-467.

So they cannot drift under normal operation, but a manual DB edit, a future non-transactional writer, or a partially-applied `refund` would drift silently and nothing would detect it.

### 4.3 Is the credit deduction transactional with the unlock insert?

**Yes, and it is the strongest chokepoint in the codebase.** `UnlockService.requestUnlock` (unlocks.service.ts:184-299) opens ONE `repo.withTransaction` and, inside it:
- takes a per-worker advisory lock (`pg_advisory_xact_lock(hashtextextended(workerId,0))`, unlocks.repository.ts:103-106);
- checks caps (unlocks.service.ts:234);
- debits (`debitOneCreditWithinTx`, :244);
- writes the grant (`upsertGrant`, :256-263);
- appends the ledger row (:265-270).

Events are deliberately deferred to post-commit (:302) to avoid a pool-vs-lock deadlock. `ResumeDisclosureRepository.lockWorker` uses the **identical** lock derivation (resume-disclosure.repository.ts:69-71) so the shared per-worker disclosure ceiling is race-free across both SKUs.

### 4.4 Payment idempotency

Three independent layers, all cited in payment-gateway.ts:250-320:

1. **`payment_orders_provider_order_uq` on `(provider, provider_order_id)`** — a DB unique index (payer.ts:640). A webhook redelivery, a double-tapped Pay button and a retry all collide here.
2. **Atomic compare-and-set claim** — `claimPaymentOrderPaidWithinTx` (unlocks.repository.ts:548-569) issues one `UPDATE ... SET status='paid' WHERE provider=$1 AND provider_order_id=$2 AND status <> 'paid' RETURNING *`. Exactly one caller gets a row under READ COMMITTED.
3. **`credit_ledger_idempotency_key_uq`** (payer.ts:330) — the grant stamps `idempotencyKey = 'payment_order:<row id>'` (payment-gateway.ts:301), so even a bypass of (2) aborts the transaction.

The claim and the grant run in ONE transaction (`repo.withTransaction`, payment-gateway.ts:285-306), so "order marked paid" and "credits granted" are inseparable. `markPaymentOrderFailed` uses the same `status <> 'paid'` guard (unlocks.repository.ts:577-593) so an out-of-order `payment.failed` cannot walk back a settled order. The catalog is **not** re-consulted at capture — `credits_granted` and `amount_inr` are stamped once at order creation (payer.ts:611-625), so an ops re-price mid-checkout cannot change what an existing order is worth.

The free-tier grant is likewise ledger-first + idempotent (free-tier.service.ts:47-64: `INSERT INTO credit_ledger ... ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`, and the balance bump only runs if a row was actually returned).

**Webhook-level idempotency:** the Razorpay webhook controller has no dedupe of its own (no `x-razorpay-event-id` tracking) — it relies entirely on the order-level guards above. Given layer (2) that is sufficient, but it means a replayed webhook for an *unknown* order id is indistinguishable from a first delivery.

### 4.5 Agency payout ledger

`AgencyPayoutRepository.createRequestClaiming` (agency-payout.repository.ts:162-209) inserts the request and claims accruals via `UPDATE ... SET payout_request_id = $req WHERE agency_payer_id = $1 AND payout_request_id IS NULL RETURNING amount_inr` — race-safe (two concurrent requests claim disjoint sets), and a below-threshold result throws `PayoutBelowThresholdError` to roll back the whole transaction. Accruals are exactly-once per unlock via `agency_payout_accruals_source_unlock_id_uq` (referral.ts:287). `agency_payout_requests_idempotency_key_uq` (referral.ts:245) guards the request. All of this is **flag-gated OFF** by `AGENCY_PAYOUTS_ENABLED` and `status='paid'` is inert (no real disbursement).

---

## 5. Migration hygiene

- **Highest migration: 0073** (`0073_pack_answers_and_occupation_match`). Journal `idx` runs **0..73 with no gaps and no duplicates** (packages/db/migrations/meta/_journal.json:5-522) and the `when` timestamps are monotonically increasing. Contiguous. ✅
- **Untracked file present in the working tree:** `packages/db/adopt-0066.ts` (git status, not on `origin/main`). Out of scope for the schema register but noted.
- **Destructive DDL: none executed.** Repo-wide grep for `DROP TABLE` / `DROP COLUMN` returns hits **only inside `-- ROLLBACK:` comment blocks**. Not one executed statement drops a table or column. ✅
- **The one relaxation:** `ALTER TABLE "applications" ALTER COLUMN "job_id" DROP NOT NULL` (0056:93). Expand-direction and safe, but a documented **one-way door** (0056:23-40): re-adding NOT NULL is impossible once a posting-only row exists.
- **Legacy-drift compatibility shim:** 0032 conditionally drops NOT NULL on a `payers.payer_type` column that exists in some live environments and **is not modelled in the Drizzle schema at all**. The migration deliberately does not drop it (0032:6-8). Schema-vs-live-DB drift on the payer identity table.
- **CHECK-swap windows:** 0019, 0033, 0049, 0059, 0062 and 0073 each `DROP CONSTRAINT` then `ADD CONSTRAINT` on a live table. Drizzle-kit wraps a migration file in one transaction, so the unvalidated window is not externally observable — but 0059 and 0062 both widen enums, which is only safe because the widened set is a superset.
- **`ON DELETE cascade` live-ops hazard:** `applications.job_posting_id → job_postings.id` is CASCADE (0056:100), so deleting a posting silently deletes every V1 application on it. The migration header calls this out explicitly (0056:42-47) and instructs ops to CLOSE, never DELETE.

### 5.1 APPLY-BEFORE-DEPLOY set (payer/agency)

**The general rule for this repo:** Drizzle's `.select()` with no argument compiles to an **explicit column list**, never `SELECT *`. Therefore *any* unapplied additive-column migration breaks the READ, not just the writer. "Additive column" is **not** deploy-safe ahead of the migration here. Derived by cross-referencing each recent migration's added columns against code on main:

| migration | adds | code on main that names it | blast radius if unapplied |
|---|---|---|---|
| **0043** | `credit_ledger.price_inr` | **selected explicitly** at unlocks.repository.ts:353; **inserted explicitly** at :465 | every pack purchase INSERT + the whole credit-history READ. The schema comment at payer.ts:307-312 still says *"owner-apply pending"*. |
| **0048** | `agency_kyc`, `agency_payout_requests`, `agency_payout_accruals` tables + `agency_invites.attributed_at` | agency-kyc.repository.ts, agency-payout.repository.ts throughout; `attributedAt` written at agency-invites.repository.ts:89 | the entire agency money surface |
| **0058** | `payment_orders` (incl. `credits_granted`), `referral_bonus_accruals` | unlocks.repository.ts:487-510, 548-569 | all real-payment checkout |
| **0060** | `referral_links`, `referral_clicks` | referral-link.repository.ts | the `/r/` resolver + first-touch attribution |
| **0061** | `payers.previous_status` | `select()` star on `payers` (payers.repository.ts:107, 194) ⇒ column named in SQL | **every payer lookup by id or email** |
| **0062** | `job_postings.previous_status` + widened status CHECK + 2 indexes | `select()` star on `job_postings` (job-postings.repository.ts:125, 132, 191, 208) | **every payer job-posting read and list** |
| **0068** | `agency_invites.medium`, `agency_invites.payload` | inserted at agency-invites.repository.ts:51-52; read via `select()` star at :61-66 | all agency invite mint + resolve |
| 0064 / 0065 | indexes only | — | safe (performance only) |

`packages/db/migrations/meta/` records what drizzle-kit *generated*; nothing in the repo records what any environment has *applied*. There is no applied-state artifact to audit against.

---

## 6. Can the DB support every workflow the frontend implies?

### 6.1 Supported (table-backed, verified)

Payer signup/login (`payers` + Redis sessions) · payer self-edit (`payers.update`, payers.repository.ts:173-189) · employer job postings CRUD + pause/resume/close (`job_postings`) · agency job CRUD (`jobs`) · AI job-posting chat with cross-device resume (`payer_job_posting_chat_*`) · credits + top-up + real Razorpay checkout (`payer_credits`, `credit_ledger`, `payment_orders`) · credit history · contact unlock + reveal (`unlocks`, `unlock_routing`) · masked resume disclosure (`resume_disclosures`) · posting plans + boosts + quota top-up (`posting_plans`, `posting_boosts`) · hiring capacity (`payer_capacity`) · applicant list with frozen rank snapshot (`applications` + `job_reach`) · agency invites incl. batch + QR (`agency_invites`) · agency referral funnel counts · agency worker engagement (consent-gated SQL, agency-workers.repository.ts:57-145) · agency KYC (`agency_kyc`) · agency earnings + payouts (`agency_payout_*`) · team invite/accept/remove (`payer_members`).

### 6.2 NO table support

| workflow | evidence of the gap |
|---|---|
| **Payer notifications / alerts feed** | `NotificationsRepository` is worker-only — it projects over `events` with a three-leg *worker* predicate (notifications.repository.ts:19-38) and the read watermark is `workers.notifications_read_at` (worker.ts:70). There is no payer equivalent, no payer watermark column, no notification table. |
| **Saved searches / saved candidate lists** | no table exists (packages/db/src/schema/index.ts:246-312 is the complete inventory). `payer_form_drafts` (payer.ts:775-794) is the nearest primitive and is explicitly **forward scaffolding with zero consumers**. |
| **Payer analytics / dashboard metrics** | no table. `getDashboard` (payer-api.ts:173) composes from other live reads; there is no aggregate, rollup, snapshot or time-series table for the payer. |
| **Payer-visible audit history** ("who on my team did what") | `audit_logs` (ops.ts:191-204) exists but has **no `payer_id` / `org_id` column** — only `entity_type`/`entity_id`/`actor_id` — and no payer read path. `payer_member.*` events land on the spine but nothing surfaces them to a payer. |
| **Applicant pipeline / ATS stages** | `applications.action` is `applied\|skipped` only (job.ts:283). There is no shortlist / interview / offer / hired state, no per-application notes, no stage-transition table. |
| **Payer↔candidate messaging** | `chat_sessions` / `chat_messages` carry a hard NOT NULL FK to `workers.id`; the payer chat tables are job-posting authoring only (payer.ts:657-664 states the non-retrofit decision explicitly). |
| **Employer verification / company KYC** | `agency_kyc` is `payers.role='agent'` only (referral.ts:189). An employer has no verification, document, or trust-record table. `job_postings.verification_status` verifies a *posting*, not the company. |
| **Invoices / GST receipts** | `payment_orders` has `amount_inr` and an opaque `provider_payment_ref` but no invoice number, GSTIN, tax breakdown, billing address or line items (payer.ts:600-631) — and by design must not (PII-free posture). Nothing else exists. |
| **Team activity feed / seat billing** | `payer_members` records lifecycle timestamps but no per-action log; seats are capped in code (payer-orgs.repository.ts:131-137), not billed or stored. |

### 6.3 Intentionally parked (not a DB gap)

- **Agency bulk upload** — `apps/payer-web/src/app/(portal)/agency/bulk-upload/page.tsx:9-19` is an explicit "this does not exist, and no flag revives it" page (ADR-0022 module 2, killed on consent grounds). Correctly has no table.
- **Subscription / recurring plan management** — `/plans` (apps/payer-web/src/app/(portal)/plans/page.tsx) renders the pricing catalog + capacity tiers; the product model is one-off credits + per-posting plans + a capacity allowance. There is no recurring-billing table, and the frontend does not imply one. Recorded as an ambiguity, not a defect.

---

## 7. Constraint-convention audit

The schema header (index.ts:6-9) and the payer.ts convention note declare a `text` + `$type<>()` + **CHECK** convention. Fourteen status/enum columns have **no CHECK**:

`payers.role`, `payers.status`, `payers.previous_status` (payer.ts:51, 61, 75) · `unlocks.status`, `unlocks.deny_reason` (:237, 240) · `credit_ledger.reason` (:294) · `unlock_routing.channel` (:358) · `resume_disclosures.status`, `.deny_reason` (:523, 525) · `payer_capacity.source_tier` (:566) · `jobs.status` (job.ts:314) · `applications.action` (job.ts:438) · `agency_kyc.status` (referral.ts:200) · `agency_payout_requests.status`, `.kyc_snapshot_status` (referral.ts:235, 237) · `agency_invites.status`, `.channel` (referral.ts:130-131) · `invites.status`, `.channel` (referral.ts:58-59) · `referral_clicks.platform` (referral.ts:485) · `payer_job_posting_chat_messages.direction`, `.message_type` (payer.ts:747-748).

The most consequential is `payers.role`: `PayerRoleGuard` (apps/api/src/payers/payer-role.guard.ts) branches on it for vertical authz, and a value outside `{employer, agent}` is representable in the DB.
