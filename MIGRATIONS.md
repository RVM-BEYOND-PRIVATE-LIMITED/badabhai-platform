# Database Migration Protocol

> Lives at the repo root, alongside `CLAUDE.md`, so it travels with every working branch
> and cannot go stale in a docs tree nobody reads.
> Owner: Backend Platform. Applies to every change under `packages/db/migrations/`.

## Why this file exists

`drizzle-kit` writes **three** artefacts per migration:

1. `packages/db/migrations/NNNN_slug.sql`
2. an entry in `packages/db/migrations/meta/_journal.json`
3. `packages/db/migrations/meta/NNNN_snapshot.json`

Two developers generating concurrently collide on **all three**, and git will not warn anyone —
each branch mints a locally-unique number that is only discovered to be wrong once both merge.

This has already cost the project real work:

- `88cb536` had to hand-renumber the job-domain migration `0060` → `0066`, because
  `0060_referral_links_and_clicks.sql` had claimed the slot on another branch. Comments referring
  to "migration 0060" survived that renumber and were only corrected later.
- The tech-debt register recorded the same hazard prospectively: _"two branches can each mint a
  locally-unique number and git will not warn you."_

## Reserved blocks

Numbers are reserved **up front**, per developer, per workstream. **The head line is
DELIBERATELY not pinned here** — it went stale four times (it said `0086` from 2026-08-21 while
`0087`–`0092` landed, then `0092` while `0093`–`0098` landed, then `0111` while `0112`–`0119`
landed, then `0119` from 2026-09-21 while `0120`–`0123` landed).
**Read `packages/db/migrations/meta/_journal.json` for the current maximum when minting a
number** — it is the only source that cannot lag.

