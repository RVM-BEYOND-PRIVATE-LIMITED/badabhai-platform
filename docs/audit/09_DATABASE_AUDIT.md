# 09 — Database Audit

Scope: all 65 Drizzle tables in `packages/db/src/schema/{worker,skill,occupation,question-pack,chat,pack-answer,profiling,profile,job,payer,match,referral,ops}.ts`, all 74 migration files (`0000`–`0073`) plus `meta/*.json` snapshots, and the `packages/db/src/{seed,backfill,embed,verify,growth,retag,bootstrap}-*.ts` operational-script surface (37 `db:*` scripts). Cross-checked against `apps/api/src` (Drizzle symbol + raw-SQL table-name grep) and `apps/ai-service` (confirmed DB-free by design — no `psycopg`/`asyncpg`/`sqlalchemy` Postgres engine usage found). Batch 1's RLS figure (65/65 `ENABLE ROW LEVEL SECURITY`, 0 `CREATE POLICY`) is independently re-derived here, not re-quoted blind.

See [`docs/architecture/DATABASE_RELATIONSHIP_MAP.mmd`](../architecture/DATABASE_RELATIONSHIP_MAP.mmd) for the FK diagram.

## 0. Headline numbers (from `meta/0073_snapshot.json`, the cumulative final-state snapshot)

| Metric | Value |
|---|---|
| Tables | 65 |
| Columns | 694 |
| Indexes | 161 |
| Foreign keys | 85 |
| CHECK constraints | 116 |
| Migration files | 74 (`0000`–`0073`, contiguous, verified against `meta/_journal.json`) |
| `CREATE POLICY` statements, platform-wide | 0 (confirms R1: RLS here is a Data-API lockout via ENABLE+FORCE+REVOKE, not per-tenant row filtering) |
| `ENABLE ROW LEVEL SECURITY` statements | 66 (65 distinct tables + 1 duplicate re-assertion on `worker_profiles`, migrations 0009 and 0073 — harmless, not a bug) |
| Apps touching Postgres directly | `apps/api` only, via `packages/db`. `apps/ai-service` is DB-free by design. |

