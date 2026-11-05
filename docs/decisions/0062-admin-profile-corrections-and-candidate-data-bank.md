# ADR-0062: Admin profile corrections and the candidate data bank

- **Status:** Accepted — owner sign-off by Prakash Kantumutchu, 2026-11-04, including the security review amendments.
- **Date:** 2026-11-04
- **Owner:** Prakash (Backend Platform, admin module)
- **Needs:** no migration ships with this ADR. The implementation issues allocate additive migrations: `worker_admin_override` (#2561), `admin_candidate_index` (#2557), and the `generated_resumes_generation_trigger_chk` widening for `admin_edit` (#2561). Each code change that reads a new table or column is apply-before-deploy for that migration.
- **Amends / extends:**
  - [ADR-0025](0025-admin-ops-portal.md) — three new admin capabilities and a new read surface.
  - [ADR-0042](0042-profile-road-separation.md) D9 — the correction layer becomes the first source of record for an edited fact, ahead of the precedence rules this ADR otherwise keeps.
  - [ADR-0043](0043-resume-history-and-chat-update.md) — a new résumé generation trigger, `admin_edit`.
  - [ADR-0047](0047-lift-pii-restriction.md) — the name-search representation and the raised name-view budget.
  - [ADR-0031](0031-account-deletion-grace-window.md) and [ADR-0026](0026-production-worker-auth-pin-and-tiered-sessions.md) — both new worker-linked tables cascade on worker deletion.

## 1. Context

Support cannot fix a wrong candidate profile. A misheard city, a missing skill, the wrong trade or experience is corrected only by editing the database by hand, and the next interview, trade form, chat edit or résumé import writes over it. There is no record of who changed what, when, or why, and no way to put the worker's own value back.

The admin console also cannot find a worker quickly. The worker list reads `workers` with a status filter and no search or sort; the fields employers actually see are spread across `worker_profiles`, `worker_skill`, `worker_industry_tenure`, `worker_attributes`, `worker_employment`, `worker_education` / `worker_certificates` / `worker_training`, `worker_language`, `worker_profiling_tier`, `generated_resumes`, `worker_devices`, `worker_consents` and `worker_ai_cost_totals`. Computing them per request does not scale to 20–30K workers, and re-implementing the precedence rules in SQL would drift from the readers employers use.

The owner ruled on 4 November 2026 that support may correct every candidate field except name, phone and photo visibility, that corrections live in their own auditable layer and win everywhere until reverted, and that the Candidates grid may show names under a raised, audited budget. This ADR records those decisions and settles the mechanics the implementation issues depend on.

## 2. Owner decisions (verbatim, 4 Nov 2026)

- Super admin, ops and support can create, change and clear **every candidate field except name, phone and photo visibility**. Every change needs a written reason, emits an event and can be reverted to the worker's own value.
- Corrections live in their own layer (who, when, why) and win over interview, form, chat and résumé-import values everywhere — profile, employer search, job matching, résumé — until reverted.
- The worker gets a push message when an admin changes their profile. No worker-app change.
- The Candidates grid shows names to super admin, ops and support; analysts see none. The name-view budget is raised for those roles; every view stays audited.
- Search: full phone number exact; names by whole word exact; everything else partial.
- Numbered pages with an exact total (25/50/100 per page).
- User accounts covers payer logins only; workers keep phone code + PIN.

### Owner rulings, 4 Nov 2026 (second batch)

- **A1 — the worker's own explicit edit wins.** When a worker later edits a field an admin corrected, the worker's own explicit edit supersedes the correction. Automated sources — interview extraction, trade-form inference, résumé import and any `ai_service` actor or LLM parsing — never override an admin correction.
- **A2 — the raised Candidates name budget applies to every named session.** The 2,000/hour and 10,000/day per-admin budget applies to every super_admin, ops_admin and support session, whether or not two-step sign-in is on. The owner accepts this risk; it is recorded in the risks register.
- **A3 — the WhatsApp number is locked like phone.** `workers.whatsapp_enc` is not editable through the correction layer, exactly like `workers.phone_e164`.
- **A4 — a separate per-admin name/phone search cap.** Name and phone searches are limited to 300 searches/hour and 2,000/day per admin.

## 3. Decision

### 3.1 The correction layer

New table `worker_admin_override`:

| Column          | Type                                                | Meaning                                                                                                                                                                                                                  |
| --------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`            | `uuid` primary key, `default gen_random_uuid()`     | The override's opaque id; the value carried by events.                                                                                                                                                                   |
| `worker_id`     | `uuid NOT NULL` → `workers(id)` `ON DELETE CASCADE` | DPDP erasure removes the correction with the worker.                                                                                                                                                                     |
| `fact_key`      | `text NOT NULL`                                     | The corrected field key (see §3.2 and the table in §4), behind a CHECK over the closed §4 list.                                                                                                                          |
| `value_enc`     | `text NOT NULL`                                     | The `{corrected, previous}` envelope, serialized and encrypted with `PiiCryptoService.encrypt` (it can hold employer names, licence numbers and similar). The envelope is internal; no event or log carries either half. |
| `admin_id`      | `uuid NOT NULL`                                     | The acting admin, opaque. Stored so the audit survives a role change.                                                                                                                                                    |
| `reason_code`   | `text NOT NULL`                                     | Closed reason code, the same discipline as `admin.action_performed`.                                                                                                                                                     |
| `reason_text`   | `text NOT NULL`                                     | The written reason, 15–500 characters. Rejected with 400 when `containsHardIdentifier` finds a hard identifier. Admin-authored free text; never evented or logged.                                                       |
| `created_at`    | `timestamptz NOT NULL DEFAULT now()`                | When the correction became effective.                                                                                                                                                                                    |
| `superseded_at` | `timestamptz NULL`                                  | Set when the row is replaced by a newer correction or reverted.                                                                                                                                                          |
| `superseded_by` | `uuid NULL` → `worker_admin_override(id)`           | The replacing row. `NULL` with `superseded_at` set means a revert, not a replacement.                                                                                                                                    |

- **One live row per (worker, fact_key):** a partial unique index on `(worker_id, fact_key) WHERE superseded_at IS NULL`. Re-correcting supersedes the live row and inserts the replacement in the same transaction.
- **The envelope is what makes revert honest.** `previous` is the last non-admin effective value, captured at correction time. A later interview does not update it: the correction is the effective value until reverted. Revert writes `previous` back through the same writer the correction used (or, for a read-time-only field, simply deactivates the row and lets the worker's own store surface again), marks the row superseded with `superseded_by = NULL`, and emits the revert event.
- **Every write is one transaction:** the override row, the existing domain writer(s), the new domain event and `admin.action_performed` commit together. A failure writes nothing. Locked fields fail with 400 before any write.
- **RLS:** `ENABLE` + `FORCE ROW LEVEL SECURITY`, revoke `PUBLIC`/`anon`/`authenticated`/`service_role`, and add the table to `LOCKED_TABLES` in `tests/e2e/rls-spine.e2e.test.ts`.
- **`reason_text` visibility:** readable only by `edit_candidates` holders on one worker's history view. It never appears in a list, the read table or an analyst response.

`fact_key` is the `WorkerFactId` from `apps/api/src/profiling/facts/worker-fact.registry.ts` whenever the registry names the fact. Four field groups name stores the registry deliberately does not call a fact — `skills` is listed in `NOT_A_WORKER_FACT` as "capability, resolved per trade", and `role`, `secondary_roles` and `training` have no registry id. Those four use their store names as reserved field keys; adding them to `WORKER_FACT_IDS` is a separate registry change and is not required by this ADR. The table in §4 lists every key. The same closed set is the `fact_key` CHECK on the table and the `z.enum` in both correction event schemas.

`value_enc` is a normal `PiiCryptoService.encrypt` token and is added to the rotation targets in `packages/db/src/reencrypt-pii-backfill.ts` (keyed on the override `id`) WITH the migration, while the table is empty — the 0094/0109 lesson: a target costs nothing on an empty column and makes the first token rotatable.

### 3.1a Worker self-edit supersedes a correction

The owner ruling A1 is a precedence rule, not a UI convention. Every explicit worker edit path supersedes the live override for the same `fact_key`, in the same transaction as the worker's own write:

- the worker profile-edit endpoints (location, preferences, work history, languages, qualifications and secondary roles);
- the worker's own extracted-field corrections (`POST /profile/corrections`, backed by `ExtractedCorrectionsService.correctExtracted`);
- chat-companion edits the worker confirms.

The mechanism is one method, `AdminCorrectionService.supersedeByWorkerEdit(workerId, factKeys, { tx, source: "worker_self_edit" })`. The worker-route services call it explicitly; it is never inferred from the call stack. A missing call is a bug, and #2561 owes one test per path.

Interview extraction, trade-form inference (`answer_map` / `llm_parse` writes), résumé import and any `ai_service` actor NEVER supersede a correction. They remain projections that the correction overlay wins over.

The supersede writes the new event `worker.admin_correction_superseded` v1, payload `{ worker_id, fact_key, override_id }`, and marks the live override superseded in the same transaction. City needs no special case any more: a worker self-edit of city supersedes the override like every other field.

### 3.2 Where corrections apply — the four points

Every read of an editable fact goes through one resolver, `resolveEffectiveFacts(workerId)`, which overlays the live override on the underlying store. The four application points are:

1. **Display resolvers.** `apps/api/src/profiles/worker-field-precedence.ts` remains the single written statement of precedence; the correction overlay is applied above it. Its consumers — `apps/api/src/workers/profile-summary.mapper.ts` (`toProfileSummary`) and the payer candidate projection `toCandidateRow` in `apps/api/src/candidates/candidate-search.service.ts` — read the effective value, never the raw profile field. The #2557 projector uses the same resolver. **Salary specifically:** the DraftProfile `salary_expectation` container wins over attributes in `worker-field-precedence.ts`, so the correction overlay must sit ABOVE that container. Writing attributes alone would leave the résumé and the summary showing the extracted salary; #2561 owes a contract test for this.
2. **Résumé.** `apps/api/src/resume/resume-render-input.ts` and `apps/api/src/resume/resume-draft-overlay.ts` are pure snapshot-to-render mappers. The correction overlay is applied to their inputs, and the live/snapshot split in §3.3 decides whether the sheet is redrawn in place or a new version is created.
3. **Re-extraction after a new interview.** `apps/api/src/profiles/chat-edits-profile.ts` `withChatEdits` is the existing pattern: it corrects the two transcript-read inputs before the build's merge, so every field built from them agrees without a second precedence table. The extraction processor at `apps/api/src/profiles/profile-extraction.processor.ts` applies the live corrections in the same place, after `withChatEdits` and before the profile is projected/written. A new interview therefore cannot overwrite a correction.
4. **Matching.** `apps/api/src/match/worker-skills.service.ts` `rebuildForWorker` rebuilds the derivation and reconciles reach. Admin-authored skill rows are stamped `source='ops'` in `worker_skill` (the CHECK already allows `derived_coarse`, `interview` and `ops` in `packages/db/src/schema/match.ts`), so the coarse re-derivation preserves them. The same rebuild is run after a correction that changes a match input.

**City is the one destructive exception.** `workers.current_city` is read directly by the feed, candidate search and the résumé masthead, and extraction never writes it. A city correction therefore writes it through the existing `WorkersService.setLocation` (canonicalisation included), with the pre-correction value in the encrypted envelope's `previous` for a revert. A worker self-edit of city supersedes the override in the same transaction (§3.1a), so there is no special revert path for the worker's own edit. Everything else is either a read-time overlay or a derived projection; the worker's own row is not destroyed.

### 3.3 Résumé: redraw in place vs new version

The résumé is built from `generated_resumes.source_profile_snapshot` plus live worker tables loaded at render time (`worker_attributes`, `worker_employment`, `worker_education` / `worker_certificates` / `worker_training`, `worker_language`, `workers.current_city` / `current_state`, `workers.resume_night_shift_ready`, the worker row for name/phone/photo).

- **Live-read fields** — location, work history, education / certificates / training, languages, salary, availability, shift and the other preferences — are redrawn in place with `ResumeRerenderService.enqueueLatest`. That is a forced render of the same résumé object, no new version and no `resume.generated` event.
- **Snapshot fields** — skills, trade/role, total experience — create a new résumé version with `generation_trigger = 'admin_edit'`. `admin_edit` is added to `RESUME_GENERATION_TRIGGERS` in `packages/types/src/index.ts` and to the `generated_resumes_generation_trigger_chk` CHECK in `packages/db/src/schema/profile.ts` (an additive CHECK widening; every old value and NULL stays valid). The new row's `sourceProfileSnapshot` carries the corrected values, and the worker's résumé history shows the new version.
- If a worker has no résumé yet, the first generation picks the correction up; there is nothing to redraw.

### 3.4 Locked fields

`workers.full_name`, `workers.phone_e164`, `workers.whatsapp_enc` and `workers.resume_show_photo` are not editable through this layer. A correction request for any of them is rejected with 400 before an override row, writer call or event. The owner decision lists these four (the WhatsApp number was added by ruling A3); photo visibility stays a worker-only setting.

### 3.5 The read table and how it stays current

New table `admin_candidate_index`, one row per worker, `worker_id` primary key → `workers(id) ON DELETE CASCADE`. It is a **derived read model**, not a source of truth: every value is computed by `CandidateIndexProjector.projectWorker(workerId)` with the same TypeScript resolvers the employer-facing reads use, including the correction overlay. Its columns and indexes are in §7.

- **Projector.** A queued job, not a database trigger. Values come from TypeScript precedence code (`worker-field-precedence.ts`, `profile-summary.mapper.ts`, `toCandidateRow`, the correction resolver); a trigger would re-implement that in SQL and drift.
- **Cursor.** `admin_candidate_index_cursor` is a single-row watermark over `events.created_at` (`id = 'singleton'`), copied from the `learn_labels_cursor` precedent in `packages/db/src/schema/learn.ts` (migration 0091). Each tick re-reads a small overlap window before the watermark; projection is an idempotent upsert, so overlap is safe. The event names are an explicit closed `as const` list beside the projector (`ADMIN_CANDIDATE_EVENT_NAMES`, the `LEARN_EVENT_NAMES` shape in `apps/api/src/learn/learn-labels.repository.ts`) filtered with `inArray(events.eventName, [...])` on the indexed `event_name` column. **No wildcard prefixes.** The list includes at least:
  - worker identity and profile facts: `worker.created`, `worker.name_recorded`, `worker.location_recorded`, `worker.languages_recorded`, `worker.employment_recorded`, `worker.occupations_recorded`, `worker.preferences_recorded`, `worker.qualifications_recorded`, `worker.whatsapp_recorded`, `worker.photo_uploaded`, `worker.photo_removed`, `worker.resume_prefs_updated`, `worker.active`, `worker.match_skills_rebuilt`, `worker.match_skill_wants_set`;
  - profile and résumé: `profile.extraction_completed`, `profile.confirmed`, `profile.answer_corrected`, `profile.form_completed`, `profile.resume_imported`, `profile.tier_completed`, `resume.generated`, `resume.regenerated`, `resume.edited`, `resume.edited_v2`;
  - consent, because `employer_sharing` changes the pool: `consent.accepted`, `consent.revoked`, `consent.purposes_granted`, `consent.purposes_withdrawn`;
  - admin: `admin.action_performed` (the worker-target flag/unflag actions and any later worker-target action; a payer/admin target resolves no worker and is skipped), `admin.candidate_field_corrected`, `admin.candidate_field_reverted`;
  - account: `worker.logged_out_all`, `worker.pin_reset`, `worker.suspended`, `worker.reinstated`, `worker.account_deleted`, `worker.deletion_scheduled`, `worker.deletion_cancelled`;
  - worker self-edit: `worker.admin_correction_superseded`.

  A worker is resolved from `subject_type = 'worker'` / `subject_id`, else from `payload->>'worker_id'`; an event naming no worker is skipped. `last_active_at`, `is_test_account` and `app_version` are not evented and refresh in the nightly rebuild. The cursor holds no PII.

- **Nightly full rebuild** over every worker, so a missed event or a resolver change converges without a manual repair.
- **Backfill CLI** (dry-run by default, `--apply` to write, idempotent, `--expect-host` production guard) for the initial population and for a repair after a resolver change.
- **Drift check** comparing the projected row with a fresh `projectWorker` output; it reports mismatches and is run against the synthetic seed in #2557.

### 3.6 Search: phone, name, and everything else

- **Phone — exact only.** Normalise the typed number to E.164, defaulting a bare 10-digit Indian number to `+91`, validate with `e164PhoneSchema`, then use the copied `admin_candidate_index.phone_hash` and match it exactly. The search never recomputes a phone hash; `PII_HASH_PEPPER` and the sign-up `hashPhone` are unchanged. No prefix, no partial, no decryption.
- **Name — whole word exact only, under a dedicated keyring.** Fold each word with `foldName` from `apps/api/src/common/name-fold.ts`, split with `NAME_SEPARATORS` / `nameWordParts`, and HMAC-SHA256 each word under a key from a **dedicated** keyring: `ADMIN_NAME_TOKEN_KEYS` (key id → 32-byte key) with `ADMIN_NAME_TOKEN_ACTIVE_KID`. It is NEVER `PII_HASH_PEPPER` and never falls back to another secret. Each row stores its key id in `name_token_key_id` and the hashes in `name_token_hashes text[]` with a GIN index; a row is projected atomically under one key, so its tokens never mix key ids. The tokens are de-duplicated and stored in hash order, not name order. Words under two characters are neither indexed nor searchable. Only the projector and the Candidates search service may compute a token; a static test enforces that. If the keyring or active kid is unset, name search is unavailable (fail closed).
- **Key rotation.** Add a new key, make it active, re-project; while two keys exist, a search hashes each word under both and accepts either. Retire the old key only when the drift check finds no row still on it. The projector is the named decrypt site (below), so rotation does not create a second decrypt path.
- **Everything else — partial.** `search_doc` is a folded label document built only from canonical labels (trade, role, skills, city, machines, languages) and is queried with `ILIKE` / the `pg_trgm` GIN index. It never contains a name, phone, employer name or free text.
- **Search gates.** A name or phone search requires `read_identity`; without it the endpoint returns 403 and never serves faceless rows. A search is refused while the account's Candidates name budget is exhausted. The search charges `match_count` (the matched rows) against the Candidates name budget; the page's names are covered by that charge and are not charged a second time. The per-admin search cap is `ADMIN_CANDIDATES_SEARCH_MAX_PER_HOUR=300` and `ADMIN_CANDIDATES_SEARCH_MAX_PER_DAY=2000`, fail-closed, with its own PII-free breach event `admin.candidates_search_cap_exceeded` v1 (`admin_id`, `window`).
- **Audited lookup.** `admin.identity_searched` v1 (`admin_id`, `search_kind`, `match_count`) is emitted **after the match and before any result leaves the server**. A failed emit returns nothing. It never carries the term, a hash of it, or matched ids, and the search term travels ONLY in a POST body — never in a URL, route, error or validation message. A logging test proves the term cannot reach a log line. The endpoint is `POST /admin/candidates/search` with filters and `q` in the body, like the payer search.
- **Pages** are numbered (`page`, `page_size` 25/50/100) with an exact `count(*)` on the same `WHERE` and facet counts via `count(*) FILTER`. Sort columns come from an allow-list with `worker_id` as the stable tiebreaker.

### 3.7 Name-view budget

The existing identity budget is `ADMIN_IDENTITY_MAX_PER_HOUR=300` / `ADMIN_IDENTITY_MAX_PER_DAY=1000`, with a hard 50-name response bound (`ADMIN_IDENTITY_MAX_SUBJECTS`). Its only readers are `AdminIdentityCapService` and `AdminIdentityService`; nothing else consumes those keys.

The Candidates surface gets its **own** budget rather than raising the shared one:

- `ADMIN_CANDIDATES_IDENTITY_MAX_PER_HOUR`, default `2000`.
- `ADMIN_CANDIDATES_IDENTITY_MAX_PER_DAY`, default `10000`.
- A separate Redis namespace (the `AdminEgressCapService` subclass pattern) and a candidates-specific response bound of 100 names, matching the largest page size.
- `AdminIdentityService` picks the response bound and the cap from a **per-surface constant**: `candidates` → 100 names + the Candidates budget; every other surface → 50 names + the existing entity budget. No caller passes a bound or a budget, and a drift test covers both rows.
- The raised budget applies to every super_admin, ops_admin and support session with `read_identity`, whether or not two-step sign-in is on (owner ruling A2). `analyst` is denied because `read_identity` is denied.
- Every named response still emits `admin.identity_viewed` and consumes the applicable budget by names actually disclosed; a breach emits `admin.identity_cap_exceeded` with the window only. Reaching 50% of an admin's daily Candidates budget emits the PII-free `admin.candidates_name_budget_alert` v1 (`admin_id`, `window`, `threshold_percent`). Named rows on this surface have no export, print, bulk copy or CSV. The existing 300/1,000/50 entity-list budget is unchanged.
- Name and phone searches have their own `ADMIN_CANDIDATES_SEARCH_MAX_PER_HOUR=300` / `ADMIN_CANDIDATES_SEARCH_MAX_PER_DAY=2000` cap (§3.6), separate from the name-view budget.

### 3.8 Capabilities

Three capabilities are added to `ADMIN_CAPABILITIES` and `ADMIN_CAPABILITY_MATRIX` in `apps/api/src/admin/admin-capabilities.ts`:

| Capability                            | super_admin | ops_admin | support | analyst |
| ------------------------------------- | :---------: | :-------: | :-----: | :-----: |
| `read_candidates`                     |      ✓      |     ✓     |    ✓    |    ✓    |
| `edit_candidates`                     |      ✓      |     ✓     |    ✓    |    —    |
| `manage_worker_account`               |      ✓      |     ✓     |    ✓    |    —    |
| `read_identity` (existing, for names) |      ✓      |     ✓     |    ✓    |    —    |

Every route carries exactly one `@RequireAdminRole` capability plus `AdminAuthGuard` + `AdminRolesGuard`, as the static guard requires. `read_candidates` is the read floor; names are additive only when `read_identity` also passes. `edit_candidates` covers the correction endpoints; `manage_worker_account` covers the #2562 sign-out / PIN-reset / suspend actions. Locked fields are rejected inside the service as well as by the DTO.

**The `manage_worker_account` row does not by itself approve #2562's actions.** In particular, #2562 must show that an admin PIN reset cannot let anyone skip proving they hold the phone: the worker must re-verify by phone code before setting a new PIN. Until that test exists, the PIN-reset action is not approved.

**Owner ruling (a) — DPDP exits survive suspension (5 Nov 2026).** A suspended worker must still be able to request/confirm/cancel account deletion and withdraw consent. Phone-code verification therefore still answers `403 WORKER_ACCOUNT_SUSPENDED`, but the body also carries a short-lived **restricted token** (15 minutes; no refresh, no device trust, no push registration). The scope is enforced from the server-side session record, not from the token claim (the JWT carries a `scope` claim only as a convenience for the guard). The worker auth guard accepts that token ONLY on the five DPDP handlers (account-delete request/confirm/cancel and the two consent withdrawals); every other route, PIN set/verify and refresh refuse it. Old app builds ignore the additive field and keep their current behaviour. The worker-app screen is a separate frontend issue.

**Owner ruling (c) — unsuspend always restores `active` (5 Nov 2026).** There is no previous-status column and no migration adds one. Unsuspend writes `active`; a later re-suspend is a fresh admin action with its own reason, audit row and sweep.

### 3.9 Events

New event names, registered in `packages/event-schema/src/registry.ts` with schemas in `packages/event-schema/src/payloads.ts`. All are PII-free: opaque ids and closed field keys only, never a corrected value, a reason text, a name, a phone or a search term.

| Event                                  | Version | Payload keys                                                 | When                                                                                    |
| -------------------------------------- | ------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `admin.candidate_field_corrected`      | 1       | `admin_id`, `worker_id`, `fact_key`, `override_id`           | In the same transaction as a create/change, one per field.                              |
| `admin.candidate_field_reverted`       | 1       | `admin_id`, `worker_id`, `fact_key`, `override_id`           | In the same transaction as a revert, one per field.                                     |
| `admin.identity_searched`              | 1       | `admin_id`, `search_kind` (`name` \| `phone`), `match_count` | After the match and before any result leaves the server; a failed emit returns nothing. |
| `admin.candidates_search_cap_exceeded` | 1       | `admin_id`, `window` (`hour` \| `day`)                       | When the per-admin search cap is exceeded; no term or result is carried.                |
| `admin.candidates_name_budget_alert`   | 1       | `admin_id`, `window` (`day`), `threshold_percent`            | When the daily Candidates name budget reaches 50%; PII-free.                            |
| `worker.admin_correction_superseded`   | 1       | `worker_id`, `fact_key`, `override_id`                       | In the same transaction as an explicit worker self-edit (§3.1a).                        |
| `admin.candidate_viewed`               | 1       | `admin_id`, `worker_id`                                      | #2560's full-detail read; registered there.                                             |

`admin.action_performed` (existing v1, schema unchanged) gains action codes `candidate_field_corrected` and `candidate_field_reverted` in `ADMIN_ACTION_CODES` (`apps/api/src/admin/admin-actions.service.ts`), emitted alongside the domain event in the same transaction. `fact_key` is a closed `z.enum` in both correction schemas, matching the table CHECK. The two correction events and `worker.admin_correction_superseded` use `subject_type = 'worker'` with `subject_id = worker_id`; `admin.identity_searched` uses the admin session (`subject_type = 'admin_session'`, `subject_id = admin_id`) like `admin.identity_viewed`. #2562 will add its own account-action codes; #2560 registers `admin.candidate_viewed` and its audited view. `admin.identity_viewed` and `admin.identity_cap_exceeded` keep their existing schemas. The candidates surface adds `candidates` to `ADMIN_IDENTITY_SURFACES` in `packages/event-schema/src/payloads.ts` — an additive widening of the existing v1, `.strict()` unchanged, with the `AdminIdentityService.fetch` switch gaining the case and a schema test. The precedent is the additive `JobStatusEnum` / `BoostTierEnum` widening recorded in the [architecture log](../registers/architecture-log.md) (not a version bump).

### 3.10 Worker notification

After a correction commits, the API sends the worker a push through the existing worker push service (ADR-0034). The message carries no corrected value, no reason and no admin identity. One save sends one push, even when it changes several fields. The send is best-effort and after commit: a provider failure is logged without a value and without the push token, and never rolls the correction back. No worker-app change is required; the copy is the #2561 copy.

## 4. Application points by field group

The four points are display (D), résumé (R), re-extraction (X) and matching (M). “Live” means the résumé reads the live store and is redrawn in place; “snapshot” means a new résumé version with `generation_trigger='admin_edit'`.

| Field group                         | `fact_key`(s)                                                                                                                              | D — display / search                                                                                                                                                                                                                                         | R — résumé                                                                                                      | X — after a new interview                                                                 | M — matching                                                                                                 |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Location                            | `current_city`, `preferred_locations`                                                                                                      | `toProfileSummary` city; `toCandidateRow` city; read table city/state. `current_city` writes `workers.current_city` via `WorkersService.setLocation`; `preferred_locations` via `WorkerPreferencesService.setForWorker`.                                     | Live: `buildLocationLine` and the preference facts; redraw in place.                                            | Overlay re-applied after the build. A worker self-edit supersedes the override (§3.1a).   | City is a search/filter input; re-project the read table. No `worker_skill` row.                             |
| Trade + role                        | `trade`, `role`\*, `secondary_roles`\*                                                                                                     | `toProfileSummary.trade` (ids + `readDisplayName`); payer `toCandidateRow.role` / `otherRoles`; read table trade/role labels.                                                                                                                                | Snapshot: role/trade ids and labels; new `admin_edit` version.                                                  | Overlay re-applied after the build.                                                       | `rebuildForWorker` role bridge + `worker_occupation` secondary roles; admin rows `source='ops'`; re-project. |
| Skills                              | `skills`\*                                                                                                                                 | `toProfileSummary.skills`; payer `toCandidateRow` reads `worker_skill`; `worker_profile_skill` is the authored table. Admin rows are `worker_profile_skill.source='ops'`, leaving the worker's rows intact.                                                  | Snapshot: `worker_profiles.skills` is the display source in the draft; new `admin_edit` version.                | Overlay re-applied after the build; `withChatEdits`'s `stamp.skills` is the precedent.    | `worker_skill` rows stamped `source='ops'`; `rebuildForWorker` reconciles reach; re-project.                 |
| Total experience                    | `experience`                                                                                                                               | `toProfileSummary.experience_years`; read table total years.                                                                                                                                                                                                 | Snapshot: `experience.total_years`; new `admin_edit` version.                                                   | Overlay re-applied after the build.                                                       | `rebuildForWorker` (tenure input); `worker_industry_tenure`; re-project.                                     |
| Work history                        | `work_history`                                                                                                                             | `WorkerEmploymentService.replaceForWorker`; live rows are what #2560 reads.                                                                                                                                                                                  | Live: `resume-employment-rows` reads the rows at render; redraw in place.                                       | Overlay re-applied after the build; employment rows are not overwritten by the interview. | `rebuildForWorker` after the replace; re-project.                                                            |
| Education / certificates / training | `education`, `certifications`, `training`\*                                                                                                | Live rows via `WorkerQualificationsService.replaceForWorker`; #2560 reads the rows and the `education_*` fallback.                                                                                                                                           | Live: `qualification` is loaded at render; redraw in place.                                                     | Overlay re-applied after the build.                                                       | No direct skill input; re-project the read table.                                                            |
| Languages                           | `languages`                                                                                                                                | Live rows via `WorkerLanguagesService.replaceForWorker`; #2560 reads them.                                                                                                                                                                                   | Live: preference facts / attributes; redraw in place.                                                           | Overlay re-applied after the build.                                                       | No direct match input; re-project.                                                                           |
| Salary                              | `salary_expected`, `salary_period`                                                                                                         | `WorkerPreferencesService.setForWorker` (attributes); `toProfileSummary` reads the salary container; the payer card masks pay. The correction overlay must sit ABOVE the DraftProfile `salary_expectation` container (see §3.2); #2561 owes a contract test. | Live: `readPreferenceFacts` + `resolveSalaryBand`; redraw in place.                                             | Overlay re-applied after the build.                                                       | Filter input only; re-project.                                                                               |
| Availability / shift / preferences  | `availability`, `shift`, `relocation`, `accommodation`, `job_type`, `work_types`, `commute_max_km`, `willing_to_travel`, `documents_ready` | `WorkerPreferencesService.setForWorker`; `toProfileSummary` availability; read table availability/shift.                                                                                                                                                     | Live: `readPreferenceFacts`, `buildAvailabilityRows`, the worker's `resume_night_shift_ready`; redraw in place. | Overlay re-applied after the build.                                                       | `rebuildForWorker` reads the attributes; re-project.                                                         |

`*` Not a `WorkerFactId` today; a reserved correction field key. The registry deliberately excludes `skills` as a fact (`NOT_A_WORKER_FACT`), and has no `role`, `secondary_roles` or `training` id. Extending `WORKER_FACT_IDS` is a separate registry change.

## 5. Events

See §3.9. In summary:

- `admin.candidate_field_corrected` v1 — `admin_id`, `worker_id`, `fact_key`, `override_id`.
- `admin.candidate_field_reverted` v1 — `admin_id`, `worker_id`, `fact_key`, `override_id`.
- `admin.identity_searched` v1 — `admin_id`, `search_kind`, `match_count`; emitted after the match and before any result leaves the server; the term is never carried.
- `admin.candidates_search_cap_exceeded` v1 — `admin_id`, `window`; the per-admin search-cap breach.
- `admin.candidates_name_budget_alert` v1 — `admin_id`, `window`, `threshold_percent`; the 50% daily budget alert.
- `worker.admin_correction_superseded` v1 — `worker_id`, `fact_key`, `override_id`; emitted on an explicit worker self-edit.
- `admin.candidate_viewed` v1 — `admin_id`, `worker_id`; owned by #2560.
- `admin.action_performed` v1 (unchanged schema) — new `action_code` values `candidate_field_corrected`, `candidate_field_reverted`.

No event carries a corrected value, a previous value, a reason text, a name, a phone, a search term, a hash of the term or matched ids. The correction events carry field keys only.

## 6. Capabilities and role matrix

See §3.8. The three new rows are `read_candidates` (all four roles), `edit_candidates` (super_admin, ops_admin, support) and `manage_worker_account` (super_admin, ops_admin, support). Names remain gated by the existing `read_identity`; analysts hold `read_candidates` and never receive names.

## 7. Read-table shape for #2557

`admin_candidate_index`, one row per worker, `worker_id` primary key → `workers(id) ON DELETE CASCADE`:

| Column                     | Type                                 | Source / meaning                                                                                                                                           |
| -------------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `worker_id`                | `uuid` PK                            | `workers.id`.                                                                                                                                              |
| `status`                   | `text`                               | `workers.status`.                                                                                                                                          |
| `flagged`                  | `boolean NOT NULL DEFAULT false`     | An open `worker_flags` row.                                                                                                                                |
| `is_test_account`          | `boolean NOT NULL DEFAULT false`     | `workers.is_test_account`.                                                                                                                                 |
| `deletion_scheduled_at`    | `timestamptz NULL`                   | `workers.deletion_scheduled_at`.                                                                                                                           |
| `employer_sharing_consent` | `boolean NOT NULL DEFAULT false`     | Latest `worker_consents.purposes` contains `employer_sharing` (the `EMPLOYER_CONTACT_PURPOSES` pair).                                                      |
| `current_city`             | `text NULL`                          | Effective city after the correction overlay.                                                                                                               |
| `current_state`            | `text NULL`                          | `workers.current_state`.                                                                                                                                   |
| `canonical_trade_id`       | `text NULL`                          | Current profile's `canonical_trade_id`.                                                                                                                    |
| `canonical_role_id`        | `text NULL`                          | Current profile's `canonical_role_id`.                                                                                                                     |
| `job_domain_id`            | `uuid NULL`                          | Current profile's `job_domain_id`.                                                                                                                         |
| `trade_label`              | `text NULL`                          | Resolved trade label.                                                                                                                                      |
| `role_label`               | `text NULL`                          | Resolved role label.                                                                                                                                       |
| `domain_label`             | `text NULL`                          | Resolved domain label.                                                                                                                                     |
| `total_experience_years`   | `numeric NULL`                       | Effective `experience.total_years`.                                                                                                                        |
| `role_experience_months`   | `integer NULL`                       | Bucketed months on the current role's leading skill (`worker_skill.months_bucketed` / `worker_industry_tenure`).                                           |
| `salary_min_inr`           | `numeric NULL`                       | Effective `salary_expected` lower end.                                                                                                                     |
| `salary_max_inr`           | `numeric NULL`                       | Effective upper end.                                                                                                                                       |
| `salary_period`            | `text NULL`                          | `salary_period` (`month` / `day` / `year`).                                                                                                                |
| `availability_status`      | `text NULL`                          | Effective availability status.                                                                                                                             |
| `shift_preference`         | `text NULL`                          | Effective shift.                                                                                                                                           |
| `form_level`               | `text NULL`                          | `worker_profiling_tier.tier` (`easy` / `medium` / `hard`).                                                                                                 |
| `skills`                   | `text[] NOT NULL DEFAULT '{}'`       | Effective skill labels (ids resolved to labels).                                                                                                           |
| `languages`                | `text[] NOT NULL DEFAULT '{}'`       | `worker_language` labels.                                                                                                                                  |
| `education_level`          | `text NULL`                          | Effective education level.                                                                                                                                 |
| `resume_count`             | `integer NOT NULL DEFAULT 0`         | `count(*)` over `generated_resumes` for the worker.                                                                                                        |
| `latest_resume_status`     | `text NULL`                          | Newest résumé's `render_status`.                                                                                                                           |
| `latest_resume_version`    | `integer NULL`                       | Newest résumé's `version`.                                                                                                                                 |
| `profile_status`           | `text NULL`                          | Current profile's status (`CURRENT_PROFILE_ORDER`).                                                                                                        |
| `profile_source`           | `text NULL`                          | Current profile's `source`.                                                                                                                                |
| `app_version`              | `text NULL`                          | Latest `worker_devices.app_version`.                                                                                                                       |
| `last_active_at`           | `timestamptz NULL`                   | Latest `worker_devices.last_seen_at` (or the equivalent session activity source).                                                                          |
| `created_at`               | `timestamptz NOT NULL`               | `workers.created_at`.                                                                                                                                      |
| `updated_at`               | `timestamptz NOT NULL`               | `workers.updated_at`.                                                                                                                                      |
| `ai_cost_inr`              | `numeric(16,6) NOT NULL DEFAULT 0`   | `worker_ai_cost_totals.total_cost_inr`, zero when absent.                                                                                                  |
| `referral_source`          | `text NULL`                          | First-touch referral label from `referral_clicks` / `invites` / `agency_invites` (kind, channel or campaign — a stable code, never a referrer's identity). |
| `search_doc`               | `text NOT NULL DEFAULT ''`           | Folded canonical labels only: trade, role, skills, city, machines, languages. Never a name, phone, employer name or free text.                             |
| `name_token_hashes`        | `text[] NOT NULL DEFAULT '{}'`       | De-duplicated whole-word name tokens, stored in hash order (not name order), all under `name_token_key_id`.                                                |
| `name_token_key_id`        | `text NULL`                          | The key id the row's `name_token_hashes` were computed under; NULL when no name is indexed.                                                                |
| `phone_hash`               | `text NOT NULL`                      | Copy of `workers.phone_hash`; exact phone lookup.                                                                                                          |
| `projected_at`             | `timestamptz NOT NULL DEFAULT now()` | When the projector last wrote the row.                                                                                                                     |

Indexes:

- GIN `gin_trgm_ops` on `search_doc` (the `pg_trgm` extension is already installed by migration `0067_steady_jimmy_woo.sql` and used by `0076_canonical_domain_skill_taxonomy.sql`).
- GIN on `skills`, `languages` and `name_token_hashes`.
- **UNIQUE** B-tree on `phone_hash`.
- B-tree on `status`, `canonical_trade_id`, `current_city`, `last_active_at`, `created_at` and `name_token_key_id` (the rotation drift check).

`name_token_hashes`, `phone_hash` and `search_doc` are never selected into any API response — a static DTO test enforces it. The table is excluded from analytics exports, replicas and BI. The projector job payload carries `worker_id` only. `CandidateIndexProjector.projectWorker` is a named decrypt site: it decrypts the worker's name in memory only, to compute tokens, and never returns it. Projector, backfill and drift-check output carry ids, column names and counts only. The FK cascade — not the projector — is what prevents an erased worker's row from coming back.

The table is RLS-locked like the other worker tables and added to `LOCKED_TABLES`. A row disappears with its worker through the cascade.

## 8. Consequences and risks

- **One resolver or the correction is invisible.** Every display, résumé, re-extraction, matching and read-table path must consume the same effective-fact resolver. A new reader that reaches the raw profile field silently ignores a correction. The mitigation is a single exported resolver plus contract tests against the payer candidate projection, the résumé render input, the match rebuild and the read table.
- **A missed supersede call lets a correction outlive the worker's own edit.** The worker-route services must call `supersedeByWorkerEdit` explicitly; it is never inferred. #2561 owes one test per worker edit path, plus a negative test that interview/form/résumé-import/ai_service paths do not supersede.
- **Re-extraction bypass.** If a new interview writes a profile without the overlay, the correction is gone. The extraction processor must apply it in the same place as `withChatEdits`; the acceptance test is a later interview not overwriting a corrected fact, and a revert restoring the worker's value.
- **Résumé versioning is additive but visible.** Snapshot-field corrections add a new history entry with `admin_edit`; that is intended and must be labelled in the worker's history. Old rows and old trigger values remain valid.
- **Read-table staleness.** The projector is eventually consistent (target: within one minute). The cursor's overlap plus the nightly rebuild bound the damage; the drift check makes a resolver change visible before it is trusted.
- **Token rotation is a two-key window.** While two keys exist, search hashes under both; a row the projector missed keeps the old key and blocks retirement. The drift check is the gate: the old key is retired only when no row still carries it.
- **`value_enc` is encrypted at rest.** It is a rotation target from the migration that creates the table; a skipped target would make a key retirement impossible to complete.
- **Write amplification and transaction size.** A correction can touch the override row, one or more existing domain writers, matching and the read-table enqueue. They must stay inside one transaction (or use an outbox-style post-commit projection with a durable retry); a partial write is not acceptable.
- **Push is best-effort.** The worker notification runs after commit; a push provider failure is logged without a value and without the token, and never rolls back the correction.
- **The security review passed with the amendments in §3.** The accepted residuals — token frequency, the speed-not-total budget limit, and the budget not being tied to two-step sign-in — are in the risks register (R75–R77). If a later change weakens a control, it needs a new review, not an edit to this ADR.
- **Apply-before-deploy.** The implementation PRs that read `worker_admin_override` or `admin_candidate_index` must say so in their PR bodies. The owner applies the migrations; the implementing engineer never does.

## 9. Security review (4 Nov 2026): pass with the amendments in §3

1. **Name-token scheme and frequency leakage — accepted residual R75.** Whole-word keyed hashes are stable across workers, so a database reader can see word equality and approximate name frequency. Prefix or fuzzy hashes would be worse. The design uses a dedicated `ADMIN_NAME_TOKEN_KEYS` keyring (never `PII_HASH_PEPPER`), whole-word exact only, no name in `search_doc` or any trigram index, no term in any log/event/error, and only the projector and the Candidates search service may compute a token (static test). Key rotation is the two-key re-projection described in §3.6.
2. **Raised name-view budget — accepted residual R76/R77.** 2,000 names/hour and 10,000/day per admin is a 6.7×/10× increase over the entity-list budget, and it applies to every super_admin, ops_admin and support session whether or not two-step sign-in is on (owner ruling A2, accepted 2026-11-04). Controls: three roles only, 100-name page, audited `admin.identity_viewed`, breach event on overage, 50% daily alert, and no export/print/bulk copy/CSV. The budget limits speed, not total exposure across several admins.
3. **Audited identity search.** A name or phone search requires `read_identity` (403 without it), is refused while the name budget is exhausted, and charges `match_count` against the Candidates name budget. `admin.identity_searched` (`admin_id`, `search_kind`, `match_count`) is emitted after the match and before any result leaves the server; a failed emit returns nothing. The term travels only in a POST body and never appears in a URL, route, error, validation message, log, trace or event; a logging test proves it. The separate search cap is 300/hour and 2,000/day, fail-closed, with its own breach event.
4. **Correction reasons.** `reason_text` is 15–500 characters, rejected with 400 when `containsHardIdentifier` finds a hard identifier, and readable only by `edit_candidates` holders on one worker's history view. It is never in lists, the read table or analyst responses, and never evented or logged.
5. **Read-table contents.** `phone_hash` and `name_token_hashes` are copies of identity material. The table is RLS-locked, excluded from analytics exports, replicas and BI, and `phone_hash`, `name_token_hashes` and `search_doc` are never selected into an API response (static DTO test). The projector is the named decrypt site; job payloads carry `worker_id` only and all projector/backfill/drift-check output is ids, column names and counts only.

## 10. Rejected alternatives

- **SQL triggers for the read table.** Rejected: the values come from TypeScript precedence and correction code; a trigger would re-implement that in SQL and drift from the readers employers use.
- **Prefix or fuzzy name search.** Rejected: prefix hashes leak name frequency and allow enumeration; whole-word exact keyed hashes are the only form that matches the owner's decision.
- **Reusing `PII_HASH_PEPPER` for name tokens.** Rejected: a phone hash and a name token must not share a key domain; the dedicated `ADMIN_NAME_TOKEN_KEYS` keyring also makes rotation and retirement possible without touching phone hashes.
- **A GET search endpoint.** Rejected: the term would travel in a URL; the search is `POST /admin/candidates/search` with the term in the body.
- **Direct edits to `worker_profiles` without a correction layer.** Rejected: the next interview, form, chat edit or résumé import overwrites the edit, and there is no who/when/why or revert path.