| Block         | Owner     | Workstream                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0067`        | Divyanshu | **APPLIED** — Phase 1 retrieval foundations                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `0068`        | Prakash   | **APPLIED** — W1 referral link metadata on `agency_invites`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `0069`        | Divyanshu | **APPLIED** — Occupation Intelligence question packs (5 tables)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `0070`        | Prakash   | **MERGED** — worker notification prefs + Alerts watermark (#646)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `0071`        | Prakash   | **MERGED** — voice profiling form data spine (V1)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `0072`–`0073` | Divyanshu | **MERGED** — OIE P8 cutover: `unresolved_phrase.scope`, pack answers (#650)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `0074`        | Prakash   | **MERGED** — `.enableRLS()` model markers, 31 tables (BL-26, #839)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `0075`        | Divyanshu | **MERGED** — `job_postings` state for `GET /jobs/search` (#822, #856)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `0076`        | Prakash   | **APPLIED IN PRODUCTION** — canonical Domain→Skill taxonomy, Phase 1 (`fca0ef9c`; verified 2026-08-19)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `0077`        | Prakash   | **APPLIED IN PRODUCTION** — AI cost attribution: three running-total tables (verified 2026-08-19)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `0078`        | Prakash   | **APPLIED IN PRODUCTION** — S3-C / D-6: `unresolved_phrase.job_domain_id` (verified object-by-object 2026-08-19)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `0079`        | Prakash   | **APPLIED IN PRODUCTION** — admin worker-journey read indexes (#992; renumbered from `0078`, see notes below; verified object-by-object 2026-08-19)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `0080`        | Divyanshu | **APPLIED IN PRODUCTION** — worker app feedback table (#997, `ac3db91c`). Verified object-by-object 2026-08-19: 6 columns, 3 CHECKs, the FK, 3 indexes, RLS enabled + FORCED, all four REVOKEs, and two real rows written through the live path                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `0081`        | Prakash   | **APPLIED IN PRODUCTION** — `worker_feedback.screen_context` (#1036). Recorded in `drizzle.__drizzle_migrations` (`created_at=1787141865609`) and verified by `db:audit:schema-contract`. Note this migration is the ONLY one of `0076`–`0081` that is journal-recorded — see the drift note below                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `0082`        | Prakash   | **APPLIED IN PRODUCTION 2026-08-20, AND NOW RECORDED** — R39: re-lock the seven public tables `db:audit:rls` reported open. Permissions only; no table, column, index or constraint moves. Minted as `0081` and renumbered after `#1036` took that slot. Rehearsed first (`db:verify:rls-lock`, 22/22 PASS), then applied **by hand rather than through `db:migrate`**, so its objects are live and `drizzle.__drizzle_migrations` has no row for it. Verified after the fact: `db:audit:rls` = **77/77 locked, 0 deviating**; `db:audit:schema-contract` = **READY**. Recorded by adoption on 2026-08-20 — not by `db:migrate`, which can no longer reach it; see the drift note below                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `0083`        | Prakash   | **APPLIED IN PRODUCTION 2026-08-20, RECORDED, AND NOW MERGED** — `ai_call_traces`: the prompt + completion of every AI call, AES-256-GCM at rest behind a shape CHECK that refuses prose, `worker_id NOT NULL ON DELETE cascade` (the DSAR erasure IS the cascade), RLS + FORCE + four REVOKEs. Additive: one new table, nothing existing moves. Applied by hand with `created_at = 1787230000000` hand-pinned ABOVE `0082`'s `1787220000000` — deliberately, because `db:generate` stamped it at `1787213473538`, i.e. BELOW, and it would otherwise have been skipped silently and forever. **This is the "orphan row" the section below describes; merging this PR is what resolves it.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `0084`        | Prakash   | **MERGED AND APPLIED 2026-08-20** — GAP-DB-21 modelled: the four payer-onboarding tables that existed on production and in no migration and no schema file. Owner ruling 2026-08-20: keep and model, do not drop. A **no-op on production** — every CREATE is `IF NOT EXISTS`, every constraint add is preceded by a `DROP ... IF EXISTS`, and FORCE/REVOKE are idempotent; the only statements that do anything are FK re-adds on tables holding 0 rows. On every OTHER database it is the migration that finally creates them. Verified read-only against production before merge: `adopt-migrations --only=0084` reports **clean=1 mismatched=0** across the full static parse plus 24 effect assertions, which is a proof the declaration matches the live catalog object for object. Minted as `0083`, renumbered after `#1130` took that slot — the fifth collision recorded here; `when` hand-raised to `1787240000000`, above `0083`'s `1787230000000`, or the migrator would have skipped it                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `0085`        | Prakash   | **APPLIED 2026-08-21, journal row RECORDED (confirmed present 2026-08-26)** — #1110: takes `EXECUTE` away from `PUBLIC`/`anon`/`authenticated`/`service_role` on the three undeclared `SECURITY DEFINER` functions (`_log_delete`, `rls_auto_enable`, `is_active_payer_member`). **No schema change at all** — no CREATE, no ALTER, no DROP, no data touched; it only removes privileges, and grants nothing. Snapshot is a byte-copy of `0084`'s with a fresh `id`, the `0082` convention for a privilege-only migration. **A no-op on every fresh database**, deliberately: the three functions are undeclared, so a database built from this repository does not have them and `to_regprocedure` skips each one with a NOTICE — the roles are guarded against `pg_roles` for the same reason. Every REVOKE sits inside `format()` behind those guards, so the static parse reads **nothing** out of the file and an effect verifier checks all 12 grants from the catalog instead. Verified read-only against production: adoption **refuses it with 12 mismatches** (including `PUBLIC`, which `information_schema.routine_privileges` does not report at all) and `db:audit:undeclared-routines --strict` exits **1** naming all three. Both are the _before_ reading — they are what proves the REVOKE took once it is applied. **Awaiting the owner decision in `docs/registers/gap-db-undeclared-routines.md`**                       |
| `0086`        | Prakash   | **APPLIED 2026-08-21, journal row RECORDED (confirmed present 2026-08-26)** — #1110, the other half of the owner ruling: DECLARE the deletion trail (it stays), NARROW it, and BOUND it. Creates `_delete_forensics` (fresh databases only — production already had it, out of band, since 2026-08-13), replaces `_log_delete` so it no longer writes `current_query()` or the client IP, **DROPs `query` and `client_addr`**, re-creates both triggers idempotently, adds `_delete_forensics_at_idx` for the retention sweep, and states ENABLE + FORCE + four REVOKEs explicitly. **ORDER IS LOAD-BEARING**: the function is replaced BEFORE the columns are dropped, or a DELETE on `workers` inside that window fires a function referencing columns that no longer exist. **The one irreversible migration in the #1110 set** — `ALTER TABLE ... ADD COLUMN` restores the shape and not the 147 values — which is why it is separate from `0085` and why the PII was measured first: **0 phone-shaped, 0 email-shaped, 0 bare mobiles**. Touches NOTHING belonging to the DPDP erasure proof (`audit_logs`, the Redis tombstone, the event), and a test asserts that against the statements with comments stripped. First migration to use `bigserial`, which adoption refused as an unmapped type until `normalizeType` learned the serial pseudo-types — the refusal was correct. Verified after the apply: 17 effect assertions clean |
| `0089`        | Prakash   | **APPLIED 2026-08-24** - #1202 job search FTS: `job_postings.search_vec` GENERATED tsvector (role_title weight 'A' + skill_phrases weight 'B', config `simple`) via IMMUTABLE helper `job_postings_skill_phrases_text(jsonb)`, GIN probe for `GET /jobs/search`. Generated by `db:generate`, then hand-edited (HAND-PREPENDED: the function CREATE must precede the column, plus `lock_timeout` and rollback notes)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `0090`        | Prakash   | **APPLIED 2026-08-24, journal row RECORDED 2026-08-26** (adopted clean alongside `0091`/`0092`; see the drift note below) - Policy 27 third leg / TD127: `job_reach_widen` provenance table (one row per ops widen request: ids + opaque actor + `expires_at`), partial due-index, RLS FORCE + four REVOKEs. Read by the `reach-widen-expiry` sweep                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `0091`        | Prakash   | **APPLIED 2026-08-24, journal row RECORDED 2026-08-26** (adopted clean alongside `0090`/`0092`; see the drift note below) - LEARN label store: `learn_labels` (one row per feed.shown_v2 impression, resolved to applied/skipped by later application events; rank/tier/boosted/matched-skill context at show time) + `learn_labels_cursor` sweep watermark. UNIQUE impression key = ingest idempotency; worker FK CASCADEs for DPDP erasure. RLS FORCE + four REVOKEs on both tables                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `0092`        | Divyanshu | **APPLIED IN PRODUCTION AND RECORDED 2026-08-26** (#1225). Verified object-by-object the same day: `information_schema.columns` reports `attachment_paths` / `jsonb` / `is_nullable=YES` / `column_default=null`, which is the whole of what this migration declares — one column, no constraint, no index, no default. Verifying it is what exposed the journal drift described below: the watermark still sat at `0089`'s `1787574455774`, so this and `0090`/`0091` were live and unrecorded. All three adopted the same day, `clean=3 mismatched=0`. #1191: `worker_feedback.attachment_paths` (jsonb, nullable, no default), the object keys of the up-to-three images a worker attaches to a feedback submission. Generated by `db:generate` and left as generated — ONE `ADD COLUMN`, catalog-only, no CHECK (deliberately; the header states why, and the control is the per-path ownership regex in `FeedbackService`, not a bound). **APPLY BEFORE DEPLOY for BOTH surfaces**: the insert names the model's whole column list, so every submission 500s without it — including the ones carrying no image — and `AdminFeedbackRepository` names it in its explicit SELECT. Inherits `0080`/`0081`'s ordering and their journal-drift problem. Recorded in `schema-contract.ts` as `0092-attachment-paths-column`                                                                                                                    |
| `0093`+       | unclaimed | OIE's orchestrator/profiling/parse migration lands here; claim in a PR of its own. **Bumped from `0085`+ on 2026-08-20** (which #1110's REVOKE took) and again from `0092`+ on 2026-08-25 (which #1191 took) — the seventh slot collision this file records, and the reason the rule is to re-check the number immediately before pushing rather than when the branch is cut                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `0109`        | Prakash   | **MERGED (#1537, `9e7d5e42`); APPLIED** — ADR-0042 D9 / Layer A (a): `workers.whatsapp_enc` (nullable, AES-256-GCM token behind a shape CHECK). One `ADD COLUMN` + one `ADD CONSTRAINT`; no backfill. **APPLY-BEFORE-DEPLOY** — a bare `workers` select names every model column — registered as `0109-worker-whatsapp-enc-column` in `schema-contract.ts`, rotation target added in `reencrypt-pii-backfill.ts` |
| `0110`        | Prakash   | **MERGED (#1539, `faa39492`); APPLIED** — ADR-0042 D9 / Layer A (b): `worker_language` (one row per language; speaks/reads/writes ticks; worker order). New empty table only; RLS ENABLE + hand-appended FORCE + four REVOKEs; registered as `0110-worker-language-table` + `0110-worker-language-rls` in `schema-contract.ts`; listed in `tests/e2e/rls-spine.e2e.test.ts` LOCKED_TABLES |
| `0111`        | Prakash   | **MERGED (#1541, `11bd259f`); APPLIED** — ADR-0042 D9 / Layer A (c): `worker_attributes.value_json` + the `json` kind. `ADD COLUMN` + `wa_value_kind_chk` widened + `wa_value_present_chk` re-stated (fifth branch) + `wa_value_json_shape_chk` (object only). ADDITIVE for data: every pre-0111 row has `value_json IS NULL` and satisfies the new branches. **APPLY-BEFORE-DEPLOY** — `upsertMany` names every value column unconditionally — registered as `0111-worker-attributes-value-json-column` in `schema-contract.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `0112`        | Prakash   | **MERGED (#1542, `24674c3f`); APPLIED** — ADR-0042 D9 / Layer A (d): `worker_training` (course/provider/year, worker order; RLS ENABLE + hand-appended FORCE + four REVOKEs) + `worker_certificate.licence_number_enc` (AES-256-GCM token behind a shape CHECK) and `licence_expiry` (date). Both licence fields are worker-self only — never on a sheet, never employer-visible; rotation target added. Registered as `0112-worker-training-table`, `0112-worker-training-rls`, `0112-worker-certificate-licence-columns`; `worker_training` listed in the e2e RLS guard |
| `0113`        | Prakash   | **APPLIED 2026-09-17** — ADR-0042 D9 / Layer A (e): `worker_portfolio` (kind photo/video/link; storage_key for media, url for links; content CHECK; worker order; RLS ENABLE + hand-appended FORCE + four REVOKEs). New empty table; registered as `0113-worker-portfolio-table` + `0113-worker-portfolio-rls`; listed in the e2e RLS guard. The media BUCKET (`WORKER_PORTFOLIO_BUCKET` → `worker-portfolio`) is provisioned out-of-band (PRIVATE, 25 MiB, mime allowlist mirroring the service map); mint is live wherever the env is set and 503s where it is not. **Arming is unblocked: `AccountDeletionService` now sweeps `portfolio/{workerId}/` (#1548)**, so setting the env var arms uploads and erasure together |
| `0114`        | Prakash   | **MERGED (#1550); APPLIED** — ADR-0042 D9 / Layer A (f): `worker_occupation` (worker-declared SECONDARY `role_*` ids, worker order; shape-only `wo_role_id_chk` — membership stays in the DTO against the taxonomy). New empty table; RLS ENABLE + hand-appended FORCE + four REVOKEs; registered as `0114-worker-occupation-table` + `0114-worker-occupation-rls`; listed in the e2e RLS guard. Supply: each id rides the existing `ROLE_TO_MATCH_SKILL` bridge in `deriveWorkerSkills` (no new `mskill_*`, no rank key). **APPLY-BEFORE-DEPLOY** — the occupations endpoint and `WorkerSkillsRepository.findSecondaryRoleIds` both name the table unconditionally |
| `0115`        | Prakash   | **MERGED (#1551); APPLIED** — ADR-0042 D9 / Layer A (g): `workers.verification_state` (nullable; CHECK closes ASSUMPTIONS A1's five-value vocabulary) + `workers.verified_at` (nullable, no render reads it). Five in the schema, two in the UI — the value→label mapping lives in `apps/api/src/resume/verification-tier.ts`, NOT in SQL, so a future tier change is a TypeScript edit. No application write path yet (ops act), hence no event. Additive; catalog-only ADD COLUMNs + an all-NULL CHECK. **APPLY-BEFORE-DEPLOY** — `findById` reads every model column on the render AND auth paths; registered as `0115-worker-verification-columns` in `schema-contract.ts` |
| `0116`        | Divyanshu | **IN REVIEW (#1561)** — `job_postings` card content: `area`, `min/max_experience_years`, `benefits`, `requirements` (all nullable, no backfill) + the two experience CHECKs mirrored from `jobs`. The V1 feed/search/detail had nothing to carry beyond title/place/pay; the converter could not carry the seed content across. **APPLY-BEFORE-DEPLOY** — the three reads name the columns unconditionally; registered as `0116-job-postings-card-columns` in `schema-contract.ts` |
| `0117`        | Prakash   | **IN REVIEW (#1593)** — #1311 backend half: `profile_correction` (one row per corrected field per profile; profile FK cascade; closed `pc_field_chk`; opaque session anchor, no values). New empty table; RLS ENABLE + hand-appended FORCE + four REVOKEs; registered as `0117-profile-correction-table` + `0117-profile-correction-rls`; listed in the e2e RLS guard. **APPLY-BEFORE-DEPLOY** — `ProfileCorrectionsRepository` names the table unconditionally on POST /profile/corrections |
| `0118`–`0121` | —         | **ROWS NEVER WRITTEN.** The register stopped being fed after `0117`; the four files exist in `meta/_journal.json` and are the authority. Recorded here so the gap is visible rather than read as "no migrations landed" |
| `0122`        | Prakash   | **MERGED (#1670, `d5c7350f`)** — #1660: `worker_resume_import.fields_extracted` (nullable integer, NULL-tolerant CHECK, no backfill). **APPLY-BEFORE-DEPLOY, and its `schema-contract.ts` entry was MISSED at merge** — `settleParsedStatement` names the column unconditionally on every parse, so a database without it stops every import at `parsing` and the worker's poll never terminates. Registered as `0122-resume-fields-extracted` by #1656's PR |
| `0123`        | Divyanshu | **MERGED (#1673, `2b49060b`)** — #1656: `worker_resume_import.degraded_posture` (nullable text; NULL-tolerant CHECK over the closed `RESUME_DEGRADED_POSTURES` set; no backfill). A spend-capped / cooled-down / kill-switched parse is now distinguishable from a genuine empty one on the row AND on `profile.resume_parsed`. CHECK deliberately NOT tied to `status` — a degraded posture is not a failure (D9). **APPLY-BEFORE-DEPLOY** — written by the SAME single guarded UPDATE as `0122`'s column, so the two fail together; registered as `0123-resume-degraded-posture` in `schema-contract.ts` |
| `0124`        | Divyanshu | **MERGED (#1695, `d8da07b5`)** — `worker_resume_import.wri_identity_role_kind_chk` widened from the 9 enabled form kinds to all 21 declared (`TRADE_FORM_KINDS_ALL`), after #1693 enabled `sheet_metal_worker` without widening it. One CHECK re-stated; no column, no data |
| `0125`        | Prakash   | **MERGED (#1692, `717e41b7`)** — ADR-0043 résumé history (renumbered from `0124` after #1695 took that slot): `generated_resumes.generation_source` (form/chat/resume_upload) + `generation_trigger` (profile_confirmed/manual/chat_update_accepted/ops_regenerate), both nullable behind NULL-tolerant CHECKs tied to `RESUME_SOURCES`/`RESUME_GENERATION_TRIGGERS`; index `generated_resumes_worker_generated_idx (worker_id, generated_at DESC, id DESC)`; `worker_profiles.seeded_from_import_id` (FK → `worker_resume_import`, ON DELETE SET NULL, backed by the PARTIAL `worker_profiles_seeded_from_import_idx` so account deletion does not seq-scan profiles) + `resume_update_accepted_at`. No backfill. Holds ACCESS EXCLUSIVE on both tables for the whole (single-transaction) apply — use `SET lock_timeout`. **APPLY-BEFORE-DEPLOY** — a bare select on either table names every model column, and both are read on hot paths (every résumé read, every profile read); registered as `0125-resume-history-*` in `schema-contract.ts` |
| `0126`        | Divyanshu | **ON BRANCH `feat/profiling-tiers` (not yet a PR)** — tiered profiling: `question_pack_item.min_tier` (nullable text, NULL-tolerant CHECK over easy/medium/hard; NULL = hard) + new table `worker_profiling_tier` (one row per worker, FK cascade, RLS ENABLE + hand-appended FORCE + four REVOKEs) + an idempotent backfill of every already-profiled worker as `hard`/`backfill`. **APPLY BEFORE THE NEXT PACK SEED AND BEFORE THE FLAG**: the API names neither object while `PROFILING_TIERS_ENABLED` is off, but `db:seed:packs --apply` writes `min_tier` unconditionally and fails (rolled back, nothing half-written) until 0126 is applied — which matters while Batch 2 packs are being seeded. Then `db:seed:packs --apply` (writes the 15 trade packs' tags in place), then the flag. Registered as `0126-question-pack-item-min-tier` + `0126-worker-profiling-tier-rls`. ⚠ Renumbered from `0125` after #1692 merged `0125_resume_history`. **Production, audited 2026-09-24:** 0126's objects are LIVE (applied by hand, so NO ledger row), and the ledger's newest row (created_at `1790238246530`, hash `06d94665…`) IS the old uncommitted `0125_profiling_tiers.sql` from an uncommitted-tree `db:migrate`. That row is the drizzle watermark, so `db:migrate` would replay `0125_resume_history` (live, not idempotent) and fail. Fix, from a tree equal to `origin/main`: `adopt-migrations.ts --only 0125_resume_history` (verifies clean), then `db:migrate` replays this idempotent 0126 and records it — and, since #1757, also 0127 in the SAME transaction (drizzle applies every pending file in one); hand-apply 0127 first to keep it out (row 0127). `adopt-migrations.ts` cannot adopt 0126 itself: it refuses `DO $$` blocks |
| `0127`        | Prakash   | **IN REVIEW (#1757)** — TD141: `job_postings_reach_ops_gin`, a GIN on `job_postings.reach_skill_ids` with the DEFAULT `jsonb_ops` opclass, beside the existing `jsonb_path_ops` `job_postings_reach_gin` (which serves only `@>`/`@?`/`@@`, never the `?|` overlap reach reconciliation, the #1240 search fallback and the ADR-0044 companion use). One idempotent `CREATE INDEX IF NOT EXISTS`; nothing dropped or altered. **OPTIONAL, NOT APPLY-BEFORE-DEPLOY**: no code names the index, so its absence is exactly today's performance; it is deliberately NOT registered in `schema-contract.ts`. Not `CONCURRENTLY`: drizzle applies EVERY pending file in ONE transaction, so from `origin/main` the 0125/0126 ledger fix's `db:migrate` runs 0126 and 0127 together — a failed index build rolls 0126 back with it, and 0126's lock on `question_pack_item` is held through the build. **To keep it separate (recommended), hand-apply it FIRST, outside drizzle:** `CREATE INDEX CONCURRENTLY IF NOT EXISTS "job_postings_reach_ops_gin" ON "job_postings" USING gin ("reach_skill_ids");` — no write lock on postings — then run the ledger fix; the replay of 0127 inside `db:migrate` is a no-op through `IF NOT EXISTS` and records the row. Verified from empty through 0127 on a scratch DB; at 200k postings the overlap goes from a parallel seq scan (~110 ms) to a bitmap scan on the new index (~5 ms) |
| `0128`        | Divyanshu | **MERGED (#1807, `3ad128ab`) — NOT YET APPLIED to production** — #1801 résumé skins, plumbing only (owner ruling 2026-09-28, "Plumbing, Neela only"): new table `worker_resume_skin` (one row per worker: `worker_id` PK → `workers` ON DELETE cascade, `skin` text NOT NULL behind `wrs_skin_chk` = `RESUME_SKINS` = `('neela')`, `updated_at`). New empty table only; RLS ENABLE + hand-appended FORCE + four REVOKEs; registered as `0128-worker-resume-skin-rls` in `schema-contract.ts`; listed in `tests/e2e/rls-spine.e2e.test.ts` LOCKED_TABLES. Plain (non-idempotent) generated DDL, so `adopt-migrations.ts` can verify it. **APPLY BEFORE THE FLAG, NOT BEFORE THE DEPLOY**: nothing names the table while `RESUME_SKINS_ENABLED` is off (the default), so a deploy ahead of it breaks no request. Order: merge → apply 0128 → `gh secret set RESUME_SKINS_ENABLED --env production`. Rollback (flag off first): `DROP TABLE "worker_resume_skin";` |
| `0129`        | Divyanshu | **SHIPS WITH #1800 (branch `feat/1800-resume-qr-scan`, after 0128) — NOT YET APPLIED to production** — #1800 résumé QR scan (owner ruling 2026-09-28, "Count + attribute worker signups"): `referral_links_kind_chk` WIDENED to admit `'resume_qr'` (DROP + ADD; every 0060 kind kept, so no row can fail the re-add) + new PARTIAL UNIQUE index `referral_links_resume_qr_owner_uq ON referral_links (owner_worker_id) WHERE kind = 'resume_qr' AND owner_worker_id IS NOT NULL` (one live résumé-QR link per worker; the render's `ON CONFLICT` target). No column, no row, no backfill. Deliberately NO `resume_qr ⇒ owner NOT NULL` CHECK (the owner FK is SET NULL on erasure; such a CHECK would abort it). Registered as `0129-referral-links-resume-qr-owner-index` in `schema-contract.ts` (SILENT failure mode). **APPLY BEFORE THE FLAG, NOT BEFORE THE DEPLOY**: no code names either object while `RESUME_QR_SCAN_ENABLED` is off, and with it on before 0129 every mint fails and the sheet falls back to the homepage QR. Hand-apply all three statements in ONE `BEGIN; SET LOCAL lock_timeout = '3s'; … COMMIT;` (retry on 55P03) — `GET /r/` reads this table. Order: merge → apply 0129 → badabhai.ai `/r/*` 302 rule → `gh secret set RESUME_QR_SCAN_ENABLED --env production`. Rollback (flag off first; only while `SELECT count(*) FROM referral_links WHERE kind = 'resume_qr'` is 0): `DROP INDEX "referral_links_resume_qr_owner_uq";` + re-add the three-kind CHECK. **After a hand-apply, verify BOTH halves** — adoption / `db:audit:schema-contract` can see the index but not a CHECK: `SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'referral_links_kind_chk';` must list all four kinds incl. `resume_qr`, and `SELECT indexdef FROM pg_indexes WHERE indexname = 'referral_links_resume_qr_owner_uq';` must show the partial predicate; then record/adopt the ledger row as for 0128 |
| `0130`        | Divyanshu | **MERGED (#1817, `66091f66`) — DDL APPLIED to production, LEDGER ROW NOT ADOPTED (read-only probe 2026-09-30: `pg_get_constraintdef` lists all five triggers incl. `chat_edit`; `drizzle.__drizzle_migrations` has no row at `when` 1790665773492 — nor for 0128/0129/0131). Owner: adopt the row (`adopt-migrations.ts --only 0130_resume_generation_trigger_chat_edit`).** **MERGE GATE for the queued `chat_edit` regeneration (branch `fix/companion-v2-lane-a`) — MET 2026-09-30 by that probe**: before it merges, run `SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'generated_resumes_generation_trigger_chk';` on production; merge only when the list includes `chat_edit`, else apply 0130 first (below) and adopt the ledger row, then record APPLIED here. Why that branch and not main: on main a missing 0130 fails the INLINE generate, so the confirm records `failed` and the worker reads the truthful `V2_EDIT_DONE_CAPPED`; with the queued generation the Haan answers `V2_EDIT_DONE` and records `resume_regen: queued` before the job fails (see the failure mode below). Nothing reaches a worker until the box's `AI_REAL_CALL_TASKS` names `companion_edit_parse` (no card is built before that), so the gate binds before whichever comes last of that merge and that append — checking before the merge is the simple rule. — ADR-0046 Phase 1 (companion v2, O6/O14): `generated_resumes_generation_trigger_chk` WIDENED to admit `chat_edit` (DROP + ADD; every 0125 trigger and NULL kept, so no stored row can fail the re-add). The companion's confirmed edit card regenerates as a NEW history entry with this trigger: the daily cap is charged on the Haan request and the generation runs as a `resume-generate` queue job (`trigger: "chat_edit"`). Registered as `0130-generated-resumes-generation-trigger-chat-edit` in `schema-contract.ts` (the CHECK's absence is SILENT to the worker and in the funnel). **APPLY BEFORE THE FLAG, NOT BEFORE THE DEPLOY**: no code writes `chat_edit` while `CHAT_COMPANION_V2_ENABLED` + `CHAT_COMPANION_V2_EDIT_ENABLED` are off. **With them on before 0130 NOTHING ROLLS BACK** (corrected; the migration header's "the confirm transaction rolls back … nothing is written" is wrong and stays unedited only to keep the ledger hash): the card's edits commit in their own transaction first, a daily-cap slot is charged and the worker is told the résumé is updating (`V2_EDIT_DONE`, event `resume_regen: queued`); the queued job then pays one model call and its `chat_edit` insert fails the CHECK (23514), which `ResumeGenerateProcessor` logs ("refused by a CHECK constraint (is migration 0130 applied?)") and does not retry — no history entry, no `resume.regenerated` event, the PDF unchanged. Hand-apply BOTH statements in ONE `BEGIN; SET LOCAL lock_timeout = '3s'; ... COMMIT;` (retry on 55P03). Rollback: a CODE rollback needs no schema change (the widened CHECK admits every value an older build writes). A SCHEMA rollback (flags off first, then re-add the four-trigger CHECK) is valid only while no `chat_edit` row exists — check `SELECT count(*) FROM generated_resumes WHERE generation_trigger = 'chat_edit';` is 0. Turning the flag off does not remove rows, and every regenerated edit writes one, so once the flag has been on with 0130 applied the re-add fails validation and the rollback needs an owner decision (relabel those rows, or re-add the old CHECK `NOT VALID`); the migration header's "flag off first, so no chat_edit row can exist" does not hold then. **Adoption / `db:audit:schema-contract` can see the constraint but not its WIDENED TEXT**: after a hand-apply verify with `SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'generated_resumes_generation_trigger_chk';` that all five triggers are listed, then record/adopt the ledger row as for 0128 |
| `0131`        | Prakash   | **MERGED (#1840, `516a495a`) — COLUMNS PRESENT in production (CHECK text unverified), LEDGER ROW NOT ADOPTED.** The read-only probe of 2026-10-01 (#1823) found `role_kind` as a column on both `jobs` and `job_postings` in `information_schema.columns`. That probe did not read the CHECK text or the drizzle ledger; the 2026-09-30 probe (row 0130) found no ledger row for 0131. Owner: verify the CHECK text (query below), then adopt the row (`adopt-migrations.ts --only 0131_job_role_kind`). _Corrected 2026-10-01; this row said "ON BRANCH `feat/job-role-kind` (web-redesign Phase 2 PR-A) — NOT YET APPLIED to production"._ — owner ruling 2026-09-29 ([ADR-0036 addendum](docs/decisions/0036-matching-algorithm-v1.md)): `job_postings.role_kind` + `jobs.role_kind`, nullable text (no default, no backfill) behind NULL-tolerant `job_postings_role_kind_chk` / `jobs_role_kind_chk` over the 21 declared kinds (`TRADE_FORM_KINDS_ALL`, spelled out). Display / classification only — never a match or rank input, on no worker read (#1823). Journal `when` `1790687181089` (> 0130's `1790665773492`). Registered as `0131-job-postings-role-kind` + `0131-jobs-role-kind` in `schema-contract.ts`. **APPLY-BEFORE-DEPLOY** — bare `select()`/`.returning()` in `JobPostingsRepository` (every payer/ops posting route, incl. the chat publish's create), `AgencyJobsRepository` (every agency job route) and `ApplicationsRepository.findJobById` (the worker's legacy apply/skip path, MATCH_V1_ENABLED off) name every model column, so a build ahead of the migration 500s all of them. Plain generated DDL (two `ADD COLUMN`, two `ADD CONSTRAINT`), so `adopt-migrations.ts` can verify it. Hand-apply all four statements in ONE `BEGIN; SET LOCAL lock_timeout = '3s'; … COMMIT;` (retry on 55P03) — both tables are on hot read paths. Order: merge → apply 0131 → adopt the ledger row (`adopt-migrations.ts --only 0131_job_role_kind`) → `db:audit:schema-contract` → approve the deploy. **After a hand-apply verify the CHECK text too** (the audit sees the columns, not the list): `SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conname IN ('job_postings_role_kind_chk','jobs_role_kind_chk');` must list all 21 kinds on both. Rollback: a code rollback needs no schema change (an older build never names the columns); a schema rollback destroys every stored pick — see the migration header |
| `0132`        | Prakash   | **MERGED (#2059, `67338e91`) — APPLIED to production BY HAND (owner, 2026-10-07, SQL editor; verified: `unlocks.job_posting_id` uuid NULL + FK `unlocks_job_posting_id_job_postings_id_fk`) — LEDGER ROW NOT ADOPTED. Owner: adopt the row together with 0133 (`npx tsx adopt-migrations.ts --only 0132_unlocks_job_posting_id,0133_agency_twin_match_skills --apply --expect-host <prod host>` from `packages/db`).** _Corrected 2026-10-07; this row said "ON BRANCH `claude/2033-payer-unlocks-visible` (#2033) — NOT YET APPLIED"._ — `unlocks.job_posting_id` uuid NULL (no default, no backfill) + FK `unlocks_job_posting_id_job_postings_id_fk` → `job_postings.id` ON DELETE SET NULL — the company-posting twin of `unlocks.job_id` (which can only hold a `jobs` id, #1903). Written by the payer-session unlock path for an OWNED posting; on no event. Registered as `0132-unlocks-job-posting-id` in `schema-contract.ts`. **APPLY-BEFORE-DEPLOY** — `UnlocksRepository`'s bare `select()`/`.returning()` name every model column, so a build ahead of the migration 500s every unlock request, reveal and unlock list (ops and payer). Plain generated DDL (one `ADD COLUMN`, one `ADD CONSTRAINT`), so `adopt-migrations.ts` can verify it. Hand-apply both statements in ONE `BEGIN; SET LOCAL lock_timeout = '3s'; … COMMIT;` (retry on 55P03) — the FK locks `job_postings` (SHARE ROW EXCLUSIVE). Order: merge → apply 0132 → adopt the ledger row (`adopt-migrations.ts --only 0132_unlocks_job_posting_id`) → `db:audit:schema-contract` → approve the deploy. Rollback: a code rollback needs no schema change; a schema rollback destroys stored posting context — see the migration header |
| `0133`        | Prakash   | **MERGED (#2055, `11b4afc6`) — APPLIED to production BY HAND (owner, 2026-10-07, SQL editor; verified: `jobs.match_skill_ids` jsonb default `'[]'`, `job_postings.sync_source` text, `job_postings_sync_source_chk` + `job_postings_twin_owner_chk` + `jobs_match_skill_ids_array_chk` present) — LEDGER ROW NOT ADOPTED. Renumbered from 0132 (slot taken by #2059's `0132_unlocks_job_posting_id`); the statements are byte-identical to what was applied. Owner: adopt the row together with 0132 (`npx tsx adopt-migrations.ts --only 0132_unlocks_job_posting_id,0133_agency_twin_match_skills --apply --expect-host <prod host>` from `packages/db`).** _Corrected 2026-10-07; this row said "owner, 2026-10-06" and named an `--only 0133_agency_twin_match_skills` adoption without `--apply --expect-host`._ [ADR-0050](docs/decisions/0050-agency-inventory-v1-twin.md) §4.1 / §6.1 step 1 (#1957): `jobs.match_skill_ids jsonb NOT NULL DEFAULT '[]'` + `jobs_match_skill_ids_array_chk` (`jsonb_typeof = 'array'`) — the agency job's explicit match input (C4; `[]` = not chosen yet); `job_postings.sync_source text NULL` + `job_postings_sync_source_chk` (NULL or `'agency_job'`) — the derived-twin marker; `job_postings_twin_owner_chk` (`sync_source IS NULL OR (source_job_id IS NOT NULL AND payer_id IS NULL)`) — C2 in the DB. No index (the twin link reuses `job_postings_source_job_id_uq`). Nothing writes either column yet. Journal `when` `1791350164227` (> 0132's `1791293023546`). Registered as `0133-jobs-match-skill-ids` + `0133-job-postings-sync-source` in `schema-contract.ts`. **APPLY-BEFORE-DEPLOY** — same bare-`select()` readers as 0131 (`JobPostingsRepository`, `AgencyJobsRepository`, `ApplicationsRepository.findJobById`). Plain generated DDL (two `ADD COLUMN`, three `ADD CONSTRAINT`), so `adopt-migrations.ts` can verify it. Hand-apply all five statements in ONE `BEGIN; SET LOCAL lock_timeout = '3s'; … COMMIT;` (retry on 55P03). Order: merge → apply 0133 → adopt the ledger row (`adopt-migrations.ts --only 0133_agency_twin_match_skills`) → `db:audit:schema-contract` → approve the deploy. Rollback: a code rollback needs no schema change; the CHECKs drop without data loss; a column drop destroys stored agency match-skill picks — see the migration header                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `0134`        | Prakash   | **ON BRANCH `feat/api-applicant-stages` (PR pending) — NOT YET APPLIED anywhere.** Owner ruling 2026-10-07: the payer applicant pipeline board (New / Shortlist / Passed) saved server-side. New table `payer_applicant_stages`: `posting_kind` text NOT NULL behind `payer_applicant_stages_posting_kind_chk` (`company_posting`/`agency_job`), `posting_id` uuid NOT NULL (NO FK — names a `jobs` or `job_postings` row by kind), `worker_id` → `workers` ON DELETE cascade, `stage` text NOT NULL behind `payer_applicant_stages_stage_chk` (`new`/`shortlist`/`passed`; no row = `new`, a row moved back stores `new`), `actor_payer_id` uuid NOT NULL (the acting login that last moved the row — ADR-0053 §3.1; no FK, never an access rule), `created_at`/`updated_at`; composite PK `(posting_kind, posting_id, worker_id)` (natural key, upsert target, both reads' index) + `payer_applicant_stages_worker_id_idx` (backs the cascade). **No tenant column** (ADR-0053 §4, class C "via parent"): access is the posting-ownership chokepoint (`findOwnedJobRef`), so the board becomes org-scoped at the PAY-DB-01 flip with no change of its own. RLS ENABLE + hand-appended FORCE + four REVOKEs; registered as `0134-payer-applicant-stages-rls` in `schema-contract.ts`; in `tests/e2e/rls-spine.e2e.test.ts` LOCKED_TABLES. Journal `when` `1791438567323` (> 0133's `1791350164227`; regenerated 2026-10-08 for the column rename — never applied anywhere before). Plain generated DDL, so `adopt-migrations.ts` can verify it. Verified from an EMPTY database (pgvector pg16 + Supabase roles, all 135 migrations via `drizzle-kit migrate`). **APPLY BEFORE THE FLAG, NOT BEFORE THE DEPLOY**: nothing names the table while `PAYER_APPLICANT_STAGES_ENABLED` is off (the default). `db:audit:schema-contract` reports `0134-payer-applicant-stages-rls` missing on any database that has not applied it — expected until step 3; apply 0134 before approving the merge's production deploy if you want that audit clean at deploy time. Order: (1) merge → (2) run `adopt-migrations.ts` verify-only with NO `--only`, and adopt every clean entry below 0134 (0128–0133) in one run; any entry that fails verification must be APPLIED first — once a later row is recorded, `db:migrate` skips every journal entry below MAX(created_at), applied or not (`adopt-migrations.ts` itself can still record rows below the watermark) → (3) apply 0134 in ONE `BEGIN; SET LOCAL lock_timeout = '3s'; … COMMIT;` (the FK takes SHARE ROW EXCLUSIVE on `workers`; retry on 55P03) → (4) adopt the 0134 ledger row (`adopt-migrations.ts --only 0134_payer_applicant_stages --apply --expect-host <prod host>`) and run `db:audit:schema-contract` → (5) `gh secret set PAYER_APPLICANT_STAGES_ENABLED --env production --body true` → redeploy. Flag on WITHOUT the table 500s both payer applicant feeds. **Rollback**, in order (the flag is read at boot): set the flag false → REDEPLOY → confirm the feeds no longer carry `stage` → in ONE transaction, retrying on 55P03: `BEGIN; SET LOCAL lock_timeout = '3s'; DROP TABLE "payer_applicant_stages"; DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1791438567323; COMMIT;` — the DROP removes the FK's RI triggers on `workers` and so takes ACCESS EXCLUSIVE on `workers`; loses every saved board |
| `0135`        | Divyanshu | **ON BRANCH `feat/2297-companion-history` (PR pending) — NOT YET APPLIED anywhere.** #2297 (owner rulings 2026-10-15, [ADR-0056](docs/decisions/0056-bada-bhai-chat-history.md)): the Bada Bhai chat keeps its conversation on the server for 7 days, plus a rolling summary for its AI. Two new tables. `companion_messages`: `id` uuid PK, `worker_id` → `workers` ON DELETE cascade, `role` text NOT NULL behind `companion_messages_role_chk` (`worker`/`bada_bhai`), `body_text` text NOT NULL, `tts_text`, `read_aloud`, `suggested_options`/`suggested_followups`/`news_links` jsonb, `submission_id` uuid, `model_context` boolean NOT NULL DEFAULT false (the lines a later model call may read; never a distress or trash turn), `created_at`; `companion_messages_worker_created_idx` (`worker_id`, `created_at` DESC NULLS FIRST) + partial unique `companion_messages_submission_uq` (`worker_id`, `submission_id`, `role`) WHERE `submission_id` IS NOT NULL (a replayed submission inserts nothing). `companion_conversation_summaries`: `worker_id` uuid PK → `workers` ON DELETE cascade, `summary` text NULL (null = watermark-only record, ADR-0051 §8), `folded_through` timestamptz NOT NULL, `updated_at`. Text at rest like `chat_messages.body_text`. RLS ENABLE + hand-appended FORCE + four REVOKEs on each; registered as `0135-companion-messages-rls` + `0135-companion-conversation-summaries-rls` in `schema-contract.ts`; both in `tests/e2e/rls-spine.e2e.test.ts` LOCKED_TABLES. Journal `when` `1792067253821` (> 0134's `1791438567323`). Plain generated DDL plus the RLS tail. **APPLY AFTER THE DEPLOY, AT ANY TIME — NO FLAG**: every read and write tolerates `undefined_table` (42P01), so until it is applied the chat has no history and behaves exactly as before (one warn line per API process). **Owner sequence — applies ONLY 0135 and records ONLY its ledger row** (rehearsed on a local copy with 0134 deliberately unapplied: 0134 stayed unapplied and unrecorded). From the MAIN checkout on a clean tree at origin/main after the merge; `DATABASE_URL` is never typed or printed — `adopt-migrations.ts` and `audit-schema-contract.ts` load it from the repo-root `.env` and print only the host. (1) read-only pre-check, from `packages/db`: `npx tsx adopt-migrations.ts --only 0135_companion_history` — note the printed `[adopt] target host=<HOST>`; it reports 0135 MISSING and exits 1 (expected, nothing applied yet) → (2) Supabase SQL Editor (production), one query: `BEGIN; SET LOCAL lock_timeout = '3s';` + the full, unedited contents of `packages/db/migrations/0135_companion_history.sql` + `COMMIT;` — on 55P03 nothing was applied, run it again → (3) read-only verify: `npx tsx adopt-migrations.ts --only 0135_companion_history` → `✓ 0135_companion_history`, `clean=1 mismatched=0` → (4) record ONLY 0135: `npx tsx adopt-migrations.ts --only 0135_companion_history --apply --expect-host <HOST>` → `recorded 1 of 1` → (5) `pnpm db:audit:schema-contract` (from `packages/db`) → both `0135_companion_history rls …` OK. `--only` never verifies, applies or records a lower entry, so migrations kept dark on purpose (0128/0129/0134) are untouched. NEVER run `pnpm db:migrate` against production (it would apply every unrecorded entry above the watermark, dark ones too); after step 4 the watermark is 0135's, so `db:migrate` would skip any lower unrecorded entry — apply each of those later the same way (by hand, then `--only <its tag>`). No flag and no redeploy. **Rollback** (no code change needed first): in ONE transaction, retrying on 55P03: `BEGIN; SET LOCAL lock_timeout = '3s'; DROP TABLE "companion_messages"; DROP TABLE "companion_conversation_summaries"; DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1792067253821; COMMIT;` — loses every stored conversation and summary |
| `0136`–`0160` | —         | **ROWS NEVER WRITTEN.** The register stopped being fed after `0135`; the files exist in `meta/_journal.json`, which is the authority. Recorded so the gap reads as a gap, not as "no migrations landed" |
| `0161`        | Divyanshu | **#2752 Part B (PR #2795, branch `feat/2752-institute-link-schema`)** — `worker_institute_links` + `worker_origins`. See that file's header; APPLY BEFORE THE CAMPUS LINK FLAG. Row written by #2746 so the slot reads as taken |
| `0162`        | Divyanshu | **ON BRANCH `feat/2746-job-audience-schema`, stacked on 0161 — NOT YET APPLIED anywhere.** #2746: `job_postings.audience` (`badabhai_workers`/`rvm_students`/`both`, default `badabhai_workers`) + `rvm_branch_ids` / `rvm_course_ids` (jsonb, `[]` = all; shape-checked) + 3 CHECKs (closed set; agency twins stay `badabhai_workers`; targeting only on an RVM audience); `payers.is_test_account`; four new tables, each RLS ENABLE + hand-appended FORCE + four REVOKEs: `job_posting_institute_reviews` (THE review store, owner ruling 2026-11-13 — no `rvm_review_*` columns; drives Campus's feed), `rvm_targeting_options`, `campus_drive_requests` (contact name/phone AES, erasable, rotation targets registered), `feature_pilot_payers` (with `added_by` + `reason`). **APPLY-BEFORE-MERGE** — production deploys on every push with no approval, and bare selects on `job_postings` and `payers` name the new columns. `when` = `1794575613179`. Order (header): 0161 first → `adopt-migrations.ts` verify-only (nothing unrecorded below 0161) → apply by hand → `npx tsx adopt-migrations.ts --only 0162_job_audience_campus_drives --apply --expect-host <HOST>` from the PR-head tree → `db:audit:schema-contract` → merge at once. Rollback in the header (hide RVM-only postings first). Eight `0162-*` entries in `schema-contract.ts` (#2746 PR 4 adds `job_posting_institute_reviews` as a `table` entry: every company posting edit and both admin posting reads name it with no switch); tables in the e2e RLS guard |
| `0164`        | Divyanshu | **ON BRANCH `feat/2820-theme-rollout` (PR pending) — NOT YET APPLIED anywhere.** #2820: new table `feature_pilot_subjects`, the pilot list for workers and admins behind the `*_ROLLOUT` switches (`THEME_ROLLOUT` first): `feature` (`fps_feature_chk`, the same rule as `fpp_feature_chk`), `subject_kind` (`worker`/`admin`, `fps_subject_kind_chk`), `subject_id` uuid (`workers.id` / `admin_users.id`), `added_by` + `reason` (the 0162 CHECKs), `created_at`; PK `(feature, subject_kind, subject_id)`. **No FK** (one column names a row in one of two tables, and a pilot row must never block a worker's DPDP erasure or an admin's deletion). Companies stay on `feature_pilot_payers`. RLS ENABLE + hand-appended FORCE + four REVOKEs; registered as `0164-feature-pilot-subjects-rls` in `schema-contract.ts` (no `table` entry: nothing names it unswitched); in `tests/e2e/rls-spine.e2e.test.ts` LOCKED_TABLES. `when` = `1794726943864` (> 0163's `1794643462491`). **APPLY-BEFORE-PILOT, NOT BEFORE MERGE OR DEPLOY**: nothing reads the table while the switch is `off` or `on`, and in `pilot` a missing table answers "not listed" (42P01, fails closed, no 500). Order (header): merge → adopt 0161, 0162 and 0163 first (live in production, ledger rows still pending), after `adopt-migrations.ts` verify-only shows nothing else unrecorded below 0164 → apply by hand in one transaction → `npx tsx adopt-migrations.ts --only 0164_feature_pilot_subjects --apply --expect-host <HOST>` → `db:audit:schema-contract` → then add pilot rows and set the switch to `pilot`. Rollback: `THEME_ROLLOUT=off` + redeploy; the table DROP and ledger delete are in the header |
| `0165`        | Divyanshu | **ON BRANCH `feat/2819-display-prefs`, stacked on 0164 (PR pending) — NOT YET APPLIED anywhere.** #2819: new table `display_prefs`, one login's theme: `subject_kind` (`worker`/`payer_user`/`admin`, `display_prefs_subject_kind_chk`), `subject_id` uuid (`workers.id` / `payers.id` — the LOGIN, never the tenant key / `admin_users.id`), `theme` (`light`/`dark`/`system`, `display_prefs_theme_chk`, default `light`; no row also means `light`), `created_at`, `updated_at`; PK `(subject_kind, subject_id)`. **No FK** (one column names a row in one of three tables). **No erasure path names it yet** (#2837, risk R88: naming it in `hardDelete` before this migration is applied would roll every worker erasure back on 42P01). RLS ENABLE + hand-appended FORCE + four REVOKEs; registered as `0165-display-prefs-rls` in `schema-contract.ts` (no `table` entry: nothing names it unswitched); in `tests/e2e/rls-spine.e2e.test.ts` LOCKED_TABLES. `when` = `1794729354323` (> 0164's `1794726943864`). **APPLY-BEFORE-PILOT, NOT BEFORE MERGE OR DEPLOY**: the api reads and writes the table only for a login `THEME_ROLLOUT` is open for, and a missing table or column (42P01 / 42703) answers light / `theme_open: false` on GET and a 404 on PATCH (fails closed, no 500). Order (header): merge → **0164 applied AND its ledger row adopted first** (adopting 0165 while 0164 is unrecorded moves the watermark past 0164, and `db:migrate` then never applies it), so adopt in order: 0161–0163, then 0164 (its own header), then this one → `adopt-migrations.ts` verify-only (nothing unrecorded below 0165) → apply by hand in one transaction → `npx tsx adopt-migrations.ts --only 0165_display_prefs --apply --expect-host <HOST>` → `db:audit:schema-contract` → then add pilot rows and set the switch to `pilot`. Rollback: `THEME_ROLLOUT=off` + redeploy; the table DROP and ledger delete are in the header |
| `0166`        | Divyanshu | **PR #2846 (branch `feat/2747-outcome-stages`), regenerated on top of #2820's 0164 and #2819's 0165 (both on main) — NOT YET APPLIED anywhere.** #2747 item 7: `payer_applicant_stages_stage_chk` WIDENED to admit `selected` and `hired` (DROP + ADD; every 0134 stage kept, so no stored row can fail the re-add). No column, no index, no row. **APPLY BEFORE THE SWITCH, NOT BEFORE THE DEPLOY**: the only write that needs it is refused with a `400` while `OUTCOME_STAGES_ROLLOUT` is off. Hand-apply both statements in ONE `BEGIN; SET LOCAL lock_timeout = '3s'; … COMMIT;` (retry on 55P03). **Verify the CHECK text** (adoption and `db:audit:schema-contract` see the constraint, not its list): `SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'payer_applicant_stages_stage_chk';` must list all five stages. Not registered in `schema-contract.ts`: the constraint exists before and after, so the audit cannot tell them apart. Ledger adoption order: 0164, 0165, then 0166 (its `when` is above 0165's). Rollback in the header |
| `0167`        | Divyanshu | **PR #2848 (branch `feat/2747-outbound-signals`), regenerated on top of 0166 — NOT YET APPLIED anywhere.** #2747 item 8: new table `outbound_signals`. It holds a mark BadaBhai owes RVM: ids, closed codes and dates only, with a unique `dedupe_key`. The worker FK cascades, and it has a partial due index. RLS ENABLE plus hand-appended FORCE and the four REVOKEs. Written in the stage transaction and sent by the `outbound-signals` sweep. **APPLY BEFORE THE SWITCH, NOT BEFORE THE DEPLOY**: nothing names the table while `OUTBOUND_SIGNALS_ROLLOUT` is off. With the switch on before 0167, a company's selected or hired marks on RVM students fail (42P01), roll back and answer 500. Registered as `0167-outbound-signals-rls` in `schema-contract.ts` and listed in the e2e RLS guard. Ledger adoption order: 0164, 0165, 0166, then 0167. Rollback in the header (`DROP TABLE`, switch off first) |
| `0168`        | Divyanshu | **ON BRANCH `feat/2753-worker-activity` (PR pending), on top of 0167 — NOT YET APPLIED anywhere. The slot may move: if another 0168 (e.g. #2749 `0168_credit_lots`) merges first, this one is regenerated above it.** #2753 items 4 and 7: new table `worker_activity`, the days a worker was active. One row per worker per IST day (`active_on` date), PRIMARY KEY (`worker_id`, `active_on`): the write's idempotency and the read's index, whose `worker_id` prefix also backs the worker FK cascade (the erasure). Ids and dates only: no route, IP, device or time of day. Written by `WorkerActivityInterceptor` (any signed-in worker request) and a Campus application, fire-and-forget; read as the later of its newest day and the IST day of the newest device sighting, so no backfill. RLS ENABLE plus hand-appended FORCE and the four REVOKEs. **APPLY BEFORE THE SWITCH, NOT BEFORE THE DEPLOY**: nothing names the table while `WORKER_ACTIVITY_ENABLED` is off. With the switch on before 0168 nothing answers 500: the activity writes are lost silently, and the reads catch 42P01 and fall back to the device day (the IST day of the newest `worker_devices.last_seen_at`), so a company's applicant lists, inbox and candidate search and an agency's referred-workers list keep working and the mark is computed from that day. One warning per API process names the migration. The days lost before the apply are lost for good, which is why it still goes in first. Hand-apply in ONE `BEGIN; SET LOCAL lock_timeout = '3s'; … COMMIT;` (the FK takes SHARE ROW EXCLUSIVE on `workers`; retry on 55P03). Registered as `0168-worker-activity-rls` in `schema-contract.ts` and listed in the e2e RLS guard. Ledger adoption order: 0164, 0165, 0166, 0167, then 0168. The owner applies it, then sets `gh secret set WORKER_ACTIVITY_ENABLED --env production --body true` and redeploys. Rollback in the header (`DROP TABLE`, switch off and redeploy first) |
| `0169`        | Divyanshu | **ON BRANCH `feat/2753-leave-search` (PR pending), regenerated on top of #2857's 0168 (`0168_worker_activity`) — NOT YET APPLIED anywhere.** #2753 item 6: new table `worker_search_exits`, a worker who left company search. `worker_id` uuid PRIMARY KEY (one exit per worker; the FK to `workers` cascades, and the primary key's index backs it), `hidden_at` timestamptz NOT NULL default now(), `via` text NOT NULL (`worker_search_exits_via_chk`: `worker`/`monthly_check`). Ids, a time and a closed code only. A side table rather than a `workers.search_hidden_at` column, so it is not an ALTER on a hot table. RLS ENABLE plus hand-appended FORCE and the four REVOKEs. **APPLY BEFORE THE SWITCH, NOT BEFORE THE DEPLOY** (owner applies it before setting `SEARCH_EXIT_ENABLED`): nothing names the table while the switch is off. With the switch on before 0169 nothing answers 500: the readers FAIL OPEN (nobody can be hidden without the table) — company search, its city facet and the admin candidate card re-run the switch-off statement on 42P01 (one warning per process), and the unlock gate probes `to_regclass` first so its transaction is never aborted — while the two `/workers/me/search-visibility` routes (the write path) answer 503. The FK takes SHARE ROW EXCLUSIVE on `workers`: apply in one `BEGIN; SET LOCAL lock_timeout = '3s'; … COMMIT;` and retry on 55P03. Registered as `0169-worker-search-exits-rls` in `schema-contract.ts` and listed in the e2e RLS guard. Ledger adoption order: 0164, 0165, 0166, 0167, 0168, then 0169. Rollback in the header (`DROP TABLE`, switch off first). If #2749's migration merges first, this regenerates again |
| `0170`        | Divyanshu | **Branch `feat/2753-hire-records` (PR pending), regenerated on top of 0169 (`0169_worker_search_exits`) — NOT YET APPLIED anywhere.** #2753 item 9: new table `hires`, one hire record per company, worker and posting: `tenant_payer_id` (the company's tenant key, FK `payers` ON DELETE CASCADE), `worker_id` (FK `workers` ON DELETE CASCADE, indexed), `posting_kind` (`hires_posting_kind_chk`) + `posting_id` (no FK), `status` (`reported`/`confirmed`/`rejected`, `hires_status_chk`), one timestamp per source (`company_marked_at`, `company_answered_at`, `worker_answered_at`, `desk_confirmed_at`), `hired_on` (date), `created_at`, `updated_at`; UNIQUE `hires_tenant_worker_posting_uq` (tenant, worker, posting kind, posting id). Ids, dates and closed codes only. RLS ENABLE plus hand-appended FORCE and the four REVOKEs. **APPLY BEFORE THE SWITCH, NOT BEFORE THE DEPLOY**: nothing names the table while `HIRE_RECORDS_ENABLED` is off. With the switch on before 0170, a company's move into or out of `hired` fails (42P01), rolls back and answers 500, and `GET /admin/hires` answers 500. Two FKs: hand-apply in ONE `BEGIN; SET LOCAL lock_timeout = '3s'; … COMMIT;` and retry on 55P03 (SHARE ROW EXCLUSIVE on `payers` and `workers`). Registered as `0170-hires-rls` in `schema-contract.ts` and listed in the e2e RLS guard. Ledger adoption order: 0164 to 0169, then 0170. Rollback in the header (`DROP TABLE`, switch off first) |
| `0171`        | Divyanshu | **ON BRANCH `feat/2753-pay-on-joining`, regenerated on top of 0170 (`0170_hires`, #2753 part H) — NOT YET APPLIED anywhere.** #2753 item 11: new table `pay_on_joining_hires`, the pay-on-joining pilot's record, one row per hire, written by hand by an admin. Ids (factory and partner payers, worker, optional posting), calendar dates, the fee, the partner's percent (COPIED from `POJ_PARTNER_SHARE_PERCENT` at create) and the share (the server's floor, pinned by `pay_on_joining_hires_share_math_chk`) in integer paise (bigint), and one capped admin `note`. UNIQUE NULLS NOT DISTINCT (factory, worker, posting). Factory FK CASCADE, partner and posting SET NULL, worker CASCADE (indexed). RLS ENABLE plus hand-appended FORCE and the four REVOKEs. **APPLY BEFORE THE SWITCH, NOT BEFORE THE DEPLOY**: nothing names the table while `PAY_ON_JOINING_RECORDS_ENABLED` is off (every route a 404). With the switch on before 0171, the list and both writes fail (42P01) and answer 500; nothing is written. Hand-apply in ONE `BEGIN; SET LOCAL lock_timeout = '3s'; … COMMIT;` (four FKs lock `payers`, `job_postings`, `workers`). `when` = `1794816818877`. Registered as `0171-pay-on-joining-hires-rls` in `schema-contract.ts` and listed in the e2e RLS guard. Ledger adoption order: 0164 to 0170 in slot order, then 0171. Rollback in the header (`DROP TABLE`, switch off first, export the records before) |
| `0172`        | Divyanshu | **Branch `feat/2753-unlock-outcomes` (PR pending), regenerated on top of 0171 (`0171_pay_on_joining_hires`, #2753 part I) — NOT YET APPLIED anywhere.** #2753 item 10, the company follow-up: new table `unlock_outcomes`, one answer per opened contact: `unlock_id` (PRIMARY KEY, FK `unlocks` ON DELETE CASCADE), `tenant_payer_id` (the unlock's own `payer_id`, the tenant key; no FK, as on `unlocks.payer_id`), `worker_id` (FK `workers` ON DELETE CASCADE, indexed), `outcome` (`hired`/`not_hired`/`still_talking`/`not_reached`, `unlock_outcomes_outcome_chk`), `answered_by` (`company`/`desk`, `unlock_outcomes_answered_by_chk`), `answered_at`, `updated_at`; index `unlock_outcomes_tenant_answered_idx` (tenant_payer_id, answered_at). A later answer replaces the earlier one; the history is the `unlock.outcome_recorded` events. "Due" is computed at read time, so nothing is backfilled. Ids, dates and closed codes only. RLS ENABLE plus hand-appended FORCE and the four REVOKEs. **APPLY BEFORE THE SWITCH, NOT BEFORE THE DEPLOY**: nothing names the table while `UNLOCK_FOLLOWUP_ENABLED` is off. With the switch on before 0172, the due list and every answer fail (42P01) and answer 500; nothing is written. Two FKs: hand-apply in ONE `BEGIN; SET LOCAL lock_timeout = '3s'; … COMMIT;` and retry on 55P03 (SHARE ROW EXCLUSIVE on `unlocks` and `workers`). Registered as `0172-unlock-outcomes-rls` in `schema-contract.ts` and listed in the e2e RLS guard. Ledger adoption order: 0164 to 0171, then 0172. Rollback in the header (`DROP TABLE`, switch off first) |
| `0173`        | Divyanshu | **Branch `feat/2753-still-looking` (stacked on `feat/2753-unlock-outcomes`, PR pending), on top of 0172 (`0172_unlock_outcomes`, #2753 part L) — NOT YET APPLIED anywhere.** #2753 item 5, the monthly "still looking?" check: new table `still_looking_checks`, one row per prompt: `id` uuid PK, `worker_id` (FK `workers` ON DELETE CASCADE), `prompted_at` timestamptz NOT NULL, `answered_at` timestamptz, `answer` (`yes`/`not_now`/`hired`, `still_looking_checks_answer_chk`), `created_at`; `still_looking_checks_answered_chk` keeps `answer` and `answered_at` together; partial UNIQUE `still_looking_checks_open_uq` (worker_id WHERE answered_at IS NULL: one open check per worker, the sweep's insert guard); index `still_looking_checks_worker_prompted_idx` (worker_id, prompted_at), which also backs the cascade. Ids, times and a closed code only. RLS ENABLE plus hand-appended FORCE and the four REVOKEs. `when` = `1794818158596` (> 0172's `1794817356838`). **APPLY BEFORE THE SWITCH, NOT BEFORE THE DEPLOY**: nothing names the table while `STILL_LOOKING_CHECK_ENABLED` is off (both routes 404, the daily sweep reads nothing). With the switch on before 0173, both routes answer 503 and the sweep logs one warning per process and opens nothing; nothing is written. One FK: hand-apply in ONE `BEGIN; SET LOCAL lock_timeout = '3s'; … COMMIT;` and retry on 55P03 (SHARE ROW EXCLUSIVE on `workers`). Registered as `0173-still-looking-checks-rls` in `schema-contract.ts` and listed in the e2e RLS guard. Ledger adoption order: 0164 to 0172, then 0173. Rollback in the header (`DROP TABLE`, switch off first) |
| `0174`        | Divyanshu | **APPLIED IN PRODUCTION 2026-11-17 by hand before #2863 merged (read-back: 4 wallets with credits = 4 legacy lots, 197 credits in balances = 197 in lots), and recorded in the ledger by `owner-db-ledger.yml` run 44020951255 (0164–0174, 0174 last).** New table `credit_lots` (a wallet's balance as lots: `source` behind `credit_lots_source_chk` = `CREDIT_LOT_SOURCES`, granted > 0, 0 ≤ remaining ≤ granted, expired ⇒ empty, partial UNIQUE one lot per paid order, two partial open-lot indexes; RLS ENABLE plus hand-appended FORCE and the four REVOKEs) + `credit_ledger.lot_id` (nullable FK, indexed) + an in-file backfill of one `legacy` lot per positive balance. **APPLY BEFORE DEPLOY, FROM THE PR BRANCH BEFORE THE MERGE** — Drizzle names `lot_id` in every ledger insert. **Adopt with `--only <tag>`, or after the pending lower migrations** (see the section: an unpinned adoption silently skips any of 0164–0173 still pending). Statement order is hand-written (payment_orders FK and backfill before the credit_ledger statements). Registered as `0174-credit-lots-table`, `0174-credit-ledger-lot-id`, `0174-credit-ledger-lot-fk`, `0174-credit-lots-rls`; listed in the e2e RLS guard. See the `0174` section below |
| `0175`        | Divyanshu | **MERGED (#2873, #2754 item 3, after #2816) — NOT YET APPLIED to production. Kept at 0175: it merged first (main and the production ledger both ended at `0174_credit_lots` on 2026-11-17), so #2872's `0175_payment_order_money` (#2749 part 3) regenerates above it as the next free slot.** New table `payer_phone_proofs`, a company proved the phone on its account: `payer_id` uuid PRIMARY KEY (FK `payers` ON DELETE CASCADE: one proof per account, erased with it), `phone_hash` text NOT NULL (the same keyed `hashPhone` HMAC as `payers.phone_hash`; never the number), `method` (`sms_code`/`campus_import`, `payer_phone_proofs_method_chk`), `proven_at` timestamptz default now(); UNIQUE `payer_phone_proofs_phone_hash_uq` (phone_hash): only ONE account can ever hold a proven phone, so an SMS sign-in never lands in the wrong account. A phone is a sign-in credential only while a proof holds the account's CURRENT `payers.phone_hash`; a phone change drops the proof in the same transaction. Nothing is backfilled; NO unique index on `payers.phone_hash` (production may hold duplicates: run the read-only `report:shared-payer-phones`, resolve each by hand, then add the payers-level index as a later owner step). RLS ENABLE plus hand-appended FORCE and the four REVOKEs. **APPLY BEFORE THE SWITCH, NOT BEFORE THE DEPLOY**: every read fails closed on 42P01 (no phone counts as proven, SMS sign-in sends nothing, the proof routes answer 503, a phone change still succeeds). One FK: hand-apply in ONE `BEGIN; SET LOCAL lock_timeout = '3s'; … COMMIT;` and retry on 55P03 (SHARE ROW EXCLUSIVE on `payers`). Registered as `0175-payer-phone-proofs-rls` in `schema-contract.ts` (renumber with the slot) and listed in the e2e RLS guard. Ledger adoption order: every lower slot first. Rollback in the header (`DROP TABLE`, switch off first) |
| `0176`        | Divyanshu | **ON BRANCH `feat/2749-checkout` (#2749 PR 3) — NOT YET APPLIED anywhere.** `payment_orders` gains, all additive: `product_kind` (NOT NULL DEFAULT `credit_pack`, `payment_orders_product_kind_chk` = `PAYMENT_ORDER_PRODUCT_KINDS`), the GST line in paise `taxable_paise` / `gst_paise` / `round_off_paise` / `total_paise` / `gst_rate_bps` (nullable: all five or none, `payment_orders_money_set_chk`; total = taxable + GST + round-off, a positive whole rupee equal to `amount_inr` × 100, `payment_orders_money_sum_chk`), `credit_validity_days` (nullable, > 0), `origin` (nullable, `payment_orders_origin_chk` = `PAYMENT_ORDER_ORIGINS`) and `origin_job_posting_id` (nullable FK `job_postings` ON DELETE SET NULL, partial index). Relaxed: `pack_code` NOT NULL → `payment_orders_pack_code_chk` (a credit-pack order still names its pack) and `payment_orders_credits_pos_chk` (binds credit packs only). Widened: `payment_orders_status_chk` gains `held`. `when` = `1794891953223` (> 0174's `1794829712236`). **APPLY BEFORE DEPLOY, FROM THE PR BRANCH BEFORE THE MERGE** — the repository's bare `.select()` / `.returning()` on `payment_orders` name every new column. **Adopt with `--only <tag>`, or after the pending lower migrations.** Statement order is hand-written (the `job_postings` FK last). Registered as the nine `0176-payment-orders-<column>` columns, `0176-payment-orders-money-sum-chk`, `0176-payment-orders-pack-code-chk`, `0176-payment-orders-origin-posting-fk`. No new table, RLS unchanged. See the `0176` section below |
| `0177`        | Divyanshu | **Branch `feat/2755-numbers-weekly` (#2755 part B, on main after part A #2874 and #2872, PR pending) — NOT YET APPLIED anywhere. Renumbered to 0177 above #2872's `0176_payment_order_money` (merged first); the coordinator renumbers again by merge order if needed, so the header, the tail and `migration-numbers-weekly.test.ts` carry no number (found by the `_numbers_weekly` tag suffix); the two `schema-contract.ts` ids and this row are renumbered with it.** Two new tables. `numbers_weekly`, the numbers screen's weekly snapshot: `week_start` date (a Monday, `numbers_weekly_week_start_chk`), `metric`, `city_group`, `trade_group` (text; the `all` roll-ups included), `value` / `numerator` / `denominator` bigint NULL, `suppressed` boolean NOT NULL default false (a suppressed row holds no number, `numbers_weekly_suppressed_chk`), `definition_version` integer NOT NULL, `computed_at` timestamptz NOT NULL, `frozen_at` timestamptz NULL; PRIMARY KEY (`week_start`, `metric`, `city_group`, `trade_group`). `numbers_recompute_log`, one row per applied recompute: `id` uuid PK, `run_at`, `actor` (`cli`, `numbers_recompute_log_actor_chk`), `from_week` <= `to_week`, `definition_version`, `reason` text 1..500 (the operator's own words; never logged or put on an event), `rows_changed` >= 0. Aggregates only, no FK, no other index. RLS ENABLE plus hand-appended FORCE and the four REVOKEs on both. `when` = `1794904862633` (> 0176's `1794900885026`). **APPLY BEFORE THE SWITCH, NOT BEFORE THE DEPLOY**: nothing names either table while `ADMIN_NUMBERS_ENABLED` is off (every `/admin/numbers` route 404s, the nightly sweep returns at once). With the switch on before this migration, `GET /admin/numbers/weekly` answers 503 (42P01) and the sweep logs one warning per process and writes nothing. No FK, so no lock on any existing table (hand-apply in one `BEGIN; SET LOCAL lock_timeout = '3s'; … COMMIT;` all the same). Registered as `0177-numbers-weekly-rls` and `0177-numbers-recompute-log-rls` in `schema-contract.ts` and listed in the e2e RLS guard. Ledger adoption order: every lower slot first. The first sweep after the switch backfills history from `NUMBERS_BASELINE_FROM` (2026-06-01). Rollback in the header (`DROP TABLE` both, switch off first) |
| `0178`        | Divyanshu | **ON BRANCH `feat/2750-credit-settings` (#2750 part A1), regenerated on top of 0177 (`0177_numbers_weekly`, #2876) — NOT YET APPLIED anywhere.** New table `credit_rules_config`, the credit rules' settings one row per revision: `rules` jsonb (a JSON object, `credit_rules_config_rules_object_chk`; shape and brief defaults in `@badabhai/pricing` `CreditRulesSchema`), `revision` int (> 0, UNIQUE `credit_rules_config_revision_uq`), `is_active` (partial UNIQUE `credit_rules_config_active_uq`: one active row), `updated_by` (opaque admin id), `created_at`. No FK, nothing seeded (an empty table serves the brief's defaults). RLS ENABLE plus hand-appended FORCE and the four REVOKEs. **APPLY BEFORE THE SWITCH, NOT BEFORE THE DEPLOY**: nothing names the table while `CREDIT_RULES_ROLLOUT` is off; with it on first, the admin routes answer 503 and every rule reads its default. No other table is locked; still apply in ONE `BEGIN; SET LOCAL lock_timeout = '3s'; … COMMIT;`. Registered as `0178-credit-rules-config-rls` in `schema-contract.ts` (renumber with the slot) and listed in the e2e RLS guard. Ledger adoption order: every lower slot first. Rollback in the header (`DROP TABLE`, switch off first) |
| `0179`        | Divyanshu | **ON BRANCH `feat/2755-launch-tests` (#2755 part D, PR #2875), regenerated on top of 0178 (`0178_credit_rules_config`, #2877) — NOT YET APPLIED anywhere. The header, the tail and the migration test carry no number.** #2755 item 9, launch test A's records, written by hand by the desk (nothing sends a profile, creates a link or charges money). New table `launch_test_cohort`, one row per factory: `id` uuid PK, `factory_name_enc` text NOT NULL and `factory_phone_enc` text (AES, `PiiCryptoService.encrypt`), `factory_phone_hash` text (`hashPhone`, the same keyed HMAC as `payers.phone_hash`), `city_group` / `trade_group` text NOT NULL (part A's groups), `payer_id` (FK `payers` ON DELETE SET NULL), `sent_by_admin_id` uuid NOT NULL, `sent_at` timestamptz NOT NULL, `payment_link_ref` text (1..300, `launch_test_cohort_link_ref_chk`), `link_created_at` (needs the ref, `launch_test_cohort_link_chk`), `result` text NOT NULL default `pending` (`pending`/`paid`/`declined`/`no_response`, `launch_test_cohort_result_chk` = `LAUNCH_TEST_RESULTS`), `paid_at` (set exactly when `paid`, `launch_test_cohort_paid_chk`), `payment_order_id` (FK `payment_orders` ON DELETE SET NULL), `created_at`/`updated_at`, `updated_by_admin_id` uuid NOT NULL (admin ids carry no FK); the phone's ciphertext and hash together (`launch_test_cohort_phone_chk`); UNIQUE `launch_test_cohort_phone_hash_uq` (one row per factory phone) and `launch_test_cohort_payment_order_uq` (one factory per paid order), index `launch_test_cohort_payer_id_idx`. New table `launch_test_shares`, one row per worker sent: `cohort_id` (FK CASCADE) + `worker_id` (FK `workers` ON DELETE CASCADE, DPDP erasure; `launch_test_shares_worker_id_idx`) as the PRIMARY KEY `launch_test_shares_pk`, `shared_at`; at most five per factory, counted by the service under a lock on the factory row. RLS ENABLE plus hand-appended FORCE and the four REVOKEs on both. **APPLY BEFORE THE SWITCH, NOT BEFORE THE DEPLOY**: nothing names either table while `ADMIN_NUMBERS_ENABLED` is off (every `/admin/launch-tests/*` route is a 404 before a query); with it on and the tables missing, the three cohort routes answer 503 (42P01, fail closed) and the rest of the numbers screen keeps working. Three FKs: hand-apply in ONE `BEGIN; SET LOCAL lock_timeout = '3s'; … COMMIT;` and retry on 55P03 (SHARE ROW EXCLUSIVE on `payers`, `payment_orders` and `workers`). Registered as `0179-launch-test-cohort-rls` and `0179-launch-test-shares-rls` in `schema-contract.ts` (renumber with the slot) and listed in the e2e RLS guard. Ledger adoption order: every lower slot first. Rollback in the header (`DROP TABLE` both, switch off first) |
| `0180`        | Divyanshu | **Branch `feat/2755-numbers-calls` (#2755 part C, on main after part B #2876, #2877 and part D #2875, PR pending) — NOT YET APPLIED anywhere. The slot is provisional: the coordinator renumbers it by merge order (it sits above `0179_launch_tests`, #2875), so the header, the tail and `migration-credit-call-log.test.ts` carry no number (found by the `_credit_call_log` tag suffix); the `schema-contract.ts` id and this row are renumbered with it.** New table `credit_call_log`, one row per call the telecaller made to a company whose credits ran out: `id` uuid PK (derived from the admin and the request's Idempotency-Key, so a retried POST inserts nothing), `payer_id` uuid NOT NULL (FK `payers` ON DELETE CASCADE), `called_by_admin_id` uuid NOT NULL (no FK, an admin-actor column), `called_at` timestamptz NOT NULL default now(), `result` text NOT NULL (`reached_will_buy`/`reached_not_now`/`reached_declined`/`no_answer`/`wrong_number`, `credit_call_log_result_chk` = `CREDIT_CALL_RESULTS` in `@badabhai/types`; no free text); index `credit_call_log_payer_called_idx` (payer_id, called_at DESC), the latest-call read, which also backs the cascade. RLS ENABLE plus hand-appended FORCE and the four REVOKEs. `when` = `1794911600894` (> 0179's `1794908884774`). **APPLY BEFORE THE SWITCH, NOT BEFORE THE DEPLOY**: nothing names the table while `ADMIN_NUMBERS_ENABLED` is off (every `/admin/numbers` route 404s). With the switch on before this migration, `GET /admin/numbers/out-of-credits` still answers (every row `last_call: null`) and `POST /admin/numbers/out-of-credits/:payerId/calls` answers 503 (42P01, nothing written). One FK: hand-apply in ONE `BEGIN; SET LOCAL lock_timeout = '3s'; … COMMIT;` and retry on 55P03 (SHARE ROW EXCLUSIVE on `payers`). Registered as `0180-credit-call-log-rls` in `schema-contract.ts` and listed in the e2e RLS guard. Ledger adoption order: every lower slot first. Rollback in the header (`DROP TABLE`, switch off first) |
| `0181`        | Divyanshu | **ON BRANCH `feat/2750-waivers` (#2750 part C) — NOT YET APPLIED anywhere. The header, the tail and the migration test carry no number.** #2750 item 5, the placement team's waiver of the contact cost. New table `rvm_applicant_waivers`, one row per waiver, never deleted: `id` uuid PK, `scope` text (`company`/`job`, `rvm_applicant_waivers_scope_chk`), `payer_id` uuid NOT NULL (the company's tenant key, no FK), `job_posting_id` (FK `job_postings` ON DELETE CASCADE; set exactly for a job waiver, `rvm_applicant_waivers_scope_posting_chk`), `active` bool default true (= `cleared_at IS NULL`, and a clear names `cleared_by_ref`: `rvm_applicant_waivers_active_chk`), `source` (`campus`/`admin`, `rvm_applicant_waivers_source_chk`), `set_by_ref` text (Campus staff uuid or admin id), `set_by_label_enc` text (the staff name, AES via `PiiCryptoService.encrypt`, owner ruling 2026-11-17), `reason` text (1..500), `created_at`, `cleared_at`, `cleared_by_ref`, `cleared_by_label_enc`, `clear_reason` (<= 500; lengths in `rvm_applicant_waivers_text_chk`); partial UNIQUE `rvm_applicant_waivers_company_active_uq` (`payer_id` WHERE active AND scope = 'company') and `rvm_applicant_waivers_job_active_uq` (`job_posting_id` WHERE active AND scope = 'job'); indexes `rvm_applicant_waivers_payer_idx` (`payer_id`, `created_at` DESC) and `rvm_applicant_waivers_job_posting_idx`. New table `rvm_waiver_uses`, one row per waived open: `waiver_id` (FK CASCADE), `unlock_id` (FK `unlocks` ON DELETE CASCADE, UNIQUE `rvm_waiver_uses_unlock_uq`), `payer_id`, `created_at`; index `rvm_waiver_uses_waiver_idx`. RLS ENABLE plus hand-appended FORCE and the four REVOKEs on both. The new ledger reason `waived` (delta 0) needs no DDL. **APPLY BEFORE THE SWITCH, NOT BEFORE THE DEPLOY**: nothing names either table while `CREDIT_RULES_ROLLOUT` is off; with it on and the tables missing, the waiver routes answer 503 and every open prices as if no waiver existed (42P01 read as none). Three FKs: hand-apply in ONE `BEGIN; SET LOCAL lock_timeout = '3s'; … COMMIT;` and retry on 55P03 (SHARE ROW EXCLUSIVE on `job_postings` and `unlocks`). Registered as `0181-rvm-applicant-waivers-rls` and `0181-rvm-waiver-uses-rls` in `schema-contract.ts` (renumber with the slot) and listed in the e2e RLS guard. Ledger adoption order: every lower slot first. Rollback in the header (`DROP TABLE` both, switch off first) |
| `0182`        | Divyanshu | **ON BRANCH `feat/2887-student-move-foundations` (#2887 part 1) — NOT YET APPLIED anywhere. The header, the tail and the migration test carry no number.** The bulk move of RVM students into BadaBhai (ruling of 17 Nov 2026). Five new, empty tables: `student_import_batches` (one import run: `source` = `campus`, `label` 1..120, `since`, `status` running/applied/failed/rolled_back with `rolled_back_at` set exactly when rolled back, `counts` jsonb object, `started_at`, `finished_at`); `student_import_rows` (one per candidate per run: `batch_id` FK CASCADE, `source_id` (`^[A-Za-z0-9._:-]{1,128}$`), `worker_id` FK `workers` SET NULL, `action` created/updated/unchanged/held/failed/rolled_back, `reason` code, `worker_created`, `fields_written` jsonb array; UNIQUE `(batch_id, source_id)`); `student_import_subjects` (PK `(source, source_id)`, `worker_id` FK `workers` CASCADE and UNIQUE: one candidate per worker, first/last batch FKs, `content_hash` sha-256 hex); `worker_field_sources` (PK `(worker_id, field_key)`, `source` campus_import/worker, `batch_id` only for campus_import); `student_visibility` (PK `worker_id` FK `workers` CASCADE, `visible` default false, `batch_id`, `changed_by_admin_id`, `reason` 1..500, partial index on the hidden set). RLS ENABLE plus hand-appended FORCE and the four REVOKEs on all five. **APPLY BEFORE THE SWITCH, NOT BEFORE THE DEPLOY**: nothing names them while `STUDENT_MOVE_ENABLED` is off; with it on and the tables missing the admin routes answer 503 and the hot reads fall back to their switch-off text (42P01 logged once). FKs take a brief SHARE ROW EXCLUSIVE on `workers`: hand-apply in ONE `BEGIN; SET LOCAL lock_timeout = '3s'; … COMMIT;` and retry on 55P03. Registered as `0182-<table>-rls` (five) in `schema-contract.ts` (renumber with the slot) and listed in the e2e RLS guard. Ledger adoption order: every lower slot first. Rollback in the header (`DROP TABLE` all five in FK order, switch off first) |
| `0183`        | Divyanshu | **ON BRANCH `feat/2754-import-ledger` (#2754 part 1, PR #2901), regenerated on top of 0182 (`0182_student_move`, #2887) — NOT YET APPLIED anywhere. The header, the tail and the migration test carry no number.** #2754 items 4 and 14, the Campus company import ledger. New table `company_import_batches`: one row per `--apply` run (`batch_key` unique, `source_system` = `campus`, bundle format, version, generation time and manifest sha256, `is_test`, `state` `applying`/`applied`/`rolled_back`, `run_by`, manifest counts). New table `company_import_rows`: one row per source record (company, job, application, balance, access), unique on (`source_system`, `kind`, `source_id`) across batches, mapping each Campus id to the BadaBhai row written or matched (`target_id`) or a reason code (held, skipped, exception); FK to the batch ON DELETE RESTRICT. No PII. ADDITIVE: two new empty tables; no existing table touched. **Apply before the first import run, not before the deploy**: only the import CLI names them. RLS ENABLE + hand-written FORCE and four REVOKEs per table. |
| `0184`        | Divyanshu | **ON BRANCH `feat/2891-campus-worker-visibility` (#2891 PR A, #2900), regenerated on top of 0183 (`0183_company_import`, #2754) — NOT YET APPLIED anywhere. The header, the tail and `migration-job-posting-worker-visibility.test.ts` carry no number.** New table `job_posting_worker_visibility`, one row per Campus-origin posting: `job_posting_id` uuid PK (FK `job_postings` ON DELETE CASCADE), `state` text default `off` (`off`/`on`, `jpwv_state_chk`), `origin` text (`campus_posted`/`campus_imported`, `jpwv_origin_chk`), `decided_by_admin_id` uuid (no FK, an admin-actor column), `decided_at` timestamptz (both null or both set, and `on` only with a decision: `jpwv_decision_chk`), `created_at`, `updated_at`; index `jpwv_state_created_idx` (state, created_at). RLS ENABLE plus hand-appended FORCE and the four REVOKEs. No backfill. **APPLY BEFORE THE DEPLOY OF #2891 PR B (#2903), NOT A SWITCH**: PR A (this) names the table only in the model and in the unused `holdPostingFromWorkers`, so it deploys safely before the apply; PR B puts the table inside `reachesBadaBhaiWorkers()`, which every worker read runs unconditionally (no switch, by the #2746 rule), so PR B merges only after this is applied. One FK: hand-apply in ONE `BEGIN; SET LOCAL lock_timeout = '3s'; … COMMIT;` and retry on 55P03 (SHARE ROW EXCLUSIVE on `job_postings`). Registered as `0184-job-posting-worker-visibility-rls` in `schema-contract.ts` and listed in the e2e RLS guard. Ledger adoption order: every lower slot first (0182, 0183). Rollback in the header (revert PR B first) |
| `0185`        | Divyanshu | **ON BRANCH `feat/2750-reach-desk` (#2750 part E) — NOT YET APPLIED anywhere. The header, the tail and the migration test carry no number.** #2750 item 7, the working-number guarantee and the worker desk. New table `contact_reach_cases`, one per open: `id` uuid PK, `unlock_id` (FK `unlocks` ON DELETE CASCADE, UNIQUE `contact_reach_cases_unlock_uq`), `payer_id` uuid NOT NULL (tenant key, no FK), `worker_id` (FK `workers` ON DELETE SET NULL, erasure), `reported_by` uuid NOT NULL (the acting login), `reported_at`, `deadline_at` NOT NULL, `status` (`open`/`reached_interested`/`reached_declined`/`not_reached`, `contact_reach_cases_status_chk`), `credits_returned` int >= 0, `resolved_at`, `resolved_by` (`desk`/`deadline`), `resolved_by_admin_id` (desk only); `contact_reach_cases_resolution_chk` ties open to unresolved; partial index `contact_reach_cases_open_deadline_idx` (`deadline_at` WHERE open) and `contact_reach_cases_payer_idx`. New table `contact_reach_attempts`: `case_id` (FK CASCADE, `contact_reach_attempts_case_idx`), `admin_id` uuid NOT NULL, `result` (`no_answer`/`busy`/`switched_off`/`wrong_number`/`other`), `attempted_at`. No free text on either. RLS ENABLE plus hand-appended FORCE and the four REVOKEs on both. The `returned` ledger reason and lot source need no DDL. **APPLY BEFORE THE SWITCH, NOT BEFORE THE DEPLOY**: nothing names either table while `CREDIT_RULES_ROLLOUT` is off; with it on and the tables missing the routes answer 503 and the deadline sweep logs and waits. Four FKs: hand-apply in ONE `BEGIN; SET LOCAL lock_timeout = '3s'; … COMMIT;` and retry on 55P03 (SHARE ROW EXCLUSIVE on `unlocks` and `workers`). Registered as `0185-contact-reach-cases-rls` and `0185-contact-reach-attempts-rls` in `schema-contract.ts` (renumber with the slot) and listed in the e2e RLS guard. Ledger adoption order: every lower slot first. Rollback in the header (`DROP TABLE` both, switch off first) |
| `0186`        | Divyanshu | **ON BRANCH `feat/2750-refunds` (#2750 item 10) — NOT YET APPLIED anywhere. The header, the tail and the migration test carry no number.** #2750 item 10, admin refunds of real paid packs. New table `payment_refunds`, one per order: `id` uuid PK, `payment_order_id` (FK `payment_orders`, no cascade: a refund is a money record; UNIQUE `payment_refunds_order_uq`), `payer_id` uuid NOT NULL (the wallet, no FK), `rule` (`unused`/`low_match`), `job_posting_id` (FK `job_postings` ON DELETE SET NULL) and `applicants_counted` (set exactly for `low_match`), `requested_by` (admin), `amount_paise` > 0, `credits_removed` >= 0, `status` (`requested`/`pending`/`processed`/`failed`), `provider_refund_id` (partial UNIQUE `payment_refunds_provider_uq`), `failure_code` (`provider_error`/`provider_failed`, set exactly when failed), `credit_note_number`, `requested_at`, `processed_at` (set exactly when processed), `updated_at`; `payment_refunds_payer_idx`. No free text (the admin's reason is on `audit_logs`). RLS ENABLE plus hand-appended FORCE and the four REVOKEs. The `pack_refund` ledger reason needs no DDL. **APPLY BEFORE REFUNDS ARE TURNED ON, NOT BEFORE THE DEPLOY**: every refund route answers 503 until GST credit notes exist (owner ruling 2026-11-18); with them and the table missing the routes answer 503 and the refund webhook logs and acknowledges. Two FKs: hand-apply in ONE `BEGIN; SET LOCAL lock_timeout = '3s'; … COMMIT;` and retry on 55P03 (SHARE ROW EXCLUSIVE on `payment_orders` and `job_postings`). Registered as `0186-payment-refunds-rls` in `schema-contract.ts` (renumber with the slot) and listed in the e2e RLS guard. Ledger adoption order: every lower slot first. Rollback in the header (`DROP TABLE`, only while no refund exists) |
| `0187`        | Divyanshu | **ON BRANCH `feat/2751-posting-choice` (#2751 items 1 to 3) — NOT YET APPLIED anywhere. The header, the tail and the migration test carry no number.** #2751 items 1 to 3, the posting choice record (brief 4B.7). New table `job_posting_choices`, ONE ROW PER POSTING: `job_posting_id` uuid PK (FK `job_postings` ON DELETE CASCADE), `payer_id` uuid NOT NULL (the tenant key, no FK), `choice` (`free`/`free_plus_pack`, CHECK `job_posting_choices_choice_chk`), `surface` (`web`/`app`, CHECK `job_posting_choices_surface_chk`), `recorded_at`; `job_posting_choices_recorded_idx` and `job_posting_choices_payer_idx`. A new table, never columns on `job_postings` (the bare posting selects would make that apply-before-deploy). No free text. RLS ENABLE plus hand-appended FORCE and the four REVOKEs. **APPLY BEFORE `POSTING_CHOICE_ROLLOUT` IS SET TO `pilot` OR `on`, NOT BEFORE THE DEPLOY**: off (the default) nothing names the table; armed with it missing the publish still succeeds and the choice is not recorded (logged with the SQLSTATE). One FK: hand-apply in ONE `BEGIN; SET LOCAL lock_timeout = '3s'; … COMMIT;` and retry on 55P03 (SHARE ROW EXCLUSIVE on `job_postings`). Registered as `0187-job-posting-choices-rls` in `schema-contract.ts` (renumber with the slot) and listed in the e2e RLS guard. Ledger adoption order: every lower slot first. Rollback in the header (`DROP TABLE`, switch off first) |
| `0188`        | Divyanshu | **ON BRANCH `feat/2749-invoices` (#2749 part 4) — NOT YET APPLIED anywhere. The header, the tail and the migration test carry no number.** #2749 items 8 and 9, GST invoices and credit notes. Five new tables: `seller_tax_config` (the seller of record, typed in BY HAND after the merge — no GSTIN/PAN/name/address in code; one active row `seller_tax_config_one_active_uq`; GSTIN shape + its state and PAN agree with the row's; SAC 6 digits; prefixes `^[A-Z][A-Z0-9]{0,2}$` and different, so a number fits 16 characters); `payer_billing_details` (PK `payer_id` = the tenant key, no FK; plain `state_code`; `gstin_enc`/`legal_name_enc`/`address_enc` under the `payers.org_name_enc` key, a GSTIN needs the other two); `invoice_number_series` (PK (`series`, `financial_year`), `last_number` >= 0, incremented with INSERT … ON CONFLICT DO UPDATE inside the issuing transaction); `invoices` (UNIQUE `payment_order_id` FK `payment_orders`, UNIQUE `invoice_number` <= 16 chars, seller snapshot incl. PAN, encrypted buyer snapshot, `supply_type` `intra`/`inter`, taxable + CGST + SGST + IGST = total, intra ⇒ no IGST, inter ⇒ no CGST/SGST, `is_test`, `pdf_storage_key`/`pdf_rendered_at` together; `invoices_payer_idx`); `credit_notes` (FK `invoices`, UNIQUE `payment_refund_id` FK `payment_refunds`, UNIQUE `credit_note_number`, the same five paise columns and CHECKs). RLS ENABLE plus hand-appended FORCE and the four REVOKEs on all five. **APPLY BEFORE DEPLOY** (the payer billing-details and invoice routes name the tables unconditionally; the settle writes the invoice in a savepoint, so a missing table there grants the credits with no invoice). **0186 must be applied first** (FK to `payment_refunds`). Three FKs: hand-apply in ONE `BEGIN; SET LOCAL lock_timeout = '3s'; … COMMIT;` and retry on 55P03 (SHARE ROW EXCLUSIVE on `payment_orders` and `payment_refunds`). Registered as five `0188-*-table` and five `0188-*-rls` entries in `schema-contract.ts` (renumber with the slot) and listed in the e2e RLS guard. Ledger adoption order: every lower slot first. Rollback in the header (`DROP TABLE` ×5, only while no invoice or credit note exists) |
| `0189`        | Divyanshu | **ON BRANCH `feat/2751-managed-hiring` (#2751 items 4 to 13), regenerated on top of 0188 (`0188_invoices`, #2749 part 4) — NOT YET APPLIED anywhere. The header, the tail and the migration test carry no number.** #2751 items 4 to 13, Managed Hiring (brief section 2 and 4B.9). Three new tables: `managed_hiring_orders` (one prepaid order per job: tier `standard`/`large`, the `payment_orders` row it rides (FK RESTRICT, unique), status `created`/`active`/`met`/`extended`/`closed_unmet`/`cancelled`, list price, target, working days and extension days stamped at checkout, the clock `started_at`/`due_at`/`extended_until` stamped on capture (`managed_hiring_orders_clock_chk`), `is_test`; ONE OPEN ORDER PER JOB as the partial unique index `managed_hiring_orders_open_job_uq`; FK `job_postings` ON DELETE CASCADE); `managed_hiring_interest` (the tracker: unique per order and worker, `payer_id` repeated for the contact-cost probe `managed_hiring_interest_payer_worker_idx`, the admin who confirmed him, a staff `note` of 1 to 500 characters, worker FK ON DELETE CASCADE); `managed_hiring_callback_requests` (one per job above the largest tier, band and reason CHECKs). And ONE CHECK WIDENED: `payment_orders_product_kind_chk` from ('credit_pack') to ('credit_pack', 'managed_hiring') (drop + add on a small table). RLS ENABLE plus hand-appended FORCE and the four REVOKEs per table. **APPLY BEFORE `MANAGED_HIRING_ROLLOUT` IS SET TO `pilot` OR `on`, NOT BEFORE THE DEPLOY**: off (the default) no route, sweep or contact-cost read names the tables and nothing writes a `managed_hiring` payment order. Hand-apply in ONE `BEGIN; SET LOCAL lock_timeout = '3s'; … COMMIT;` (so the CHECK is never dropped without its replacement) and retry on 55P03. Registered as three `0188-managed-hiring-*-rls` entries in `schema-contract.ts` (renumber with the slot) and listed in the e2e RLS guard. Ledger adoption order: every lower slot first. Rollback in the header (switch off first) |
| `0190`        | Divyanshu | **ON BRANCH `feat/2956-admin-job-audience` (#2956 part 1, with #2957 table) — NOT YET APPLIED anywhere. The header, the tail and the migration test carry no number.** Owner direction of 19 Nov 2026 (#2959): an ADMIN, not the company, decides where each job shows. Two new tables: `job_posting_audience_decisions` (the latest admin decision per posting: `job_posting_id` uuid PK, FK `job_postings` ON DELETE CASCADE; `audience` text, `jpad_audience_chk` mirrors `job_postings_audience_chk`; `content_hash` text, the posting review hash at decision time, `jpad_content_hash_chk` sha256 hex; `decided_by_admin_id` uuid NOT NULL (no FK, an admin-actor column); `decided_at`, `created_at`, `updated_at`) and `campus_trades` (#2957, the trades RVM trains: `trade_key` text PK, shape-only `campus_trades_key_chk` so a new trade kind needs no migration; `added_by_admin_id`, `added_at`; `removed_by_admin_id` + `removed_at` together or neither, `campus_trades_removed_chk`; never deleted). No index beyond the PKs, no backfill, no seed. RLS ENABLE plus hand-appended FORCE and the four REVOKEs per table. **APPLY BEFORE `ADMIN_JOB_AUDIENCE_ENABLED` IS TURNED ON, NOT BEFORE THE DEPLOY**: only the admin audience routes name the tables, and they answer 404 while the switch is off. One FK: hand-apply in ONE `BEGIN; SET LOCAL lock_timeout = '3s'; … COMMIT;` and retry on 55P03 (SHARE ROW EXCLUSIVE on `job_postings`). Registered as `0190-job-posting-audience-decisions-rls` and `0190-campus-trades-rls` in `schema-contract.ts` and listed in the e2e RLS guard. Ledger adoption order: every lower slot first. Rollback in the header (switch off first) |

### The journal is five files behind, and what that actually costs — corrected 2026-08-20

**`0076`–`0080` are LIVE in production and UNRECORDED in `drizzle.__drizzle_migrations`.** All
five were applied out of band, so their objects exist and their journal rows do not.

**The rule this file stated on 2026-08-19 was wrong, and the correction changes the
instruction.** It said `drizzle-kit migrate` "replays every unrecorded file in order". Read from
the installed `drizzle-orm@0.45.2` (`pg-core/dialect.js`; `drizzle-kit migrate` delegates to it):

```js
select id, hash, created_at from drizzle.__drizzle_migrations
  order by created_at desc limit 1          // ONE row. A WATERMARK.
for (const m of migrations)
  if (!last || Number(last.created_at) < m.folderMillis) { …apply…; …insert… }
```

It is a **high-water mark**, not set membership. Everything with a `when` above the newest
recorded `created_at` is applied; everything at or below it is skipped, recorded or not. The two
models agreed on 2026-08-19 only by coincidence — the watermark sat at `0075`, so "unrecorded"
and "above the watermark" named the same five files. They came apart when `0081` was applied out
of band on 2026-08-20 and moved the watermark to `1787141865609`.

**RESOLVED 2026-08-20** — and **RE-INCURRED since: as of 2026-08-26 three rows are owed again
(`0090`, `0091`, `0092`); see the table above.** The paragraph below is the 2026-08-20 reading and
is kept as the account of how that debt was cleared, not as a statement about today. What follows
is how it got there, because the route changed twice in one day and the second change is the one
worth remembering.

> **2026-08-20:** the journal matches the database: `--doctor` reads 84/84, and `db:migrate` will
> attempt no DDL.

|                                                   |                        |                                |                       |
| ------------------------------------------------- | ---------------------- | ------------------------------ | --------------------- |
|                                                   | **2026-08-21**         | **2026-08-26, before**         | **2026-08-26, after** |
| journal entries                                   | 87 (`0000`–`0086`)     | 93 (`0000`–`0092`)             | 93 (`0000`–`0092`)    |
| recorded, matching a journal entry                | **85**                 | **90**                         | **93**                |
| unrecorded                                        | **2** — `0085`, `0086` | **3** — `0090`, `0091`, `0092` | **0**                 |
| recorded rows matching NO journal entry (orphans) | **0**                  | **0**                          | **0**                 |

**RE-INCURRED, THEN CLEARED — both on the same day, which is the part worth keeping.** `0085`
and `0086` were adopted in the interval since 2026-08-21, along with `0087` and `0088`; the debt
did not persist, it was **re-incurred** by three later files. Measured against production on
2026-08-26 while verifying `0092` for #1225: `count(*)` = **90** against **93** journal entries,
with the newest recorded `created_at` at **`1787574455774`** — `0089`'s. The three entries above
that watermark (`0090` `1787576001514`, `0091` `1787577906223`, `0092` `1787650702334`) were live
and unrecorded. Adopted the same day, `clean=3 mismatched=0`, and `--doctor` now reports **0
orphans**:

```bash
cd packages/db
npx tsx adopt-migrations.ts --only 0090_chemical_sersi,0091_fluffy_tag,0092_flawless_glorian
npx tsx adopt-migrations.ts --only 0090_chemical_sersi,0091_fluffy_tag,0092_flawless_glorian --apply --expect-host aws-1-ap-south-1.pooler.supabase.com
```

**Which direction that drift pointed, and why it was still blocking.** All three sat ABOVE the
watermark, so `db:migrate` would have REPLAYED them rather than skipping them — the loud
direction, not the silent one this file's `0082` story is about. But the replay would not have
been a no-op: `0090` and `0091` are bare `CREATE TABLE`s and `0092` a bare `ADD COLUMN`, none of
them `IF NOT EXISTS`, so all three would have aborted on `42P07`/`42701` against a database that
already has the objects. Above-watermark is the recoverable direction and was still not a
runnable one.

### ⚠ `0089` — one hash mismatch remains, and it is a PROVENANCE signal, not a migrator hazard

`--doctor` reads **92/93** on the hash check:

```
✗ 0089_exotic_thaddeus_ross: hash mismatch (stored 493ff00a87bb… vs file 78da85edb7f5…)
```

**What it means.** The `hash` recorded against `0089`'s row is the sha256 of a DIFFERENT
byte-sequence than `migrations/0089_exotic_thaddeus_ross.sql` in this checkout. The cause is in
this file's own record and in git: `0089` was **APPLIED 2026-08-24**, while the file first
reached `main` on **2026-08-25** (`0eb37a65`, #1204) — and its entry notes it was
`db:generate`d and then **hand-edited** (the function `CREATE` hand-prepended above the column,
plus `lock_timeout` and rollback notes). It was applied and recorded from a pre-merge branch
state; the file then changed before it merged. The file has exactly one commit, so nothing was
edited after the fact.

**What it does NOT mean, and this correction matters during an incident.**
`adopt-migrations.ts`'s own comment claimed a hash mismatch "means drizzle would try to RE-APPLY
a migration whose DDL is already live". **It does not** — read from the installed
`drizzle-orm@0.45.2` (`pg-core/dialect.cjs`, the same source this file quotes above), the
migrator's only predicate is `Number(lastDbMigration.created_at) < migration.folderMillis`. The
`hash` column is selected and written and **never compared**. The comment has been corrected in
place. With the watermark now at `0092`'s `1787650702334`, `db:migrate` skips every entry in the
journal regardless of hash.

**What is still worth checking, and by whom.** The mismatch says production ran a different
byte-sequence than a fresh database built from this repo would run. If the difference is only the
hand-prepended comments, nothing diverges; if it reaches the statements, production and a fresh
build differ in a way no hash check can characterise. `db:audit:live-drift` is the tool that
answers it, and `0089` is Prakash's (#1202/#1204) — raise it there rather than re-recording the
row, because the stored hash is the honest record of what was applied and editing it to match the
file would destroy the only evidence that they differ.

**The lesson is about this FILE, not about the database.** Nothing broke: every object is live
and correct, and the three entries were each recorded here as "APPLIED" on the day they ran. What
did not happen is the metadata write that makes `db:migrate` usable by the next person — the step
that is easy to skip precisely because skipping it changes nothing visible until somebody runs
the migrator. The 2026-08-20 entry below closed the same debt and the file then declared the
journal clean; it went stale within four days, and this section is the second clearance in six.
Treat "the journal is clean" as a claim with a date on it, and re-measure with `--doctor` rather
than reading it here.

**`0084` was reconciled on 2026-08-20.** The DDL was applied by hand, as every migration on this
project is, and `adopt-migrations --only 0084_model_gap_db_21_payer_onboarding --apply
--expect-host …` then wrote the journal row after re-verifying all 24 effect assertions against
the live catalog. `--doctor` reads **85/85 match, 0 orphans**, and reports that `db:migrate` will
now attempt no DDL. `db:audit:schema-contract` is **READY**, including the four
`0084_model_gap_db_21_payer_onboarding` RLS entries, each of which asserts ENABLE + FORCE + no
Data-API grant rather than mere existence.

**The plan that stopped working.** `0082` was applied by hand, so it was live and unrecorded but
_above_ the watermark — which meant `db:migrate` would replay it (a measured no-op) and write the
row. That was the instruction in this file for about an hour. Then a **third** out-of-band apply
landed, from a checkout that has never reached `main`, carrying a hand-pinned
`created_at = 1787230000000`. That is **above** `0082`'s `1787220000000`, so the watermark moved
past `0082` and `db:migrate` went from _replaying_ it to **skipping it silently, forever** — the
dangerous direction, arrived at without anyone touching `0082`.

**Why adoption could not take it either, and what changed.** `0082`'s Section B is a
`to_regclass`-guarded `DO $$` block, and adoption refuses dynamic SQL on principle: what the
block does is chosen at run time and cannot be read off the file. Both routes were closed.

The fix is an **effect verifier** — see `EFFECT_VERIFIERS` in `src/migration-adoption.ts`. It is
not a relaxation. A migration may register a function that verifies its EFFECTS against the live
catalog, which is _stronger_ evidence than the text parse it replaces: a parse asks what the file
says, a verifier asks what the database is. It is keyed to one migration tag, it runs **in
addition** to the static check rather than instead of it, it must assert a non-zero number of
facts (a test pins this), and it can still fail. `0082`'s checks all seven tables for
ENABLE + FORCE + four revoked roles — **42 assertions**, all satisfied, which is how it was
recorded.

Run against a database where `0082` is not applied, the same verifier reports 42 problems and
adoption refuses. The property the runbook needs — _cannot record a migration whose effects are
absent_ — is preserved exactly, and now covers the four GAP-DB-21 tables the parse could never
see.

**The orphan row — RESOLVED BY THIS MERGE.** `created_at=1787230000000`, hash `b70e16df…`. When
that paragraph was written it matched no migration file in this checkout and no open PR, and
production carried a table this repository did not model: `db:audit:live-drift` read **78 live
public tables against 72 declared**. It was locked throughout (`db:audit:rls`: 78/78, 0
deviating), so there was never exposure — only an unreconciled record.

It is `0083_ai_call_traces`, applied to production ahead of its own PR. The row is now backed by
a file, the table by a Drizzle model, and the drift count closes. **The diagnosis was exactly
right, and worth keeping:** an orphan row is what "applied out of band, from a checkout that has
not reached `main`" looks like from the database's side, and naming it beat absorbing it into a
subtraction. The lesson is the ordering, not the tooling — a migration applied before its PR
merges is an orphan for as long as the PR takes, and during that window every drift audit reports
a discrepancy that is real but not actionable. Apply-before-merge remains correct for a table
whose absence breaks a deploy; it just needs the open PR named in this file at the time, so the
next person reading a drift report can tell "in flight" from "nobody knows what this is".

**What to run, and when.** As of **2026-08-26** all 93 entries are recorded and there are no
orphans, so nothing is owed — but that sentence has now been false twice within six days, so
**measure rather than believe it**: `--doctor` is one read-only command and it is the only
answer with a timestamp on it. One known deviation survives the clearance and is not a debt:
`0089`'s hash mismatch, characterised in the section above.

```bash
# STATE OF PLAY — run these three before believing anything about the journal.
cd packages/db
npx tsx adopt-migrations.ts --doctor                   # 90/93 on 2026-08-26; names orphan rows
npx tsx reconcile-migrations.ts                        # per file: RECORDED / LIVE / ABSENT / PARTIAL
pnpm --filter @badabhai/db db:audit:live-drift         # live schema vs the Drizzle schema, both ways

# A MIGRATION APPLIED OUT OF BAND, ABOVE THE WATERMARK — db:migrate replays it. Check the replay
# is a no-op FIRST; for a permissions migration `db:verify:rls-lock` rehearses it for real.
pnpm --filter @badabhai/db db:migrate

# APPLIED OUT OF BAND, AT OR BELOW THE WATERMARK — db:migrate will skip it SILENTLY. Adoption is
# the only route. It is all-or-nothing, so pin the set with --only.

# HYGIENE — record the live-but-unrecorded files so the journal stops lying. No DDL runs.
# ⚠ THE `--only` SET BELOW IS THE 2026-08-20 EXAMPLE (0076–0080) AND IS SPENT — those five are
# recorded. For TODAY's debt use the three-name set in the drift table above; the SHAPE of the
# commands is what this block is for, never the names.
cd packages/db
npx tsx reconcile-migrations.ts                        # per file: RECORDED / LIVE / ABSENT / PARTIAL
npx tsx adopt-migrations.ts --only 0076_canonical_domain_skill_taxonomy,0077_ai_cost_running_totals,0078_unresolved_phrase_job_domain_id,0079_journey_read_indexes,0080_worker_feedback
npx tsx adopt-migrations.ts --only 0076_canonical_domain_skill_taxonomy,0077_ai_cost_running_totals,0078_unresolved_phrase_job_domain_id,0079_journey_read_indexes,0080_worker_feedback --apply --expect-host aws-1-ap-south-1.pooler.supabase.com
npx tsx adopt-migrations.ts --doctor                   # expect 84/84 match, 0 orphan rows
```

**The `--only` list is spelled out twice on purpose, and it is not padding.** Adoption is
all-or-nothing, and `0082` is unrecorded _and_ unadoptable — so a bare
`adopt-migrations.ts --apply` sweeps it into the set and correctly refuses all six, recording
nothing. That holds whether or not `db:migrate` has run first, which is what makes the pin
mandatory rather than tidy. A `<the same list>` placeholder in a runbook is the line someone
paraphrases at 2am; the literal one is the line they paste.

**Three properties worth knowing before running it, each demonstrated against production on
2026-08-20 rather than argued:**

|                                                                           | evidence                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| it cannot mark a **missing** migration as applied                         | `--only 0082_rls_lock_seven_tables`, run _before_ the apply → `REFUSING to record ANYTHING`, exit **1**, ten stated mismatches — nine of them the grants `0082` had not yet revoked                                                                                             |
| …and it keeps refusing once the objects arrive                            | the **same command after** the apply → `clean=0 mismatched=1`. The nine grant mismatches are gone — independent corroboration, from a second tool, that the lock really took — and the dynamic-SQL refusal stands. Verifiability is a property of the file, not of the database |
| it is **idempotent** — an already-recorded migration is not even selected | `--only 0048_empty_archangel` → `selected=0`, `nothing to do`                                                                                                                                                                                                                   |
| the five in the list verify **clean at full depth**                       | `clean=5 mismatched=0` — tables, columns _and their types_, indexes, constraints, RLS enable/force, and every `REVOKE ALL`                                                                                                                                                      |
| **idempotency, proven live rather than argued**                           | after the real run recorded all six, re-issuing the same `--apply` returned `recorded=84 unrecorded=0 selected=0`, `nothing to do`. The insert is `INSERT … WHERE NOT EXISTS` in one transaction, so it holds for overlapping runs too                                          |
| an **effect verifier** does not weaken any of the above                   | `0082` adopted on **42 catalog assertions**; remove the lock from any one of the seven tables and the same command refuses. Unit-tested in both directions                                                                                                                      |

The write itself is `INSERT … WHERE NOT EXISTS` inside one transaction, so the guard survives two
overlapping runs as well as two sequential ones — `__drizzle_migrations` has no unique constraint
on `created_at` to fall back on.

`--only` is required here, not optional: adoption is all-or-nothing, and `0082` is unrecorded
_and_ unadoptable, so an unpinned run correctly refuses the whole set. `--expect-host` is
not ceremony either — adoption records DDL as done **without running it**, so the wrong target
writes a false journal row that every later migration inherits.

**Adoption's two blind spots, and what one of them cost.** The depth check covers objects. Until
2026-08-20 it did **not** look at GRANTs, and it treated a migration with no checkable objects as
vacuously clean. That is how `0048` came to be recorded as applied with its twelve REVOKEs never
run — which is `R39`, and why `0082` exists. Both are refusals now, as is dynamic SQL. The
compensating control is `db:audit:rls`, which sweeps every live table for the lock rather than
trusting any migration to have applied it.

**And the direction nothing was checking at all:** `--doctor` only ever asked _"is each file
recorded?"_. It now also asks _"is each recorded row a file?"_. A row with no journal entry means
production has applied a migration this checkout does not contain — which is exactly how `0081`
was found to be taken while a second branch was minting its own.

### `0176` — additive, APPLY BEFORE DEPLOY (from the PR branch, before the merge), no backfill — 2026-11-17

#2749 item 9 (checkout) and the storage half of item 7 (GST). An order now charges the pack's
GST-inclusive **total**, so `payment_orders` stamps the whole `gstPriceLine(price)` it was charged
from, in integer paise, beside `amount_inr` — which keeps the whole-rupee total (the issue's
money-unit default). Also stamped at order time: the pack's credit validity (`credit_validity_days`,
so the settle never re-reads the catalogue), where the purchase started (`origin`, and
`origin_job_posting_id` when the posting is the buyer tenant's own), and the `product_kind` #2751
will widen. A new status, `held`: a webhook capture whose amount is not the order's total grants
nothing and parks the order there for ops (hardening 5).

| Column                                                                         | Type                                | Rule                                                                                                                                                                                   |
| ------------------------------------------------------------------------------ | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `product_kind`                                                                 | text NOT NULL DEFAULT `credit_pack` | `payment_orders_product_kind_chk` IN (`credit_pack`)                                                                                                                                   |
| `taxable_paise`, `gst_paise`, `round_off_paise`, `total_paise`, `gst_rate_bps` | integer, nullable                   | all five or none (`payment_orders_money_set_chk`); total = taxable + GST + round-off, > 0, a multiple of 100, = `amount_inr` × 100; rate 0–10,000 bps (`payment_orders_money_sum_chk`) |
| `credit_validity_days`                                                         | integer, nullable                   | > 0 (`payment_orders_validity_pos_chk`)                                                                                                                                                |
| `origin`                                                                       | text, nullable                      | `payment_orders_origin_chk` = `PAYMENT_ORDER_ORIGINS`                                                                                                                                  |
| `origin_job_posting_id`                                                        | uuid, nullable                      | FK `job_postings` ON DELETE SET NULL; partial index `payment_orders_origin_job_posting_idx`                                                                                            |

Relaxed, not removed: `pack_code` NOT NULL becomes `payment_orders_pack_code_chk` (only a
`credit_pack` order needs one) and `payment_orders_credits_pos_chk` binds a `credit_pack` order
only. Widened in place: `payment_orders_status_chk` gains `held`. Every pre-0176 row reads
`credit_pack`, no money columns, no validity, no origin, and satisfies every new CHECK.

**APPLY BEFORE DEPLOY, and from the PR branch before merging it** — merging auto-deploys.
`UnlocksRepository` reads and writes `payment_orders` with bare `.select()` / `.returning()`, and
Drizzle 0.45 names every model column there, so against a database without this file every order
creation, browser verify and Razorpay webhook fails (`42703`; the webhook 5xxs and Razorpay
redelivers). These routes are dark in production while `PAYMENTS_ENABLE_REAL` is off; the mock
`POST /payer/credits` does not touch the table. Readiness:

```bash
pnpm --filter @badabhai/db db:audit:schema-contract   # read-only; exits 1 if the DB is behind
```

The column entries also answer for the two CHECKs widened under their old names (one transaction:
if the columns are there, so are they).

**Adoption order** — the same rule as `0174`: apply and record every pending lower migration first,
or adopt **only** this one with `--only <this tag>` and do the lower ones by hand afterwards. Never
an unpinned adoption over this slot.

**The window between apply and deploy is safe.** The old build names none of the new columns: its
order insert gets `credit_pack` and null money, it never writes `held` or a null `pack_code`, and
its orders (`amount_inr` = the list price, no `total_paise`) are settled by the new build against
`amount_inr` × 100 — exactly what the old build asked Razorpay for.

**Locks, and a hand-written statement order.** Every lock is held until `COMMIT`:

1. the nine `ADD COLUMN`s and `pack_code DROP NOT NULL` — `ACCESS EXCLUSIVE` on `payment_orders`
   (every order read and write waits); catalog-only.
2. DROP + re-ADD the two relaxed / widened CHECKs, then the six new ones — each ADD validates the
   existing rows with one scan; cheap on a small table.
3. `payment_orders_origin_job_posting_idx` — partial, over an all-NULL column, so empty.
4. the `job_postings` FK **last** — `SHARE ROW EXCLUSIVE` on `job_postings` (posting writes wait;
   reads, the feed included, do not), held only until the `COMMIT` that follows.

No request locks `job_postings` and then `payment_orders`, so step 4 cannot deadlock with one.
**drizzle-kit generates the DROPs first and the FK in the middle: after any regenerate or renumber,
re-apply this order by hand** — `migration-0176-payment-order-money.test.ts` pins it. Apply in one
`BEGIN; SET LOCAL lock_timeout = '3s'; … COMMIT;` and retry on `55P03`.

**RLS.** Unchanged: `payment_orders` is already ENABLE + FORCE + REVOKE (0058); no new table.

**Rollback.** An **app-only** rollback is safe on this schema except for `held` orders: the old
build's settle claim is `status <> 'paid'`, so it would grant a held order on a webhook replay or a
verify, and its failure handler would overwrite `held` with `failed`. Resolve every held order
first (`SELECT id FROM payment_orders WHERE status = 'held'` returns nothing). Reverting the schema
too drops production columns (the paise record, the validity and the origin of every order since
this file), so it is an incident fix only; the statements are in the file header, ending with
`DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1794900885026;`.

### `0174` — additive, APPLY BEFORE DEPLOY (from the PR branch, before the merge), with backfill — 2026-11-16

#2749 items 2–4 (brief 4C.1, section 7): a company's balance becomes a set of **lots** that may
expire, spent soonest-expiring first, with a ledger line for every credit added, spent or expired.
One new table, `credit_lots` (`payer_id` = the wallet key, the same tenant key as
`payer_credits.payer_id`; `source`, `pack_code`, `payment_order_id`, `credits_granted`,
`credits_remaining`, `expires_at` — NULL never expires — `expired_at`, `is_test`), and one new
nullable column, `credit_ledger.lot_id` (FK, no cascade, indexed).

**The invariant**, per wallet: `payer_credits.balance = Σ open credits_remaining = Σ ledger delta`.
Every writer (the unlock debit, the mock pack, the Razorpay settle, the admin grant, the free-tier
grant and its D6 script, the expiry sweep) now goes through `packages/db/src/credit-wallet.ts`,
under the wallet row lock, in one order: wallet row → lots → ledger.

**APPLY BEFORE DEPLOY, and from the PR branch before merging it** — merging auto-deploys. Drizzle
0.45 names every model column in each insert, so the new build's ledger insert names `lot_id`, and
its wallet code names `credit_lots`. Against a database without this file every contact open, pack
purchase, Razorpay settle (5xx → Razorpay redelivers), admin grant and signup free-tier grant fails
(`42703` / `42P01`), and `GET /payer/credits` 500s. Registered in `schema-contract.ts`, so the
readiness question is answerable:

```bash
pnpm --filter @badabhai/db db:audit:schema-contract   # read-only; exits 1 if the DB is behind
```

**Adoption order — never lift the watermark over a pending lower migration.** drizzle's migrator
replays only files whose journal `when` is above the newest recorded row. `0164`–`0173` (and
anything else that lands below this slot on `main` before it merges, e.g. #2753's) may still be
unapplied on production. Recording this migration first would lift the watermark above them, and
`db:migrate` would then skip them **silently, for good**. So:

1. **Preferred:** apply every pending lower migration first, in journal order, record each, then
   apply and record this one.
2. **Otherwise:** adopt **only** this migration, pinned —
   `npx tsx adopt-migrations.ts --only <this tag> --apply --expect-host <prod host>` from
   `packages/db` — and apply + adopt every lower pending one by hand afterwards, each with its own
   `--only` (the `0135` precedent). Never run an unpinned adoption over this slot.

**The window between apply and deploy is safe and self-healing.** The old build names neither
object, so it keeps working — but it moves balances without lots. The new build's first touch of
each wallet re-aligns its lots with its balance (`alignLotsWithBalance`: top up a never-expiring
`legacy` lot, or remove the excess soonest-expiring first) and logs one `CreditWallet` **ERROR**
line, prefix `credit-wallet: lots out of step with balance`, with the wallet id and numbers.
Balance stays the source of truth; nobody gains or loses a spendable credit, and no ledger line is
written. After the window that line should never appear: one means a writer moved a balance
without going through the wallet helpers. The seeds (`seed-demand`, `seed-reach-pool`) and
`db:grant:free-tier --repair-balances` set balances the same way and are healed the same way.

**Backfill, in the same file:** one `legacy` lot per `payer_credits` row with `balance > 0`
(granted = remaining = balance, no expiry, `is_test` false). **No ledger line** — the ledger
already holds the grants those balances came from, so `Σ delta` is unchanged. The `INSERT` is
guarded by `NOT EXISTS`, so it alone can be re-run. No lot gets an expiry in this PR: packs gain
their validity with the catalogue (item 5), and what becomes of legacy balances is the switch-over
question in the issue.

**Locks, and a hand-written statement order.** Every lock is held until `COMMIT`, so the file
takes `credit_ledger`'s last:

1. `CREATE TABLE credit_lots` + `ENABLE RLS` — a new table; nothing waits.
2. the FK `credit_lots → payment_orders` — `SHARE ROW EXCLUSIVE` on `payment_orders` (blocks order
   creation and settle writes until `COMMIT`).
3. the three `credit_lots` indexes, FORCE + REVOKEs, and the backfill (`ACCESS SHARE` on
   `payer_credits`; it writes only `credit_lots`).
4. `ADD COLUMN credit_ledger.lot_id` — `ACCESS EXCLUSIVE` on `credit_ledger` (every ledger read and
   write waits) — catalog-only (nullable, no default) but **held to `COMMIT`**.
5. the FK `credit_ledger → credit_lots` — `SHARE ROW EXCLUSIVE` on `credit_lots`; validates an
   all-NULL column.
6. `credit_ledger_lot_id_idx` — built non-concurrently under the lock above.

`payment_orders` before `credit_ledger` is the settle path's own order (claim the order, then write
the ledger), so a settle in flight can never hold `credit_ledger` while waiting on this migration's
`payment_orders` lock. **drizzle-kit generates step 4 before step 2 and knows nothing of the
backfill: after any regenerate or renumber, re-apply this order by hand** —
`migration-0174-credit-lots.test.ts` pins it. Apply in one
`BEGIN; SET LOCAL lock_timeout = '3s'; … COMMIT;` and retry on `55P03`.

**RLS.** ENABLE is generated; FORCE and the four REVOKEs are hand-appended (a regenerate drops
them). `credit_lots` is in `LOCKED_TABLES` (`tests/e2e/rls-spine.e2e.test.ts`), census C5,
`ORG_TARGET_TABLES` (`reconcile-migrations.ts`) and T5's `TENANT_TABLES`. Pinned by
`packages/db/src/migration-0174-credit-lots.test.ts`.

**Erasure.** None, by design: lots are billing records with no FK to `payers`, kept through a
payer account deletion like `credit_ledger` and `payment_orders`.

**Rollback** — revert the app first (the new build cannot write a ledger line without `lot_id`).
It drops a production column, so it is an incident fix only, and lossy once any lot carries an
expiry:

```sql
ALTER TABLE "credit_ledger" DROP CONSTRAINT "credit_ledger_lot_id_credit_lots_id_fk";
DROP INDEX "credit_ledger_lot_id_idx";
ALTER TABLE "credit_ledger" DROP COLUMN "lot_id";
DROP TABLE "credit_lots";
DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1794829712236;
```

Remove `credit_lots` from `LOCKED_TABLES` in the same change that drops the table.

### `0082` — R39: permissions only, APPLY ANY TIME, no backfill — 2026-08-20

**Not additive and not destructive — it changes only who may reach seven tables.** No CREATE,
no ALTER COLUMN, no DROP, and it grants nothing to anyone. A test asserts all four of those
properties against the file itself.

**What R39 is.** `db:audit:rls` sweeps all 77 public tables for the three conditions the house
pattern requires — RLS enabled, FORCE, and no grant to a Data-API role. Seven fail. Measured
2026-08-20: every one is **empty (0 rows)**, owned by `postgres`, with 0 policies.

**The grant is the finding, not the missing FORCE.** "RLS is on with zero policies, so
everything is denied" is true for `anon` and `authenticated` and **false for `service_role`**,
which has `rolbypassrls = true` — RLS does not apply to it at all, so the grant is the only
control and on these seven it is wide open, every DML privilege plus TRUNCATE. Three of the
seven are correctly FORCEd _and still reachable_, which is what makes this worth a migration
rather than a note.

**Two sections, because the seven divide.**

|       | tables                                                                               | why                                                                                                                                                                                                      |
| ----- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A** | `agency_kyc`, `agency_payout_accruals`, `agency_payout_requests`                     | `0048` already declares FORCE + all four REVOKEs for them. Its DDL is live and it is _recorded_, but its REVOKE tail never ran on production. Unconditional here; a no-op wherever `0048` ran in full    |
| **B** | `agency_profiles`, `employer_profiles`, `payer_capabilities`, `payer_member_invites` | exist on production and in **no** migration and **no** schema file (`GAP-DB-21`). Guarded by `to_regclass` — an unconditional ALTER would abort `0082` on every fresh database and take the slot with it |

**Dropping the four is the better end state and is deliberately not this migration.**
`GAP-DB-21`'s recorded recommendation is to drop them — `payer_member_invites` FKs to
`auth.users` (Supabase Auth, unused here) and `payer_capabilities` is superseded by the shipped
`org_role` enum. That is a destructive production action needing an owner's ruling. Locking them
costs nothing and does not prejudge it.

**Rehearsed, not reasoned.** `pnpm --filter @badabhai/db db:verify:rls-lock` runs the exact
statements against the live database inside a transaction that **cannot commit**, then re-reads
the catalog after the rollback and fails if anything moved. It answers the three things review
cannot: that the REVOKEs actually take (a REVOKE only removes grants the executing role may
remove — every grant here has `grantor = postgres`, and so does the migration), that FORCE does
not lock the backend out (`postgres` is `rolbypassrls`), and that the Section-B guard does not
silently skip a table that is present. **22/22 PASS against production, 2026-08-20.**

**Timing.** ACCESS EXCLUSIVE per statement, microseconds each, seven empty tables. Run under
`SET lock_timeout = '3s';` and retry on 55P03, per the `0073`/`0077`/`0080` precedent.

**Rollback.** Re-grant. Nothing is lost and no data moves — the grants being restored are the
finding.

**Hand-written, not generated.** Drizzle-kit models `ENABLE ROW LEVEL SECURITY` and nothing else
about the lock, so there is no model change to generate from. `meta/0082_snapshot.json` is a copy
of `0081`'s with a fresh `id` and `prevId` chained to it — genuinely unchanged, because nothing
in the model moves. Verified: `npx drizzle-kit generate` after this lands emits _"No schema
changes, nothing to migrate"_.

**Slot — and the fourth collision this file has recorded.** Minted as `0081`, renumbered to
`0082` before merge: `#1036` took `0081` (`0081_worker_feedback_screen_context`) and **applied it
to production** while this branch was in flight, so the clash was not only in the tree, it was
already in `drizzle.__drizzle_migrations`. Nothing local reported it — every tool asked "is each
FILE recorded?" and none asked "is each RECORDED ROW a file?". That direction is now part of
`adopt-migrations.ts --doctor`. REGENERATED, NOT RENAMED (the `0071` rule): the snapshot was
re-derived from `0081`'s, so `0082_snapshot.json.prevId == 0081_snapshot.json.id`, verified by a
`db:generate` that emits nothing. The pre-renumber file was never applied anywhere, so its `when`
needed no pinning. **OIE moves to `0083`.**

### `0079` — renumbered from `0078` after a live collision — 2026-08-19

**This is the collision this file exists to describe, and it happened again.** `#992` minted
`0078_journey_read_indexes` (two CREATE INDEX statements, nothing else) while S3-C minted
`0078_unresolved_phrase_job_domain_id` on another branch. S3-C merged first, so `#992` moved to
`0079` per rule 2 — taking the last slot of the OIE block, exactly as `0077` and `0078` took the
first two, and for the reason recorded there: drizzle-kit assigns sequentially and
`supabase-checks.yml` enforces contiguous prefixes, so there is exactly one legal next number.
**OIE's orchestrator/profiling/parse migration is now `0080`.** The block reservation has now
been overtaken three times; it is a record of intent, not a reservation the generator honours.

**REGENERATED, NOT RENAMED** — the `0071` rule. A drizzle snapshot chains to its predecessor by
`prevId`, so a renamed `0078_snapshot.json` would still have chained off `0077`, and the next
`db:generate` would have diffed against a schema that skipped `0078_unresolved_phrase_job_domain_id`
entirely. Verified after regeneration: `0079_snapshot.json.prevId == 0078_snapshot.json.id`, and a
second `db:generate` emits nothing.

**The `when` was NOT pinned, and that is the opposite of what `0071` did.** `0071` kept its
pre-renumber timestamp because its old file had already been applied to a live database and
drizzle's migrator is timestamp-driven (`created_at < folderMillis`), so a newer `when` would have
re-run its `CREATE TABLE`. Here the pre-renumber file has ALSO been applied by hand to a live
database — but the two statements are `CREATE INDEX IF NOT EXISTS`, so re-running them is a no-op,
while pinning the old `when` (`1787058904704`) would order this entry BEFORE
`0078_unresolved_phrase_job_domain_id` (`1787061158602`) and make every database that applied
`0078` skip this file forever. Idempotent DDL is what makes the fresh timestamp the safe choice;
`0071`'s was not idempotent, which is why it needed the other answer. **The journal row the manual
apply wrote under the old timestamp must be deleted from that database** — otherwise its
`created_at` high-water mark is `1787058904704`, which is fine, but the row claims a hash for a
file that no longer exists.

**`IF NOT EXISTS` is hand-re-appended.** `db:generate` emits both statements bare — verified on
this regeneration, not assumed. This is the same class of hand-edit as `NULLS NOT DISTINCT` in
`0037`/`0067`/`0072`/`0076`/`0078`, and it is load-bearing twice over: the migration's own TIMING
note tells an operator to build `events`' index CONCURRENTLY outside the transaction and let the
statement no-op, and the live database that took the manual apply already holds both indexes under
these exact names.

**NOT apply-before-deploy.** Both journey queries are correct without the indexes and merely slow,
so an app deployed ahead of this file serves identical JSON off a sequential scan. It IS
apply-before-the-page-carries-real-traffic. Rollback is two `DROP INDEX`es with the app live —
nothing references an index, and the reads return the same rows, slower. The full reasoning,
including the `events` write-lock caveat, is in the migration's own header.

### `0080` — additive, APPLY BEFORE DEPLOY, no backfill — 2026-08-19

One new table, `worker_feedback`: the worker taps the app-wide Feedback button (#997), types free
text, optionally tags it, and it lands here for ops to read in the admin portal.

**Renumbered `0079` → `0080` mid-review**, after `#992` took `0079` while this branch was in flight — the third time the OIE block has been overtaken, and the second collision this file has recorded in one day. REGENERATED, NOT RENAMED (the `0071` rule): the snapshot was deleted and `db:generate` re-run against a tree that already contained `0079_journey_read_indexes`, so `0080_snapshot.json.prevId == 0079_snapshot.json.id` and a second `db:generate` emits nothing. The pre-renumber file was never applied to any database, so nothing needed its `when` pinned. **OIE moves to `0081`.** _(Superseded twice. 2026-08-19: `0081` went to `worker_feedback.screen_context`, the #997 follow-up. 2026-08-20: `0082` went to the R39 lock, itself renumbered out of `0081` after `#1036` took that slot AND applied it to production mid-flight. **OIE's block is `0084`+ — and the reserved-block table above is the authority, not this line.** Left here rather than rewritten, because this paragraph is the record of what was decided at the time; a stale forward-pointer in a slot register is exactly what the fourth collision was made of.)_

**APPLY BEFORE DEPLOY**, and unlike `0077` there is no savepoint softening it.
`FeedbackRepository.insert` names `worker_feedback` unconditionally on the request path of
`POST /workers/me/feedback`, and that INSERT shares a transaction with its `feedback.submitted`
event — deliberately, so a feedback row without an audit record cannot exist. Against a database
without this file, every submission is a 500 **and the worker's typed message is gone with the
response**; `GET /admin/feedback` 500s on its first page load. Both failures are loud, which is the
one respect in which this is easier than `0078`.

Because it is apply-before-deploy, it is registered in `packages/db/src/schema-contract.ts` as
`0080-worker-feedback-table`. That makes the readiness question answerable rather than reportable —
the `0078` lesson:

```bash
pnpm --filter @badabhai/db db:audit:schema-contract   # read-only; exits 1 if the DB is behind
```

**No backfill, and none is possible.** There is no prior source of worker feedback; this table
starts the record.

**Time the DDL under a `lock_timeout`.** The single `ADD CONSTRAINT ... FOREIGN KEY` takes
`SHARE ROW EXCLUSIVE` on `workers`, which conflicts with the `ROW EXCLUSIVE` every ordinary write
holds. Validation is instant — the table is empty — but the request queues behind any in-flight
transaction on `workers`, and every writer arriving after it queues behind the request. Same
guidance as `0073` and `0077`: `SET lock_timeout = '3s';` and retry on `55P03`.

**The RLS tail is hand-appended and matters more here than on any table before it.** drizzle-kit
models `ENABLE` and neither `FORCE` nor the four `REVOKE`s; without `FORCE` the table owner — the
only connection the backend uses — walks straight through every policy. `message` is the **one
column on this spine deliberately allowed to contain a worker's own PII** (their name, their phone
number, their employer, because the product invites them to say anything), so a permissive default
here exposes free-text personal data across the whole worker base to every PostgREST role. A
`db:generate` re-run drops those five statements silently; `packages/db/src/worker-feedback-schema.test.ts`
is what catches it.

**Privacy, stated once so it is not re-litigated later.** The words live in this table and nowhere
else. `feedback.submitted` carries `message_length`, never the text — the same ruling
`job.search_performed` made about the search term — and `FeedbackService` logs an id prefix, a
category and a length. Erasure needs no code: `WorkersRepository.hardDelete` enumerates no table
names, so the `ON DELETE cascade` from `workers` **is** the DPDP/DSAR coverage.

**Rollback is one statement, and it is lossy in a way the others were not.**

```sql
DROP TABLE IF EXISTS "worker_feedback";
```

No other table has an FK to it, no view or function selects from it, and its own FK and three
indexes go with it. But it is **not** safe with the app live — there is no savepoint, so both
endpoints 500 immediately; revert the app first. And unlike `0077`, nothing reconstructs the data:
the rows _are_ the record and the event spine holds only lengths by design. Export before dropping
if the table is not empty. `worker_feedback` is also listed in `LOCKED_TABLES` in
`tests/e2e/rls-spine.e2e.test.ts`, which asserts RLS + FORCE + no-grants per **name** — remove that
entry in the same change that drops the table.

**Event contract:** adds `feedback.submitted` (v1) and a new `"feedback"` event domain. Nothing
existing changes.

### `0078` — additive, APPLY BEFORE DEPLOY, no backfill — 2026-08-18

**It takes the second slot of the OIE block**, exactly as `0077` took the head, and for the same
reason: the block was reserved before either workstream existed, and leaving a hole to preserve a
stale reservation costs more than re-recording it. `0079` was OIE's last remaining slot when this
note was written; it has since gone to `#992` (see the `0079` note above), so OIE now lands on
`0080`.

**APPLY BEFORE DEPLOY. Corrected 2026-08-19 — the first version of this note said the opposite,
and was wrong.**

The reasoning it gave ("nothing writes `job_domain_id` unless a caller sends one, and no caller
does") describes the DTO, not the SQL. `SkillsRepository.recordUnresolved` names the column in the
INSERT list and in the `ON CONFLICT` target **unconditionally** — a legacy or occupation miss binds
NULL for it, but the column still has to exist. Against a database without `0078` every unresolved
write fails, not just a canonical one: `42703 column "job_domain_id" does not exist`, or `42P10` on
the conflict target, which must name the widened index's exact five columns.

**The path that would actually have hit it is the occupation one, and it runs today.**
`IdentifyService` → `OccupationService.recordUnresolved` → the same widened SQL, on every
below-floor trade phrase in a live worker interview. Blast radius was bounded rather than
catastrophic — `identify.service.ts` wraps the call in try/catch and logs "the interview is
unaffected", so the failure mode is **growth signal silently lost**, not a 500 for the worker. That
is a fail-soft worth having and not a reason the ordering claim was acceptable.

**APPLIED TO PRODUCTION 2026-08-19, and verified rather than taken on report.** An earlier
version of this note claimed the same thing a day too early, on report, and it was false: at that
point the column did not exist while the code that names it was already deployed, so every
unresolved write was failing (the interview path swallowed it; the two `unresolved` endpoints
returned 500). That is the whole reason the check below exists.

Verified state after the apply:

| object                                | state                                                                                                 |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `unresolved_phrase.job_domain_id`     | `text`, nullable                                                                                      |
| `unresolved_phrase_scope_uq`          | `(scope, phrase, domain_id, job_domain_id, lang) NULLS NOT DISTINCT`                                  |
| `unresolved_phrase_one_domain_chk`    | `CHECK ((domain_id IS NULL) OR (job_domain_id IS NULL))`                                              |
| `unresolved_phrase_job_domain_id_idx` | btree on the FK column                                                                                |
| FK                                    | `job_domain(job_domain_id)`, `ON DELETE NO ACTION`                                                    |
| rows                                  | **9 preserved**, summed `count` 10, `first_seen` and `last_seen` untouched. No row split, none merged |

The write path was then exercised against the real production schema inside a transaction that
was rolled back — canonical, legacy and occupation shapes all upsert; the same phrase in two
different job domains produces two DISTINCT rows (the point of the widening); a repeat dedupes and
increments; both-set is refused by the CHECK; a bogus `job_domain_id` is refused by the FK. Row
count and summed `count` were identical before and after, so production carries nothing from it.

**Do not take a migration's application on report.** `drizzle.__drizzle_migrations` will not
settle it either — production shows 76 applied rows against 79 files, because earlier migrations
were baselined, so the count reads as alarming and means nothing. Ask for the OBJECTS:

```bash
pnpm --filter @badabhai/db db:audit:schema-contract   # read-only; exits 1 if the DB is behind
```

That check is manifest-driven (`packages/db/src/schema-contract.ts`) and covers every object the
deployed code names unconditionally. It verifies the unique index's SHAPE, not merely its
existence — a same-named index with the old four-column list is the quieter failure, because two
canonical misses of one phrase in different job domains would merge into a single summed row with
nothing raised anywhere.

The reverse order is still safe: applying `0078` ahead of the code changes nothing, since the
column is nullable with no default and the pre-`0078` SQL never mentions it.

**What it does, and the one part that is easy to get wrong:**

| statement                                                              | note                                                                                                                                                                                                                                                                                                                                                |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ADD COLUMN job_domain_id text` + FK to `job_domain`                   | nullable, defaultless → catalogue-only on PG11+, no rewrite                                                                                                                                                                                                                                                                                         |
| `DROP` + re-`CREATE` `unresolved_phrase_scope_uq` with `job_domain_id` | **the load-bearing statement.** Without it two canonical misses of one phrase in different domains both carry `domain_id IS NULL`, collide on the old 4-column key, and merge into a single row with a summed `count`. No error; the data is simply wrong, and wrong in the direction that makes Path A look healthier than it is                   |
| `NULLS NOT DISTINCT` re-appended BY HAND                               | fourth time in this schema (`0037`, `0067`, `0072`, `0076`). `db:generate`'s output for THIS migration omitted it again — verified, not assumed. Dropping it is an active regression: the occupation scope has written `domain_id = NULL` since `0070` and depends on NULLs deduping onto one row. Pinned by `unresolved-phrase-job-domain.test.ts` |
| `unresolved_phrase_one_domain_chk`                                     | at most one vocabulary per row. Three legal shapes (legacy / canonical / occupation-both-null); only both-set is refused                                                                                                                                                                                                                            |

**Index rebuild lock:** DROP + CREATE, not CONCURRENTLY — drizzle wraps each migration in a
transaction and `CREATE INDEX CONCURRENTLY` cannot run in one. `unresolved_phrase` held **9 rows**
in production when this was authored (measured), so the window is sub-millisecond. Re-measure
before applying if that has changed by orders of magnitude.

**Rollback** is written into the migration's own footer, and is lossy only once canonical misses
exist — after that, re-derive from `skill.phrase_unresolved_v2` on the event spine before dropping.

**Event contract:** adds `skill.phrase_unresolved_v2`; `skill.phrase_unresolved` v1 is untouched
and still emits for legacy-scoped misses. A second registry entry rather than relaxing v1's
required `domain_id`, which would break every consumer reading the field without a null check.

### `0077` — additive, no ordering constraint, no backfill — 2026-08-18

**NOT apply-before-deploy — BUT ONLY BECAUSE OF THE SAVEPOINT.** It creates three empty tables
(`worker_ai_cost_totals`, `session_ai_cost_totals`, `platform_ai_cost_totals`) that nothing reads
yet. Deploying the app before applying it does not break a request, and does not lose an event
either: the only writer is `AiCostRecorder.record()`, which runs the accrual inside a `SAVEPOINT`
on the event's transaction and catches its failure, so the `ai.cost_recorded` row still commits.
The cost is accuracy (uncounted spend), not uptime and not the ledger.

That qualifier is the whole claim. Without the savepoint this line was **false**: the accrual's
unconditional `platform_ai_cost_totals` upsert raises `relation "platform_ai_cost_totals" does
not exist`, which aborts the enclosing transaction, and Postgres executes the eventual `COMMIT`
as a `ROLLBACK` — so every `ai.cost_recorded` event on every surface would have been silently
dropped for as long as the app ran ahead of the migration, one `warn` line each. If anyone ever
removes the savepoint, this migration becomes apply-before-deploy and this row must change with
it. Staging CD already migrates before it deploys (`.github/workflows/staging-cd.yml`), so the
exposure was never staging's normal path — it is the rollback path, a hand-run deploy, and any
environment whose migration step is separate from its deploy step.

**No backfill ships with it.** The tables accrue from the moment they exist; spend already on the
event spine is not counted, so every figure derived from them means "since 0077" until a backfill
is separately authorised and run against `events WHERE event_name = 'ai.cost_recorded'`.

**Rollback is three `DROP TABLE`s** in any order — no other table has an FK to them, no view or
function selects from them, and the only code that touches them is `AiCostTotalsRepository`, whose
single caller runs in that savepoint. So dropping them **while the app is live** degrades cost
accrual to a warn per AI call and changes nothing else; the event spine they are derived from is
untouched, and a re-apply plus a backfill reconstructs every figure exactly. Dropping the _code_
first is optional, not required.

One thing a rollback must not forget: all three tables are listed in `LOCKED_TABLES` in
`tests/e2e/rls-spine.e2e.test.ts`. That gate asserts RLS + FORCE + no grants on each name, so it
fails on a table that no longer exists — remove those three entries in the same change that drops
the tables.

**Time the DDL under a `lock_timeout`.** The `ADD CONSTRAINT ... FOREIGN KEY` statements take
`SHARE ROW EXCLUSIVE` on `workers` (twice) and `chat_sessions` — the two hottest worker-side
tables — which conflicts with the `ROW EXCLUSIVE` every ordinary write holds. Validation itself is
instant (the new tables are empty), but the request queues behind any in-flight transaction on
those tables and every writer arriving after it queues behind the request. `0073` set the same
precedent, so this is timing guidance, not a blocker:

```sql
SET lock_timeout = '3s';   -- fail fast rather than stall the write path
-- run the migration; on 55P03 (lock_not_available) wait and retry
```

**It takes the head of the OIE block.** `0077`–`0079` was reserved for Occupation Intelligence;
that workstream has not minted `0077` on any branch, and this file's own rule is that the claim is
recorded in the change that takes it. OIE's remaining slot is now `0080` — `0078` went to S3-C and
`0079` to `#992`.

### `0076` deploy ordering and rollback — 2026-08-16

Two operational facts that the migration header does not carry, recorded here because both
were found by review rather than by anyone hitting them.

**MIGRATE BEFORE YOU DEPLOY.** `0076` adds `job_postings.job_domain_id`, and `schema/job.ts`
adds the matching Drizzle column. Drizzle enumerates columns explicitly on `.select()`, so a
`@badabhai/db` build containing that column, deployed against a database that has not run
`0076`, fails **every** `job_postings` read with `column "job_domain_id" does not exist` — not
merely the new canonical arm. There is no application-level feature flag that avoids this; the
ordering is the control.

**THE ROLLBACK IS NO LONGER SINGLE-COMMIT.** The recipe in the migration header was written at
Phase 1 and is correct in isolation. `ef73ce70` then made
`apps/api/src/skills/skills.repository.ts` query `job_domain_skill` directly, so reverting
`0076` now requires reverting `ef73ce70` in the same operation. Today the blast radius is
compile/deploy-time rather than request-time — nothing writes `job_postings.job_domain_id`
yet, so the canonical arm is unreachable at runtime — but the pairing is real and the header
does not mention it.

### The `0076` claim, and the stale table that preceded it — 2026-08-16

Two things were wrong here and both are worth recording, because the second is the kind of
error this file exists to prevent.

**The head was stale by five migrations.** This table claimed `0071` / 72 entries while the
journal actually held 76 entries through `0075_job_postings_state`. Anyone trusting it for
"the next free number" would have minted `0072` and collided with a merged migration. The
protocol's whole premise is that git will not warn you — a reservation table that lags the
journal is worse than no table, because it is confidently wrong. **Refresh the head in the
same PR that claims a block, not later.**

**`0075`–`0079` was reserved for OIE, and `0076` was taken anyway.** Deliberately, and on
this evidence: the OIE sprint plan documents its own nominal `0075`/`0076` claims being
renumbered down to `0071`/`0072` (drizzle-kit assigns sequentially, so a reservation cannot
survive contact with the generator); `0075` was then consumed by an unrelated job-search
change under a different owner; no branch of the 86 on `origin` holds a `0076`+ file; and
`.github/workflows/supabase-checks.yml` enforces contiguous prefixes, so skipping to the
unclaimed `0080` is not reachable — there is exactly one legal next number.

The block reservation was already not being honoured as written. Rather than pretend
otherwise, the remaining OIE slots are renumbered to `0077`–`0079` above. **If that conflicts
with in-flight OIE work, this is the line to argue with** — the migration itself is
additive and its rollback is documented in its own header.

### The `0070` collision — 2026-08-07, and it happened exactly as this file predicted

Two branches minted `0070` on the same day. `#646` (notification prefs) took
`0070_bent_storm`; the voice data spine took `0070_confused_human_cannonball`. Git warned nobody,
and the second PR only discovered it as a merge conflict.

**One author was not enough to prevent it.** The voice-spine branch deliberately took a contiguous
number outside its nominal block on the reasoning that Prakash owned both backend workstreams, so
there was no second party to collide with. That reasoning was wrong, and the way it was wrong is
worth keeping: the collision risk is per **concurrent branch**, not per person. A single developer
running two sessions against one repo is two branches, and the protocol's whole purpose is that git
will not warn you. **Reserve by workstream even when you own every workstream.**

Renumbered to `0071` per rule 2 — and **regenerated rather than renamed**, because a drizzle
snapshot chains to its predecessor by `prevId`. A renamed `0070_*_snapshot.json` would still have
chained off `0069`, so the next `db:generate` would have diffed against a schema that skipped
`0070_bent_storm` entirely and emitted a migration to "add" columns that already exist. The
regenerated SQL was verified **byte-identical** to the original apart from the hand-appended RLS
tail, which was re-appended byte-for-byte.

### `when` was pinned, on purpose — read this before touching `0071`'s journal entry

`0071`'s journal `when` is **deliberately kept at the pre-renumber value** (`1786100629365`) rather
than the fresh timestamp `db:generate` emitted.

The reason is in drizzle's own migrator (`pg-core/dialect.js`): it applies a migration only when
`Number(lastDbMigration.created_at) < migration.folderMillis`. It is **timestamp-driven, not
hash-driven and not name-driven**. The old `0070_confused_human_cannonball` had already been applied
to a live database, stamping `created_at = 1786100629365`. Had the renumbered file carried a newer
timestamp, drizzle would have tried to re-run `CREATE TABLE worker_attributes` on a database that
already has it, and the whole chain would have died there.

Keeping the timestamp makes both cases correct with no manual intervention:

- a database that **already applied** the pre-renumber file: `0071` is skipped (equal, not less), and
  nothing is re-run;
- a database that **has not**: `0071.folderMillis` is still greater than `0070_bent_storm`'s, so it
  applies in order.

**The one case it does NOT fix, and it is not fixable in the repo:** any database that applied the
pre-renumber `0070` **before** `0070_bent_storm` landed will now skip `0070_bent_storm` forever, its
`created_at` being the smaller number. That database is missing `workers.notifications_enabled` and
`workers.notifications_read_at`, and the notification-prefs code from #646 will fail against it. The
remedy is manual and one-time: run `0070_bent_storm.sql` by hand, then
`INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES (<sha256 of the file>, 1786099264002)`
so the bookkeeping matches reality. It does not disturb `order by created_at desc limit 1`.

`0068` was released by the OIE sprint plan (below) and is now **taken** by the referral-metadata
workstream — a contiguous claim, so `idx` stays equal to the tag number and drizzle's snapshot
chain is unbroken. Divyanshu's OIE block therefore starts at `0069`; it lost a slot, not a
position. The alias unique index and the HNSW retune that originally held `0068` were folded
into `0067` and need no number of their own:

The sprint plan had reserved it for the alias unique index and the HNSW
retune, deferred until after `db:normalize:aliases` had run — because a unique index on
`(job_domain_id, text_norm, lang) NULLS NOT DISTINCT` fails while `text_norm` is still NULL
(every domain with 2+ aliases is a duplicate; verified against the live catalogue). Making that
index **partial on `is_searchable`**, which defaults to false, removes the ordering dependency
entirely — the index is empty at creation and cannot fail — so both statements folded into
`0067`. Two migrations that must be separated by a mandatory data-runner run is a deploy hazard;
one order-independent migration is not.

## Rules

1. **Rebase before you generate.** Never run `pnpm db:generate` on a branch that is behind `main`.

2. **Stay in your block.** If drizzle assigns a number outside it:
   - rename the `.sql`,
   - renumber `idx` in `meta/_journal.json` (keep `when` monotonic with `idx`),
   - rename the matching `meta/NNNN_snapshot.json`,
   - re-run `pnpm db:migrate` against a **fresh** database to confirm it still applies cleanly.

3. **A pure refactor must emit nothing.** After any change that only _moves_ schema code between
   modules, `pnpm db:generate` must produce **no** migration. Drizzle diffs the schema against the
   latest snapshot, so an emitted file means you changed semantics, not just layout. Delete the
   emitted `.sql` and snapshot, restore `_journal.json`, and fix the refactor.

   This is the standing verification for any `packages/db/src/schema/` reorganisation:

   ```bash
   pnpm db:generate
   node -e "const j=require('./packages/db/migrations/meta/_journal.json');console.log(j.entries.length, j.entries.at(-1).tag)"
   git status --short packages/db/migrations   # must be EMPTY
   ```

4. **Expand-only by default.** Per `CLAUDE.md` §10: never drop a production column, never rename
   without a migration, prefer additive. Anything risky goes expand → migrate → contract across
   separate releases.

5. **Comments carry the number.** If you renumber, grep for the old number and fix the prose —
   `schema.ts`, the runner headers under `packages/db/src/`, and `infra/supabase/rls-plan.md` have
   all drifted this way before. Be careful: some `0060` references legitimately point at
   `0060_referral_links_and_clicks.sql` and must **not** be rewritten.

## Deploy gates

Reference-data migrations have verifier scripts that exit non-zero on failure. Run them after
`pnpm db:migrate`:

```bash
pnpm db:verify:domains    # job_domain / job_domain_alias catalogue
pnpm db:audit:domains     # files <-> DB id-set diff, both directions
```
