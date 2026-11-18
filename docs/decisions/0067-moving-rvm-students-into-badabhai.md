# ADR-0067 — Moving RVM students into BadaBhai as workers

- **Status:** proposed (the owner signs)
- **Date:** 17 Nov 2026
- **Issue:** #2887 (matching side: #2888)
- **Amends:** the #2752 rules for linked students, for MOVED students only

## 1. Context

The CEO's priority list of 17 Nov 2026 asks to move all RVM students into BadaBhai with complete profiles and sign-in. #2752 does the opposite on purpose:
- it links one student at a time, when he applies through Campus;
- it keeps a linked student out of company search, out of AI work and out of matching totals.

Akshit and Prakash ruled on 17 Nov 2026 (comment on #2887; #2888 agrees):

1. Students move **in bulk**; they have given consent.
2. Skills and experience come from each candidate's Campus job profile and his RVM CAD certifications.
3. Once moved, a student is a **BadaBhai worker**, matched by BadaBhai's own engine and shown to companies **only when an admin turns his visibility on**.
4. If a student updates his profile on BadaBhai, **the BadaBhai profile wins** over the imported data.

## 2. Decision

### 2.1 The record of the move (migration `student_move`)

- **The import ledger.**
  - `student_import_batches` records one run.
  - `student_import_rows` records what that run did to each Campus candidate: created, updated, unchanged, held with a reason code, failed, or rolled back.
  - `student_import_subjects` maps a Campus candidate id to the ONE worker he became. One phone is one person, so one candidate maps to one worker. This map makes a re-run idempotent.
- **The field source marker.** `worker_field_sources` records who last wrote each profile field.
  - A worker's own edit marks the field `worker`. The marker is written inside `EffectiveFactsService.supersedeByWorkerEdit`, which every self-edit path already calls.
  - A field the worker owns is never overwritten by a later sync (ruling 4).
- **The visibility switch.** `student_visibility` holds one row per moved student, with `visible` false at import.

### 2.2 Hidden means out of matching (owner choice, 17 Nov 2026)

While a moved student's visibility is off he is **out of matching**:
- no posting reaches him (`job_reach`);
- he counts in no reach total.

When an admin turns it on, his reach is rebuilt and matching postings reach him. The filter lives in the shared reach statement (`materializeJobReachWithin`), in the worker-side reconcile and in the reach counter. Before #2887, `job_reach` had no student rule at all.

The reach filter keys on the TABLE, not on the switch. The reach code depends on no switch of any kind (#2746 M2, pinned by `job-visibility.static.test.ts`):
- before the migration there is no table, and the statements are exactly today's;
- once it exists, only an imported student can have a row, so a hidden one is out whatever the switch says.

### 2.3 #2752's company rules: kept while hidden, lifted when visible

**While a moved student is hidden, #2752's rules hold:**
- He is out of company search.
- Only a company he applied to can open him.
- A hidden student with no link row is gated the same way, without an RVM re-check, since there is no link to re-check.

**Once visible, he is an ordinary worker:**
- He is in company search.
- The open gate treats him as unlinked.
- The pre-pay facts use the ordinary consent rule.

A worker who was never moved is untouched.

### 2.4 Consent: an active row, and BadaBhai's own screen once (owner choice, 17 Nov 2026)

- **The imported row.** The import writes the student's Campus consent as his consent row:
  - `consent_version` is `campus_import:<Campus text version>`;
  - `accepted_at` is his Campus consent date;
  - the purposes include `employer_sharing`.

  So a student made visible can be searched before he ever signs in. The version names no BadaBhai notice, so every rule keyed to one (the brief's contact rules, the employer-sharing notice list) treats it as an older notice. That is the conservative answer.
- **First sign-in.** Sign-in reports `consent_accepted: false` while his latest consent is the imported one. The worker app then shows BadaBhai's own consent screen once, with the 18+ tick (#2541).
  - Accepting writes an ordinary, newer row.
  - An under-18 answer withdraws everything, the imported row included.

### 2.5 The switch

`STUDENT_MOVE_ENABLED` is off by default.
- **Off:** the search, open-gate and pre-pay statements are byte-identical to before, a worker's own edit writes no marker, and the admin routes answer 404. Reach is not switched (§2.2).
- **On before the migration:** the hot reads fall back to their off form, and the routes answer 503.
- **Order:** apply the migration before turning the switch on.

### 2.6 The import (step 3, `apps/api/src/workers/import-campus-students.cli.ts`)

The CLI reads Campus's export (bundle format v1, RVMBeyond_jobportal#197): it decrypts it with the passphrase from `CAMPUS_EXPORT_PASSPHRASE`, checks every file's hash against the manifest, and refuses a bad line with its line number. It runs as a dry run by default. Writing needs `STUDENT_MOVE_ENABLED=true`, the 0182 tables and, against production, the ops guard's flag and environment pair. Each student is decided, then written in his own transaction with his ledger row.

- **Held, nothing written:**
  - A phone that is not his own usable mobile (`phone_missing`, `phone_not_mobile`, `phone_shared`, `phone_company_number`). One phone is one person, and the placement team resolves those cases.
  - Under 18 by Campus's `adult` (`under_18`).
  - **A phone that already belongs to a BadaBhai worker the import did not create** (`already_badabhai_worker`). An existing worker is never hidden, overwritten or taken over.
  - A phone another moved student holds (`phone_shared`).
  - A phone that changed on Campus since the move (`phone_changed`). A login never moves without the person.
- **New student:**
  - A `pending` worker. No `worker.created` is emitted, and no welcome or grant is sent; his first sign-in activates the row.
  - Origin `institute`/`rvm`.
  - His institute link, but only when Campus sent a student reference.
  - A confirmed profile: his own skill and software names, total years, and his role and domain as labels.
  - His match skills as `worker_skill` rows with source `ops`, which a rebuild keeps and his own skill edit clears. Only certain mappings are used; the rest go to the report.
  - His certificates (approved RVM CAD certifications first) and his own work history.
  - The imported consent (§2.4).
  - Visibility OFF.
- **Same record again:** `unchanged`, by the record's content hash.
- **Changed record:** only the fields not marked as his own edit are rewritten, and only on rows the import wrote. Consent and visibility are never touched again.
- **Rollback (`--rollback <batch>`):** removes the workers that run created who never signed in. Removing the worker removes his profile, consent, markers and visibility with him. A worker who signed in since is kept and reported. An updated student's changes are reported, not reverted.
- **Report:** counts by action and reason, the manifest's counts, the problem list's kinds, and every unmapped value with how many students carry it, for the owner to rule on. It carries ids only, never a name or a phone.

## 3. Consequences

- `job_reach` can now depend on an admin decision. A student hidden after a posting was published loses his rows at his next reconcile or the posting's next materialization.
- A moved student with an imported consent is "consented" for every server gate before he signs in. The app still routes him through BadaBhai's consent screen on first sign-in.
- The import itself (mapping, reader and CLI) comes in later PRs. It must not activate the worker row or emit `worker.created`; the first OTP sign-in does that, exactly as for a #2752 link.

## 4. Security review

- **Who may switch:** `manage_student_visibility`, held by super_admin and ops_admin. Each change is audited with the admin's reason and evented. Events carry ids and codes only.
- **No new personal data:** the five tables hold ids, closed codes, counts, hashes and times.
- **Fail safe:**
  - Every hot path asks whether `student_visibility` exists before naming it, so a missing table never aborts a worker's edit, a publish or an open.
  - The open gate still fails closed.
