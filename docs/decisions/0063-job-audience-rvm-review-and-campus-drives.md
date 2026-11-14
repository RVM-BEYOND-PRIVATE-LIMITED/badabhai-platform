# ADR-0063: Job audience, the RVM review and campus-drive requests

- **Status:** Proposed — awaiting owner sign-off (Prakash Kantumutchu). Records the design built in #2746 PRs 1–6 and the owner rulings of 13 and 14 November 2026.
- **Date:** 2026-11-14
- **Owner:** Divyanshu (Backend Platform); reviewed by Prakash as the other backend developer.
- **Needs:** migration `0162_job_audience_campus_drives` (#2746 PR 1), **APPLY-BEFORE-MERGE** (§3.8). No other migration. PRs 2–6 add no schema.
- **Amends / extends:**
  - [ADR-0053](0053-payer-org-tenancy-anchor-key.md) — the rollout switches and the pilot list are keyed by the payer TENANT key.
  - [ADR-0047](0047-lift-pii-restriction.md) — a new place B2B personal data is written (the campus-drive contact) and a new party it is disclosed to (RVM's placement team, through Campus).
  - #2752 (the Campus link) — every Campus route here sits behind its `CampusServiceGuard`; none is mounted on `InternalServiceGuard`.

## 1. Context

A company posting on BadaBhai could reach only BadaBhai workers. RVM's students (BadaBhai Campus) need the same jobs, filtered by branch and course and reviewed by RVM's placement team first; and a company that wants RVM students in numbers needs a campus drive, which the placement team schedules in Campus (brief 4B.1, 4B.2; issue #2746).

The worker paths read `job_postings` in five places that each test `hidden_at`, and reach is materialised into `job_reach`. Admin verification of a posting does not gate going live. Campus calls BadaBhai over its own service credential (#2752) and BadaBhai pushes nothing to Campus. Production deploys on every push to `main`, and several repositories read `job_postings` and `payers` with bare selects that name every model column.

## 2. Owner decisions

- **13 Nov 2026:** one review store (`job_posting_institute_reviews`), no `rvm_review_*` columns on `job_postings`. A decision counts only for the content it saw: title, description, requirements, benefits, pay, location, shift, experience, vacancy, audience, targeting.
- **14 Nov 2026:** every Campus review decision carries the `content_hash` the reviewer saw (required); a posting that changed since answers `409 POSTING_CHANGED`. Every Campus decision carries `decided_at` (required, Campus's clock); the newest decision wins: an older one, or one at the same instant that differs, is `409 DECISION_SUPERSEDED` and stores nothing; the same decision again is a replay.
- **Issue defaults (built with them, confirmable):** branch and course targeting only, no batch (plan 13 #19); agency accounts may not set an RVM audience or ask for a drive; a rejected job is shown to the company, which may change the audience; an edit to an approved job's audience or targeting returns the RVM part to `pending`; only a verified employer may ask for a drive (§3.7, partly built).

## 3. Decision

### 3.1 The audience, and one visibility fragment

`job_postings.audience` is `badabhai_workers` (default; every pre-0162 posting, every agency twin by `job_postings_twin_audience_chk`, every AI-chat publish), `rvm_students` or `both`. `rvm_branch_ids` / `rvm_course_ids` are jsonb lists, `[]` = all, allowed only on an audience with an RVM part (`job_postings_rvm_targeting_chk`).

"A BadaBhai worker may see this posting" has ONE SQL spelling, `reachesBadaBhaiWorkers()` (`packages/db/src/job-visibility.ts`): positive membership `audience IN ('badabhai_workers', 'both')`, so a future audience is invisible until listed (fails closed). Every worker read that tests `hidden_at` (feed, search, detail, share links, apply) puts it beside that test, and reach materialisation writes no `job_reach` row where it is false. A static test forbids an audience literal anywhere else. The fragment is a STORED restriction: no switch turns it off.

Only the company's own routes (`POST`/`PATCH /payer/job-postings`, employer-only) may set the audience. The admin edit, the ops route and the AI chat publish strip the fields.

### 3.2 The reach lock

An audience change on a posting clears or rebuilds its reach after the edit commits. The company's edit locks the posting row `FOR NO KEY UPDATE`; the reach core (`materializeJobReachWithin`) reads the posting row `FOR SHARE` first and evaluates the audience inside its own statement. So a materialisation that started under the old audience waits for the edit and then runs against the committed audience; it can never commit rows read under an audience the edit has since cleared. A move to `rvm_students` purges reach whatever the status; a live posting moving back is rebuilt. A failed clear is logged with its repair command; no worker read serves the stale rows, because every read applies §3.1.

### 3.3 The review table, the content hash and the live-hash read rule

`job_posting_institute_reviews` holds one row per (posting, institute): `pending` when a posting gains an RVM part (same transaction), never deleted when the RVM part is withdrawn (Campus's feed is driven from it). A decision stores `state`, `reviewer_ref`, `reviewed_at`, an optional narrowing and `content_hash`.

`postingReviewContentHash()` (`packages/db/src/job-review.ts`) is the sha256 of a canonical `jsonb_build_object` of every student-visible field (§2, plus the company label), computed by Postgres. **The live-hash rule:** a posting is approved for RVM students only while its row is `approved` AND the stored hash equals the posting's hash NOW (`approvedForRvmStudents()`, `rvmReviewStateNow()`). A company edit also resets a decided row to `pending`, but that is housekeeping: a writer that forgets the reset cannot leak an unreviewed edit, because the read compares the hash. Lock order everywhere: the posting row before the review row.

### 3.4 Campus decisions carry `content_hash` and `decided_at`

`PUT job-postings/:id/review` (#2746 PR 5) requires the `content_hash` from the feed read the reviewer decided on; under the posting's lock a mismatch is `409 POSTING_CHANGED` and nothing is stored. Every Campus decision — the review and the drive decision (§3.6) — requires `decided_at`: at most five minutes ahead of BadaBhai's clock (else 400), compared by Postgres to the held decision's time, newest wins (§2). PR 5 applies the same rule to the targeting-options list through its `as_of`. Each decision that changes a row writes its event and an `audit_logs` row (actor = the staff reference, `actor_type = campus_staff`) in the same transaction.

### 3.5 The pilot switches: capabilities only

Each feature has an `off` | `pilot` | `on` switch (`JOB_AUDIENCE_ROLLOUT`, `CAMPUS_DRIVE_REQUESTS_ROLLOUT`), read only by `FeatureRolloutService`, and a pilot list `feature_pilot_payers` keyed by the payer TENANT key (rows carry `added_by` and `reason`; no route writes them). `isEnabledFor(feature, tenantKey)` is the company question. `isLiveForServiceCaller(feature)` is true in `pilot` for everybody, so it is used only on an allow-listed set of Campus call sites, each of which then checks the record OWNER with `isEnabledFor`. A pilot-list read error is "not enabled" (fails closed).

**A switch gates capabilities, never stored restrictions (R81).** It decides whether new input is accepted, a route answers or a row may be created. It never decides whether stored state is honoured: the worker-path audience filter, the live-hash review gate and (from #2749) payment checks always run, so turning a switch back to `off` — the rollback lever — cannot expose an RVM-only job to BadaBhai workers. While a switch is off for a company its routes are the house neutral 404 and the audience fields are ignored.

`payers.is_test_account` marks a test company; rows it creates copy it (`campus_drive_requests.is_test`).

### 3.6 Campus-drive requests: pull, not push

The drive itself is a Campus record (a Campus job with `interview_type = 'campus_rvm'`). BadaBhai keeps the REQUEST: `campus_drive_requests` with the company's tenant key, the optional posting, preferred branches and dates, openings, a roles note, the contact person (AES ciphertext), the status, and once scheduled the date and Campus's id for its drive (`campus_drive_ref`).

- **Company routes** (`/payer/campus-drive-requests`: create, list, read, cancel), employer-only (`PayerRoleGuard`), tenant-scoped in every query, neutral 404 while the switch is off for the company. Create requires `Idempotency-Key`, stored on the row and unique per company: the lasting guard. `RequestIdempotency` handles a duplicate in flight (`409 in_flight`) and its Redis key carries a digest of the normalised body, so the same key with a different body is `409 idempotency_key_reused` inside and after the Redis window. A repeat of a stored request answers it before any other check.
- **Campus routes** (`GET drive-requests`, `POST drive-requests/:id/decision`), behind `CampusServiceGuard` only. Campus PULLS the queue in change order (`changed_at`, microsecond keyset; a two-minute overlap window) and POSTS each decision back. BadaBhai holds no Campus credential for this and sends nothing. If JP-D-05 later prefers a push, the `campus_drive.requested` event is the trigger for the outbound sender of BB-D-02; nothing here changes.
- **Lifecycle:** `requested` → `scheduled` | `declined` (Campus); `scheduled` → `scheduled` (reschedule) | `declined` | `completed` (Campus); `requested` | `scheduled` → `cancelled` (the company). `declined`, `completed`, `cancelled` are final. An illegal decision is `409 DECISION_NOT_ALLOWED` with the status. The decision and the cancel lock the request row `FOR UPDATE` first and take no other row lock, so they serialise and cannot deadlock.
- **Events** in the row's transaction, ids, enums and dates only: `campus_drive.requested`, `campus_drive.decided`, `campus_drive.cancelled` (v1, new domain `campus_drive`). Never the contact, the note or the reason.
- **Personal data.** The contact name and phone are stored as ciphertext, registered for key rotation, returned to the company only as the name and the phone's last four digits, and DECRYPTED for RVM's placement team in the Campus feed — the purpose they were collected for. They are erasable without deleting the request (`cdr_contact_chk`): the account deletion erases the contacts a login entered on requests that outlive it; a company's own requests go with its `payers` row. **Ruling requested:** that erasure is keyed by the deleted LOGIN (`created_by`), not by a tenant key, so it is an ADR-0053 §4 exception of the existing "the person, not the tenant" kind (`CampusDriveContactErasureRepository.eraseEnteredBy`, listed in `ORG_TENANCY_PLAN.md` §4 and the T5 `NAMED_EXCEPTIONS`). If refused, the deletion falls back to the cascade alone and a team member's typed contact outlives the member.

### 3.7 Who may ask for a drive

Verified employer = admin approval (`employer_profiles.verification_status = 'verified'`, written only by the admin Companies surface) **and** a GST number on file (`employer_profiles.gst_number_enc`). The brief's alternative, "a phone-verified owner", has no meaning in the code today (an OTP proves the configured channel, by default email; nothing records which contact was verified), so it is NOT built: until the owner defines it, a company without a GST number is refused (`403 company_not_verified`, `missing: [...]`). This can only refuse a company the full rule would admit, never admit one it would refuse. The open-request cap (#2768) is a separate issue.

### 3.8 APPLY-BEFORE-MERGE

Migration 0162 is additive, but the new columns on `job_postings` and `payers` are named by bare selects on every posting route, the legacy apply path and every company sign-in, and `main` deploys on every push with no approval. So the database moves first:

1. 0161 (#2752) merged, applied and adopted.
2. `adopt-migrations.ts` verify-only: nothing unrecorded below 0161.
3. Apply 0162 by hand in one transaction with `lock_timeout`; probe each object.
4. Adopt its ledger row from the PR-head tree (`--only 0162_job_audience_campus_drives --apply --expect-host <HOST>`); the file is then frozen.
5. `db:audit:schema-contract`; merge PR 1 at once. PRs 2–6 add no schema and stack on it.

Rollback, only after rolling the API back: hide every RVM-only posting first (an older API shows it to BadaBhai workers), then the drops in the migration header. Every switch ships `off`; a pilot company is the first production use.

## 4. Consequences and risks

- **Disclosure to RVM.** The Campus feed returns each request's contact (name, phone) and the company's display name to the placement team, behind the Campus credential, address allow-list and per-call audit row. A leaked Campus token reads every live request's contact. Security review must accept this.
- **Pilot reads per page.** In `pilot`, the Campus feed resolves each distinct company of a page (tenancy, then the pilot list). Bounded by the page size; fine at pilot scale, and cheaper once the switch is `on`.
- **Tenancy `off`.** Every login is its own tenant, so only a company's founder login can qualify as verified and a team member needs its own pilot row. Under `on` the company record and pilot place are shared.
- **Roles-note screening** uses the shared hard-identifier detector, so a digit range like `15000-18000` reads as a phone and is refused (the company writes it in words). Accepted for one definition across surfaces.
- **No production payer erasure.** The only payer erasure is the QA-only immediate delete; a DPDP request from a contact person who is not a BadaBhai user has no route yet (`CampusDriveContactErasureRepository.eraseOne` is ready for one).
- **A cancelled scheduled drive** is not cancelled in Campus by BadaBhai; Campus must read the feed.

## 5. Rejected alternatives

- **Push drive requests to Campus.** A second credential (BadaBhai → Campus), a retry queue and two directions of trust, for no latency the placement team needs; Campus already polls every minute.
- **Reuse `job_postings.verification_status` for the RVM review.** It does not gate going live, and its writers are not Campus.
- **A review flag reset on edit, without a hash.** One missed reset leaks an unreviewed edit to students; the live-hash rule cannot be forgotten.
- **`audience <> 'rvm_students'` as the worker predicate.** A new audience would be visible to every BadaBhai worker by default.
- **Redact the roles note instead of refusing it.** The company would not know what the placement team reads; refusing tells it to use the contact fields.
- **Count `payers.status = 'active'` as a phone-verified owner.** It proves an OTP on the configured channel (email by default), and an admin-created login is active without one.