**Drift since this audit ran (added 2026-08-19, #997)**: every number in the table above is the `0073` measurement and is left as the audit made it — this pass re-read the snapshot chain, not the 65 table definitions, so overwriting a figure derived from evidence it did not re-gather would misrepresent what was checked. The current position, mechanically re-derived from `meta/0079_snapshot.json` the same way: **72 tables**, 753 columns, 174 indexes, 98 foreign keys, 139 CHECK constraints, **80 migration files (`0000`–`0079`)**. The seven tables added since `0073` are `job_domain_skill`, `job_posting_skill`, `worker_profile_skill` (`0076`, canonical domain→skill taxonomy), `platform_ai_cost_totals`, `session_ai_cost_totals`, `worker_ai_cost_totals` (`0077`), and `worker_feedback` (`0080`, #997 — this row said `0079` until 2026-08-19; `0079` is the journey read-index migration and never created a table, and the same mislabel was corrected in `tests/e2e/rls-spine.e2e.test.ts` at the same time). Only the last is inventoried in §3 below, because #997 is the change that touched this file; the other six are a real documentation gap this pass is not scoped to close. The FK edge count in §4 and [`DATABASE_RELATIONSHIP_MAP.mmd`](../architecture/DATABASE_RELATIONSHIP_MAP.mmd) are stale on the same six.

**Note**: no `model_training` table exists, and "storage tiers" is a `storage_class` **enum column** on `voice_notes`, not a table. Embeddings are `vector(768)` columns directly on `worker_profiles`, `skill_alias`, `job_domain_alias`, `unresolved_phrase` (HNSW-indexed on the first three) — flagged so a future advisory pass doesn't go looking for tables that don't exist.

## 1. PII boundary (re-confirmed)

Direct identity PII (encrypted at rest, AES-256-GCM + keyed-HMAC lookup hash) lives in exactly four tables: `workers` (`phone_e164`/`phone_hash`, `full_name`), `payers` (`email_enc`/`email_hash`, optional `phone_enc`/`phone_hash`), `admin_users` (`email_enc`/`email_hash`, optional `name_enc`), `agency_kyc` (`pan_enc`/`pan_hash`, `bank_account_enc`, `ifsc_enc`, `account_holder_name_enc`). `payer_orgs.name_enc` and `payer_members.email_enc`/`email_hash` are the same B2B-PII class. Every other table references identity via an **opaque UUID FK only** — confirmed reading all 65 table definitions. `events`, `ai_jobs`, `audit_logs` carry ids/hashes/enums only.

**Second class — PII inside free text (added 2026-08-19, #997).** A column can be free of identity PII while its *contents* are not, because a human typed them. Three columns hold human-authored prose: `voice_notes.transcript_text` (+ its `transcript_english` translation), `chat_messages.body_text`, and now `worker_feedback.message`. None is encrypted at rest; all three sit in plaintext behind the §2 Data-API lockout. For the first two the PII is **incidental** — a phone number said out loud mid-interview — and is tracked as **R12** in [risks-register.md](../registers/risks-register.md). For `worker_feedback.message` it is **expected**: the worker is deliberately writing *to us* and may put their own name, employer or number in it, and an admin is meant to read it — that is the feature, and the reason `GET /admin/feedback` is the only admin list whose rows are not faceless. What the table's own header pins is where that text may not go: never onto an event (`feedback.submitted` carries `message_length`, the same treatment `job.search_performed` gives a search term), never into a log line, never into an LLM prompt or an analytics extract unpseudonymized (CLAUDE.md §11). Erasure needs no new code — `WorkersRepository.hardDelete` names no child table, so the `ON DELETE cascade` from `workers` is the DSAR path (see [`worker-account-deletion-runbook.md`](../worker-account-deletion-runbook.md)).

**A fourth column on the same table, and it is NOT in the class above — `worker_feedback.screen_context` (`0081`).** Client-supplied, but not human prose: the request edge (`sanitizeScreenContext`) substitutes every id-SHAPE — dashed uuid, hex run of 16+, digit run of 4+, all-numeric segment — anywhere in the value, bounds it at 128 characters, and restricts it to `[A-Za-z0-9._:/-]`, so what is stored is a route PATTERN (`/jobs/:id/apply`). That is why, unlike `message`, it *is* allowed onto the events spine (`feedback.submitted.screen_context`) and into the API log line. ⚠ The control is a DENYLIST of id shapes, not a proof: an opaque token that is neither hex nor digits is structurally indistinguishable from a route word and survives. No shipped client sends the field yet, so every row is currently `NULL`; the durable control is an allowlist of the client's own finite route table, and until that exists no document may state the "no identifier can land here" guarantee as absolute.

## 2. RLS posture

Independently re-measured: 65 `ENABLE ROW LEVEL SECURITY` statements across 65 distinct tables, `FORCE ROW LEVEL SECURITY` alongside every `ENABLE`, `REVOKE ALL … FROM {PUBLIC, anon, authenticated, service_role}` on the spine tables, `CREATE POLICY`: 0 matches platform-wide. **Confirms R1 exactly**: this is a Supabase Data-API lockout (a leaked `anon`/`service_role` key exposes nothing), not per-tenant row filtering. The application connects as the `postgres` role (Supabase session-pooler, `BYPASSRLS`, documented in `packages/db/src/client.ts`'s header). Per-payer/per-worker row isolation is enforced entirely at the application layer.

**New finding — RLS model/migration drift (Medium, non-security).** The Drizzle TypeScript model calls `.enableRLS()` on only **34 of 65** tables. The other **31** (`chat_sessions`, `voice_notes`, `chat_messages`, `job_postings`, `jobs`, `applications`, `events`, `ai_jobs`, `audit_logs`, `unlocks`, `payer_credits`, `credit_ledger`, `unlock_routing`, `pricing_catalog`, `posting_plans`, `posting_boosts`, `resume_disclosures`, `payer_capacity`, `generated_resumes`, `profiles`, `questions`, `profile_questions`, `worker_answers`, `worker_attributes`, `profiling_voice_answer`, `profiling_family`, `profiling_family_binding`, `question_pack`, `question_pack_item`, `question_pack_option`, `worker_consents`) have RLS enabled **only in hand-appended migration SQL**, no `.enableRLS()` marker in the model. Independently verified each has a real `ENABLE`+`FORCE`+`REVOKE` block in its origin migration — **this is not a live security gap**, RLS is genuinely on for all 65. It is a **self-documentation/drift-detection gap**: `pnpm db:generate`'s diff is model-driven, so for these 31 tables the model cannot itself prove RLS state — only a migration-grep can. Advisory: add `.enableRLS()` to all 65 table definitions as a zero-risk documentation-parity pass whenever convenient.

## 3. Table inventory by cluster

Legend: **RLS** = confirmed via migration grep. **Used** = confirmed live read/write path in `apps/api`/`apps/ai-service`; "seed/CLI only" = the only writer found is a `packages/db/src/*.ts` script.

### 3.1 Worker identity, profile & resume

| Table | Purpose | RLS | Used |
|---|---|---|---|
| `workers` | PII root | Y (0003/0004) | Y — core |
| `worker_consents` | DPDP consent record, append-only | Y | Y |
| `worker_devices` | Trusted-device registry (ADR-0026 Ph.2) | Y | Y |
| `worker_credentials` | Device-unlock PIN (ADR-0026 Ph.3) | Y | Y |
| `worker_profiles` | Canonicalized profile (current) | Y | Y |
| `generated_resumes` | Rendered resume artifacts | migration only | Y |
| `worker_flags` | Admin flag/unflag | Y | Y |
| `worker_skill` | Matching V1 supply, one row/(worker,skill) | Y | Y |
| `worker_industry_tenure` | Per-industry calendar tenure | Y | Y |
| `push_deliveries` | Per-(event,device) push attempt audit | Y | Y |
| `worker_feedback` | In-app feedback the worker typed themselves (#997) — free text, optional category, `x-app-build` stamp, and (`0081`) a normalized `screen_context` route pattern. **Holds worker PII by expectation rather than by accident** — see §1 | Y (0080) | Y — `POST /workers/me/feedback` writes, `GET /admin/feedback` reads |

### 3.2 Worker profiling / chat / interview corpus (current)

`chat_sessions`, `chat_messages`, `voice_notes` (dormant — `VOICE_NOTES_BUCKET` unset per Batch 1), `worker_attributes`, `profiling_voice_answer` (dormant, same voice-form gate), `worker_pack_answer` — all migration-only RLS, all live/wired except the two dormant voice tables.

### 3.3 Legacy questionnaire — **confirmed dead in application code**

| Table | Purpose | Used |
|---|---|---|
| `profiles` | Legacy metadata-driven questionnaire container (ADR-0005) | **N — dead** |
| `questions` | Legacy shared question catalog | **N — dead** |
| `profile_questions` | Legacy binding | **N — dead** |
| `worker_answers` | Legacy per-(worker,question) answer | **N — dead** |

Grepped `apps/api/src` for `from(profiles)`/`from(questions)`-style Drizzle usage and the camelCase symbols `profileQuestions`/`workerAnswers`: **zero hits**. The bare substrings "profiles"/"questions" appear dozens of times but every one is a false positive (`ProfilesModule`, `apps/api/src/profiles/`, `ProfilesService` — none touch this table). The only writer anywhere is `seed-questionnaire.ts`. **Not an oversight** — `profile.ts`/`pack-answer.ts`'s own header comments say so explicitly ("Superseded, not extended... deliberately not dropped, CLAUDE.md §10") — but the four tables + RLS/FK/index machinery are pure carrying cost today. Advisory: candidate for a deprecation ADR once `seed-questionnaire.ts` has no dependents either — not this agent's call.

### 3.4 Question-pack corpus (current interview engine, migration 0069/0073)

`profiling_family` (~200-row pack owner), `profiling_family_binding` (6-level ISCO inheritance, 6 partial unique indexes preventing a double-claim), `question_pack` (versioned, composite PK), `question_pack_item`, `question_pack_option` — all RLS (0069), all live.

### 3.5 Taxonomy & occupation reference (PII-free)

`skill`, `skill_alias` (HNSW-embedded), `skill_related` (seed/verify-time only — see §5.6), `unresolved_phrase` (below-floor growth queue), `job_domain` (~4,071-row ISCO-08/NCO-2015 catalog), `job_domain_alias` (L0/L2/L3 retrieval tiers) — all RLS, all live except `skill_related`.

### 3.6 Job, application & match

`jobs` (legacy ADR-0009 seeded feed, retired from worker-visible feed — see §5.2), `job_postings` (**the served entity** since Matching V1), `applications`, `job_reach` (materialized-on-write reach cache), `match_config` (single active jsonb row + history), `pace_states` (ADR-0021 supply-widening).

### 3.7 Payer, agency & credits

`payers` (B2B PII root), `payer_orgs` (tenant root, ADR-0027/B5.1), `payer_members`, `unlocks` (**the only writer** of `unlocks`/`unlock_routing` in the whole codebase — structural), `unlock_routing`, `payer_credits`, `credit_ledger` (append-only, source of truth for balance), `pricing_catalog`, `posting_plans`, `posting_boosts`, `resume_disclosures`, `payer_capacity`, `payment_orders`, `payer_job_posting_chat_sessions`/`_messages` (ADR-0035), **`payer_form_drafts` — N, zero consumer, self-documented as deliberate forward scaffolding** (§5.4), `agency_kyc` (behind `AGENCY_PAYOUTS_ENABLED`, default off), `agency_payout_requests`, `agency_payout_accruals`.

### 3.8 Referral & growth

`invites` (worker→worker, ADR-0020), `agency_invites` (agency→worker, ADR-0022), `referral_links`+`referral_clicks` (universal resolver, B4), `referral_bonus_accruals` — three referral-attribution tables coexist by design (§5.7), all live.

### 3.9 Admin & events

`events` (event-first spine, insert-only), `ai_jobs` (async AI work tracking, refs+cost only), `audit_logs` (ids only), `admin_users` (4th privileged principal, ADR-0025/0038).

## 4. Relationship map

See [`DATABASE_RELATIONSHIP_MAP.mmd`](../architecture/DATABASE_RELATIONSHIP_MAP.mmd). All 85 FK edges extracted from `meta/0073_snapshot.json` (not hand-transcribed), labeled with `onDelete` behavior where privacy/DPDP-relevant (`cascade` vs `set null`).

## 5. Findings

### 5.1 RLS model/migration drift — Medium, non-security
Covered in §2. Recommend closing as routine hygiene, not urgently.

### 5.2 `jobs` vs `job_postings` — looks like duplication, is a documented migration bridge
`job_postings` became the served worker-feed entity by owner ruling (2026-07-30, Matching V1). `jobs` is explicitly **not** dropped/renamed/modified — `db:convert:seed-jobs` is the one-time, idempotent cutover script. `applications.job_id` keeps pointing at `jobs` forever for every pre-V1 application (migration 0056: "coexist, never repoint"). Not a defect — flagged so a future reader doesn't "clean up" this apparent duplication and break historical `applications` rows.

### 5.3 `workers.full_name` — stale inline comment (Low, documentation only)
`worker.ts`'s header comment on `fullName` still reads "It has no write site yet... MUST be encrypted before any code writes a real name here." This is now **factually stale**: `workers.service.ts`'s `setFullName()` → `workers.repository.ts`'s `updateFullName()` is a live, wired write path (encrypts before persist, emits a PII-free event, never logs plaintext). **The discipline the stale comment describes is correctly implemented** — not a security gap, just an unupdated comment (matches prior-session memory's "§2 worker-name egress" PRs #204/#205). Advisory: one-line comment fix next time the file is touched.

### 5.4 `payer_form_drafts` — confirmed zero consumer, self-flagged already
Zero hits outside schema/migration/RLS-spine-test files. Shipped with ADR-0035; enough time and several unrelated feature waves have since passed that this is now worth an actual ADR-gated decision rather than indefinite scaffolding. Flagged for Backend Platform/Architect, not decided here.

### 5.5 Legacy questionnaire tables — confirmed dead, self-documented
Covered in §3.3. Same "not this agent's call" recommendation as §5.4.

### 5.6 `skill_related` — no live application reader found
Written by `seed-match-vocabulary.ts` (both directions, symmetry-validated), consumed only by `materialize-job-reach.ts` and `verify-match-v1.ts` (both offline scripts). The live "Tier-2 reach" computation reads the **denormalized** `job_postings.reach_skill_ids` (GIN-indexed jsonb, written at publish time), not `skill_related` directly — architecturally correct (avoids a join on the hot feed path), but means `skill_related` is an offline-materialization input, not a runtime-queried table.

### 5.7 Three referral-attribution tables coexist by design
`invites`, `agency_invites`, `referral_links`+`referral_clicks` — each self-documented as deliberately separate given different principal types and capabilities. Not a defect; flagged because a naive duplication scan would misclassify this as accidental.

### 5.8 Migration 0043's "APPLY BEFORE DEPLOY" warning — stale operational residue
`credit_ledger.priceInr`'s schema comment still carries a loud "⚠️ MIGRATION 0043 — APPLY BEFORE DEPLOY" warning. That migration is 30 migrations behind the current tip — near-certain long since applied. Low-risk stale comment; not re-verified against any running database (out of read access).

### 5.9 No accidental "undo a recent migration" pattern found
Explicitly scanned all 74 files for `DROP TABLE`/`DROP COLUMN`/`DROP CONSTRAINT`/`DROP INDEX`. Every real `DROP` is one of two deliberate, self-documented patterns: an enum-widening two-step, or a DPDP cascade→set-null FK change (migration 0031: `invites.inviter_worker_id`, `resume_disclosures.worker_id`, `unlocks.worker_id` changed from CASCADE to SET NULL so a worker's hard-delete preserves PII-free billing/attribution history). No migration reverts a prior migration's table/column by apparent mistake.

## 6. Migration governance

**Once merged to `main`, no migration file may ever be edited.** Standard Drizzle discipline, observed across all 74 files: every widening/relaxation is a **new** migration (see §5.9). The apparent exception — hand-edits visible in files like `0067_steady_jimmy_woo.sql` ("HAND-EDITED: `IF EXISTS` added...") — happens **before merge**, during the same PR (drizzle-kit's raw output is edited for correctness prior to landing), not after. Per CLAUDE.md §10/§14, if a migration ever needs correcting after merge, the fix is a new migration, never an edit — destructive/irreversible corrections are a human-owner escalation.

## 7. Seed & operational-script safety classification

Classified from each script's own header docstring (all 37 `packages/db/src/*.ts` CLI entry points read in full), not inferred from filename.

**Read-only/verify-only (safe against any environment, including production, at any time):** `verify-match-v1.ts`, `verify-demand.ts`, `verify-reach.ts`, `verify-job-domains.ts`, `verify-question-packs.ts`, `audit-job-domains.ts`.

**Production-guarded reference/catalog seeds (refuse on `NODE_ENV=production` or dry-run-by-default; idempotent; PII-free):** `seed-jobs.ts`, `seed-questionnaire.ts`, `seed-skills.ts`, `seed-job-domains.ts`, `seed-question-packs.ts`, `seed-match-vocabulary.ts` (all three via the `match-v1-cli` harness's `MATCH_V1_PROD_CONFIRM` gate), `normalize-job-domain-aliases.ts`, `embed-skill-aliases.ts`, `embed-job-domain-aliases.ts`.

**Synthetic-PII fixture seeds — refuse on `NODE_ENV=production`, production-dangerous if the guard were ever bypassed:** `seed.ts` (explicit refusal), `seed-demand.ts` (synthetic encrypted phone + unlock-loop fixture), `seed-reach-pool.ts`.

**High-blast-radius ops tools — dry-run-by-default, require an explicit confirm token AND CLAUDE.md §7 human sign-off:** `reencrypt-pii-backfill.ts` (`PII_REENCRYPT_CONFIRM`, staging-first), `retag-skills.ts`, `grant-free-tier.ts` (has a `--repair-balances` reconciliation pass), `convert-seed-jobs.ts` (one-time cutover, idempotent via unique index), `backfill-worker-skills.ts`/`backfill-job-postings-v1.ts`/`materialize-job-reach.ts` (`match-v1-cli` harness), `bootstrap-admin.ts` (refuses if **any** `super_admin` row exists in any status — genuinely one-time by construction, CLI-only, never an HTTP endpoint), `reset-admin-mfa.ts` (break-glass, same trust bar as bootstrap).

**Human-gated growth-loop proposal generators (mutate only a queue/proposal table; nothing becomes live vocabulary without a separate ops-reviewed seed step):** `growth-cluster.ts`, `growth-occupation.ts`, `mine-chat-aliases.ts`, `generate-domain-aliases.ts`.

---

**Files read in full**: all 13 `packages/db/src/schema/*.ts` files + `internal/{question-pack-types,sql-defaults}.ts`; `packages/db/src/client.ts`; `meta/0073_snapshot.json` + `_journal.json`; targeted reads of `0000`–`0004`, `0009`, `0069`, `0072`, `0073` SQL; headers of all 37 `packages/db/src/*.ts` operational scripts; `workers.service.ts`/`workers.repository.ts`; `profiling/pack.repository.ts`.
