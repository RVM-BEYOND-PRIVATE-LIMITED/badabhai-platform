# ADR-0050: Agency vacancies on Matching V1 — a system-owned `job_postings` twin of each agency job

- **Status:** **Proposed — owner sign-off pending.** The direction (a system-owned twin) is the product owner's
  choice. The constraints in §2 are his. The open questions in §10 are not decided, and each has a recommended
  default.
- **Date:** 2026-10-05
- **Owner:** Prakash (product owner) decides. Backend Platform builds: Divyanshu drives the ADR-0049 exit (#1904),
  and Prakash owns the agency surface (#1885).
- **Decides:** [ADR-0049](0049-interim-union-feed.md) §8 step 1: the V1 path for agency inventory. Of the three
  candidates §8 names, it picks the twin mirror, reshaped by the constraints in §2.
- **Keeps:** #1885 (agencies post agency jobs only, to `jobs`; the company posting surface is employer-only) ·
  [ADR-0036](0036-matching-algorithm-v1.md) §1–§6 (V1 serves `job_reach ⋈ job_postings`; `match_skill_ids` is the
  only match input) and its 2026-09-29 addendum (`role_kind` is display only) ·
  [ADR-0047](0047-lift-pii-restriction.md) · [ADR-0024](0024-worker-visible-job-fields-pii.md) (the worker-visible
  free-text guard) · [ADR-0037](0037-payer-lifecycle-and-suspension.md) (`suspended` is system-owned).
- **Does not edit:** ADR-0049. Its union arm, its apply/skip resolution and `FEED_POSTINGS_UNION_ENABLED` are
  untouched by this ADR (§6.1).
- **Relates:** #1904 (V1 flip prerequisites) · #1823 (the union) · #1885 · D4 `packages/db/src/convert-seed-jobs.ts`
  · D5 `packages/db/src/materialize-job-reach.ts` · `TRADE_TO_MATCH_SKILL` (`packages/taxonomy/src/match-skills.ts`)
- **Flag:** `AGENCY_TWIN_SYNC_ENABLED` (new; default off; a GitHub `production` environment secret). It is the kill
  switch (§7).

---

## 1. Context

V1 serves only `job_postings`. Agency vacancies live only in `jobs`, and #1885 (owner ruling, 2026-10-01) keeps them
there: agencies author agency jobs on `jobs`, and the company posting surface is employer-only. If V1 flips with
nothing else done, every agency vacancy leaves the worker deck. ADR-0049 §8 makes the agency path the first exit
step and leaves the choice to the owner. §8 step 2 (D4) may not run against live agency inventory before that
choice exists.

**The production probe of 2026-10-01 (11:18Z), as recorded in ADR-0049 §1:**

- The 3 agency jobs carry **569 impressions and 17 applies** on the spine. They are the only real payer demand
  served so far.
- `job_reach` = 0 and `worker_skill` = 0. A V1 deck today is empty for every worker.
- `source_job_id` is NULL on every posting, so no D4 conversion has run. `role_kind` is NULL on every row of both
  tables.
- `feed.shown` rows keyed on `jobs` ids are 93% of the spine.

**Why D4 cannot simply carry agency rows across.** D4 converts every open `jobs` row. It copies
`payer_id = jobs.payer_id`, so an agency row becomes an **agent-owned posting**, which #1885 forbids. It closes the
source row, so the agency loses the job it authors. It derives the match skill from
`TRADE_TO_MATCH_SKILL[trade_key]`, a bridge whose own doc comment says it "exists for the ONE-TIME conversion of
the ADR-0009 seeded job fixtures … It is not a runtime path."

## 2. Decision

**Each agency job gets one system-owned `job_postings` twin, linked by `source_job_id`. V1 serves the twin. The
agency keeps authoring the `jobs` row, and the twin is derived from it.**

The owner's constraints, each a requirement on the build:

| #   | Constraint                                                                                                                                                                             |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | The agency keeps authoring in `jobs`. #1885 stands: no agency write path touches `job_postings`.                                                                                       |
| C2  | The twin is **system-owned, never agent-owned** (`payer_id` NULL), and **read-only on every payer surface**. Ops surfaces cannot edit it either (§4.4).                                |
| C3  | The twin is written by **one idempotent sync behind its own flag** (the kill switch). The agency service does not dual-write.                                                          |
| C4  | Match skills come from an **explicit field** on the agency job, captured at agency create/edit or set by ops. They are **never inferred at runtime from `TRADE_TO_MATCH_SKILL`**.      |
| C5  | **Applies, skips and unlocks on a twin resolve to the source job's id space** (`applications.job_id`, `unlocks.job_id`). The twin's own id never becomes an application or unlock key. |
| C6  | **D4 never runs on agency rows before the twin sync exists.** After that, D4 never converts an agency row at all (§6.2).                                                               |

The `jobs` row is the **source of truth**. The twin is a **projection** of it into the served entity. The link is
the existing D4 provenance column, `job_postings.source_job_id`, with its existing UNIQUE index
(`job_postings_source_job_id_uq`). That gives one twin per job, enforced by the database.

## 3. Objections ADR-0049 recorded against the twin, and how the constraints answer each

ADR-0049 §9 kept the twin as "the leading candidate for §8 step 1" and rejected it as the _interim_ for four
reasons. Each is addressed here.

| ADR-0049 §9 objection                                                                           | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **"It does not answer 'while V1 is off'."**                                                     | It is not meant to. The union still answers "while V1 is off" until the ADR-0036 retirement change. This ADR answers §8 step 1, "at and after the flip". Twins stay **unserved on every worker read while `MATCH_V1_ENABLED` is off** (§4.2: status `draft`, `published_at` NULL). So the union deck, search, detail and the union's apply/skip resolution see no new row, and the #1823 code needs no change.                                                                                                                       |
| **"It needs an ungated dual write across the agency service with no kill switch."**             | C3. The agency service writes `jobs` exactly as today and never writes `job_postings`. A **single sync** derives the twin from the committed `jobs` row (§5). It is state-based and idempotent: running it twice, or after a missed trigger, converges to the same row. A periodic sweep is the correctness backstop, so a lost trigger heals instead of drifting. It sits behind `AGENCY_TWIN_SYNC_ENABLED`; disarming drives every twin to `paused` (§7). A failed or slow sync never fails, delays or rolls back an agency write. |
| **"It creates agent-owned postings against #1885."**                                            | C2. A twin has `payer_id` NULL and a fixed system `created_by`, and a new CHECK pins that (§4.1). Payer reads and writes are scoped by `payer_id`, so no payer, agency or company, can list, read, edit, pause, close, boost or buy against a twin. #1885's "employer-only" posting surface is unchanged, because the agency never sees or authors a posting. Its applicants, unlocks and counters stay on its `jobs` row (C5).                                                                                                      |
| **"It promotes `TRADE_TO_MATCH_SKILL` to a runtime classifier against its own documentation."** | C4. The twin's `match_skill_ids` is copied from a new explicit `jobs.match_skill_ids`. An agent picks it on the agency job form, or ops sets it. The sync never reads `trade_key` for matching and never calls `matchSkillForTrade`. An agency job with no match skills gets a `paused` twin: it reaches nobody, visibly, and is never served on a guessed skill. `TRADE_TO_MATCH_SKILL` keeps its one-time, seed-only scope.                                                                                                        |

## 4. Data model, write ownership and read fences

### 4.1 Schema delta (additive only)

One migration, the next free number at build time. Both columns are nullable or defaulted, with no backfill that
changes behaviour, and no existing column is altered or dropped.

| Table          | Column / constraint                                                                                   | Why                                                                                                                                                                                                                                                                                                                             |
| -------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `jobs`         | `match_skill_ids jsonb NOT NULL DEFAULT '[]'`, with `CHECK (jsonb_typeof(match_skill_ids) = 'array')` | C4. The explicit match input. `[]` = "not chosen yet", and every existing row reads `[]`. Each id is validated in the service against the closed `mskill_*` set. The count is capped by `match_config.max_skills_per_posting`, the posting form's rule. Not a rank input: it feeds only the twin's `match_skill_ids`.           |
| `job_postings` | `sync_source text NULL`, with `CHECK (sync_source IS NULL OR sync_source = 'agency_job')`             | Marks a row as a **derived twin**, not a native posting and not a D4 seed conversion. NULL on every existing row. D4 conversions also carry `source_job_id`, but their source is closed and the posting is the entity. A twin's source stays open and the source is the truth. `source_job_id` alone cannot tell the two apart. |
| `job_postings` | `CHECK (sync_source IS NULL OR (source_job_id IS NOT NULL AND payer_id IS NULL))`                     | C2 enforced by the database: a twin is never payer-owned and never unlinked.                                                                                                                                                                                                                                                    |

No new index is needed. The sync looks a twin up by `source_job_id`, which has a unique index, and enumerates agency
jobs through `jobs_payer_id_status_idx`.

**Reversal:** the readers and the sync go dark first (flag off, code reverted). The columns then stay unused; per
CLAUDE.md §10, production columns are not dropped. The CHECKs can be dropped without data loss.

### 4.2 The twin row

| `job_postings` column                                                                                                                                      | Value                                                                                                                                              |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `source_job_id`                                                                                                                                            | `jobs.id`                                                                                                                                          |
| `sync_source`                                                                                                                                              | `'agency_job'`                                                                                                                                     |
| `payer_id`                                                                                                                                                 | NULL (C2)                                                                                                                                          |
| `created_by`                                                                                                                                               | The fixed system actor id (Q3)                                                                                                                     |
| `org_label`                                                                                                                                                | A fixed neutral label, PII/URL-checked at boot. Never a real employer name (`jobs` is faceless, ADR-0009 §2), and never projected to a worker (Q3) |
| `role_title`                                                                                                                                               | `jobs.title`                                                                                                                                       |
| `city`, `area`, `pay_min`, `pay_max`, `pay_type`, `shift`, `needed_by`, `description`, `min/max_experience_years`, `benefits`, `requirements`, `role_kind` | Copied verbatim, nulls preserved. This is D4's field map, and `role_kind` stays display only.                                                      |
| `match_skill_ids`                                                                                                                                          | `jobs.match_skill_ids` (C4)                                                                                                                        |
| `reach_skill_ids`                                                                                                                                          | `match ∪ related(match)`, through the same `resolveReachSet` / `expandReachSkillIds` the posting publish uses. There are no unticks (Q2).          |
| `industry_id`                                                                                                                                              | From the match skill, as the posting form does                                                                                                     |
| `vacancy_band`                                                                                                                                             | `'1'`, D4's conservative default (Q4)                                                                                                              |
| `published_at`                                                                                                                                             | `jobs.created_at` once served (the honest visibility time; ADR-0049's #1649 order key). NULL while unserved.                                       |
| `status`                                                                                                                                                   | See below                                                                                                                                          |
| `verification_status`, `boosted_until`                                                                                                                     | Left at their defaults (`unverified`, NULL) and never written by the sync                                                                          |

**Status.** The sync computes the twin's status from the source row and the deploy state, in this order:

1. `MATCH_V1_ENABLED` off → **`draft`**, with `published_at` NULL. The twin is pre-staged and unserved (§3, row 1).
2. Source `closed` → **`closed`**.
3. Source `suspended` → **`suspended`**. ADR-0037's cascade moves the source. The twin follows on the next sync,
   because `payer_id` is NULL and the cascade cannot reach it directly. `previous_status` stays NULL, since the
   twin is never cascaded itself.
4. Source `paused` → **`paused`**.
5. Source `open`, but `match_skill_ids` is empty, an id is not in the active vocabulary, or the worker-visible text
   fails the screen (§8) → **`paused`**. The `refused` outcome on the event says why.
6. Source `open` → **`open`**.

`closed` is used only when the source closed, so a twin never needs a `closed → open` move. Every "cannot serve
right now" state is `paused`, which is reversible.

### 4.3 Who writes

**Only the sync writes a twin.** Every other `job_postings` writer refuses a row with `sync_source IS NOT NULL`:

- the payer posting routes, which `payer_id` scoping already excludes;
- ops close, verify and edit (`admin-actions`);
- the ADR-0036 ops-widen (`reach-widen`);
- boost and posting plans (`posting-plans`);
- the job-posting chat publish, which only creates new rows.

Each refusal is an identical 409 (ops) or 404 (payer), pinned by a test. The twin is read-only on every payer
surface, and every edit goes through the agency job.

### 4.4 Read fences

- **Worker reads while V1 is off:** no change. A `draft` twin fails `status = 'open'` on the union arm, on
  `searchOpenPostings` and on the union apply/skip resolution, so ADR-0049 needs no edit.
- **V1 feed (`MatchFeedRepository`), once V1 is on:** a twin is served only while its source row is `open`. This is
  one PK join on `source_job_id`. It is defence in depth against a twin that went stale while the sync was down,
  and source status always wins. The V1 applied-only anti-join also matches `applications.job_id = source_job_id`
  (union predicate 3b). Otherwise a worker who applied to the agency job under the legacy feed is re-served its twin.
- **V1 per-company interleave:** `COALESCE(payer_id, created_by)` would put **every agency into one company
  bucket**, because twins share the system `created_by`. The key for a twin is resolved from the source job's
  `payer_id` (opaque, never projected). See Q1.
- **Payer and ops applicant reads:** unchanged. Applications live on the source id (C5).

### 4.5 Applies, skips and unlocks resolve to the source (C5)

When a V1 apply or skip names a twin id, the server resolves it to `source_job_id` **before** it chooses the code
path. It then runs the `job` path in full:

- the row is `applications.job_id = source`, with the conflict on `(worker_id, job_id)`;
- `jobs.applicants_received` is incremented;
- the event is `application.submitted` / `application.skipped` v1 with `subject_type = job` and
  `payload.job_id = source`;
- the idempotency key is `application.submitted:{worker}:{jobs.id}`, byte-identical to a legacy agency apply, so
  applies made before and after the flip dedupe;
- TD73 still applies (applied → skipped is refused).

If the source is not `open`, the response is the identical "Job not found" 404 with no write and no event.

**Rank snapshot (ADR-0036 §5):** captured from the **twin's** reach row onto the source-keyed applications row,
with `engine_version`. ADR-0036 makes this snapshot irreversible ("history not captured on day one is gone
permanently"), so V1-era agency applies must carry it even though they key on `job_id`.

**Unlocks:** an unlock against a twin stores `unlocks.job_id = source_job_id`. This fits the existing FK to
`jobs.id`. ADR-0049 O9 has to store a NULL context for a native posting, and a twin has no such loss.

**History is never repointed.** The 17 agency applies on the spine already sit on `jobs` ids, and they stay there.

## 5. The sync

- **One unit:** `syncAgencyTwin(jobId)`. It reads the committed `jobs` row and computes the target twin (§4.2). It
  upserts on `source_job_id`: `INSERT … ON CONFLICT (source_job_id) DO UPDATE … WHERE <any synced column differs>`.
  An unchanged source writes nothing and emits nothing. It holds a row lock on the source `jobs` row for the
  transaction, so two concurrent syncs of one job serialize. When `match_skill_ids` changes, `reach_skill_ids` and
  that twin's `job_reach` rows are recomputed in the same transaction, through the same materialization the posting
  publish uses. The D5 unticks fix (#1904) does not apply, because twins carry no unticks.
- **Which rows:** `jobs` rows with a non-NULL `payer_id` whose payer is an agent. Seed and ops rows (`payer_id`
  NULL) remain D4's (§6.2). Q8 covers payer-owned rows that are not agency rows.
- **Triggers:**
  1. **Event-driven.** The sync consumes the `job.created`, `job.updated` and `job.closed` events the agency service
     already emits, so **the agency service is not changed to call the sync**. The mechanism (an event-table poll or
     a BullMQ consumer) is the build's choice. It must not run inside the agency write's transaction and must not be
     able to fail it.
  2. **Periodic sweep** (BullMQ repeatable, bounded batch). This is the convergence guarantee. It also catches the
     ADR-0037 suspension cascade and any write that emits no event.
  3. **CLI** `db:sync:agency-twins`, dry run by default, `--apply` to write. It is run in the flip window (§6).
- **Fail closed:** a row that fails validation (unknown match skill, text screen) gets a `paused` twin and a
  `refused` event (§8). The sync never writes partial fields. A DB error aborts that row's transaction; the sweep
  retries it, and the agency job is unaffected.

## 6. Rollout, relative to ADR-0049 §8

### 6.1 Build (each step merges dark)

1. **Migration** (§4.1).
2. **Agency API:** `match_skill_ids` becomes an optional field on agency job create/edit. It is validated against
   the closed vocabulary and the cap. Omitted means unchanged on edit and `[]` on create, so shipped clients are
   unaffected. `job.updated` reports it under a new `match_skills` key (§9). An ops endpoint sets it on any agency
   job. **Frontend follow-up (Rishi), raised as an issue on sign-off and not built here:** a match-skill picker on
   the payer-web agency job form and the ops console. #1885's UI routing is unchanged.
3. **Write fences** (§4.3).
4. **Sync** and its flag plumbing, the same plumbing as ADR-0049 §6: the `production` environment secret, the
   `ci.yml` `env:` entry and appleboy `envs:` allowlist, `docker-compose.staging.yml`, `.env.example`, and a boolean
   preflight in `staging-deploy.sh`.
5. **V1 read and apply changes** (§4.4, §4.5). They are inert while V1 is off.
6. **D4 fence** (§6.2).

### 6.2 D4 (ADR-0049 §8 step 2)

D4 selects **only open rows with `payer_id` NULL** (seed and ops rows). It **reports and never converts** an open
payer-owned row, whether or not it has a twin, and refuses `--apply` while any such row has no twin. Today D4 does
skip a row that already has a twin (`alreadyConverted`), but it would convert an agency row the sync has not reached
yet, copying the agent's `payer_id` and closing the agency's live job. The fence closes that window for good, not
just by run order (C6).

### 6.3 Order

| Step                                                                                                                                                                       | V1     | Twins                       | Worker-visible change           |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | --------------------------- | ------------------------------- |
| a. This ADR signed; §10 answered                                                                                                                                           | off    | none                        | none                            |
| b. §6.1 merged, in order, each dark                                                                                                                                        | off    | none                        | none                            |
| c. Ops sets `match_skill_ids` on the live agency jobs (3 at the probe)                                                                                                     | off    | none                        | none                            |
| d. **Arm `AGENCY_TWIN_SYNC_ENABLED`** and redeploy                                                                                                                         | off    | `draft`, one per agency job | none (§4.4)                     |
| e. Probe: twin count = agency job count, every twin `draft`; union deck and search unchanged                                                                               | off    | `draft`                     | none                            |
| f. §8 step 3 prerequisites close (#1904: status gate, funnel, V1 secrets bridge and e2e, D5 fix)                                                                           | off    | `draft`                     | none                            |
| g. **Flip window:** deploy with V1 on → `db:sync:agency-twins --apply` (twins go to their mirrored status) → D4 (seed rows only, §6.2) → D5 `db:materialize:reach --apply` | **on** | mirrored                    | agency vacancies on the V1 deck |
| h. §8 step 5: the ADR-0036 retirement deletes the union, its apply branch and `FEED_POSTINGS_UNION_ENABLED`                                                                | on     | mirrored                    | none                            |

Step (g) extends the runbook's D4 → D5 order to sync → D4 → D5. **Pre-flip check:** every open agency job has a
non-empty `match_skill_ids`. Otherwise its twin is `paused` and the vacancy disappears from the deck at the flip,
which is the exact regression this ADR exists to prevent.

## 7. Kill switch and rollback

**`AGENCY_TWIN_SYNC_ENABLED`** is read only through `isAgencyTwinSyncEnabled(config)`. It is a deploy switch, not
match tuning, and it sits beside `MATCH_V1_ENABLED` like S1's flag in ADR-0049.

- **Armed:** the sync runs as in §5.
- **Disarmed:** the sync does **one thing only**. It drives every non-`closed` twin to `paused` in a single bounded
  `UPDATE … WHERE sync_source = 'agency_job'`, and copies no fields. So disarming is a single action that removes
  agency inventory from the V1 deck, and a buggy sync stops writing content.
- **Rollback is symmetric:**
  - Applications, skips, unlocks and counters all live on the source `jobs` id (C5), so pausing twins hides nothing
    anyone already acted on. The agency's applicants page, the worker's Applied tab and the ops reads are unchanged.
  - Re-arming restores every twin to its mirrored status on the next sweep.
  - It takes a redeploy (minutes, not seconds), as with every flag in this repo.
- **Before the flip,** disarming is a no-op for workers, because twins are `draft` either way.
- **Revert of the whole change:** after the flag is off, the columns stay unused (§4.1). Twins remain as `paused`
  rows with `sync_source` set and can be closed by the CLI. None is ever deleted, because `source_job_id` is
  provenance.

**The V1 flip itself** keeps its own rollback story (#1904, runbook). This ADR adds nothing irreversible to it,
because no `jobs` row is closed for agency inventory.

## 8. Privacy (ADR-0047) and safety

- **No LLM on any path here.** Match skills are a closed-set pick by a person, never extracted or inferred by a
  model and never inferred from `trade_key`. Visibility, status and order are deterministic SQL and TypeScript.
  `AI_RAW_PII_ENABLED` does not apply.
- **Employer identity stays off the worker path** (ADR-0024 HIDDEN). `org_label` is a fixed neutral constant,
  PII/URL-checked at boot, and the V1 feed does not select it. `payer_id` is NULL. The source agency's `payer_id` is
  read only as the opaque interleave key (Q1), never projected and never in a payload.
- **Worker-visible free text is re-screened at sync** with `screenJobTextForConversion`
  (`looksLikePii`, `looksLikeOrgName`, `looksLikeUrl`): `role_title` from `jobs.title`, `description`, and each
  `benefits` / `requirements` chip. The agency write already screens these. The sync re-screens and fails closed
  (`paused`, `refused`), so a row edited by hand, or one that predates a screen change, cannot reach the deck.
  `city` and `area` follow #1848's outcome for postings.
- **Events carry ids and enums only.** The actor is `system`. No free text, no `org_label` and no agency id appear
  in a payload.
- **Consent and DPDP are unchanged.** Apply and skip stay behind `ConsentGuard`. Applications cascade on worker
  delete through `applications.job_id` exactly as agency applies do today. A twin holds no worker data.
- **Secrets:** the flag is a boolean and logs its value only.
- **AI never decides:** the agent or ops picks the skills, the curated relations widen them deterministically, and
  V1's lexicographic key ranks. Nothing in this ADR ranks, rejects or hides a worker.

## 9. Events

No existing event schema is mutated, and no existing event version changes.

| Event                                                      | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `job.updated` v1                                           | `JOB_CHANGED_FIELDS` gains `"match_skills"`, a KEY only and never the ids. This follows the precedent in `payloads.ts` (`description`, `pay_type` and `role_kind` were each added the same way, and `job_posting.updated` already carries `match_skills`). Every payload ever emitted still validates, and no existing key changes meaning.                                                                                                                                  |
| **`job_posting.twin_synced` v1 (new)**                     | Emitted once per sync that **changes** a twin, or refuses to serve one. `actor_type: system`, `subject_type: job_posting`, `subject_id` = twin id. Payload `.strict()`: `{ job_posting_id, source_job_id, operation: "created" \| "updated" \| "status_changed" \| "refused", status, changed_fields: <JOB_POSTING_CHANGED_FIELDS keys>, refused_reason: "no_match_skills" \| "unknown_match_skill" \| "text_screen_failed" \| "kill_switch" \| null }`. Ids and enums only. |
| `job_posting.created` / `.updated` / `.closed` / `.paused` | **Not emitted for twins.** Consumers read them as company-posting lifecycle (admin dashboard, posting counts), and `JobPostingClosedPayload.previous_status` admits only `draft \| open`, so a twin closing from `paused` or `suspended` would not validate. Reusing them would either fail validation or count agency vacancies as company demand.                                                                                                                          |
| `application.submitted` / `.skipped` v1                    | Unchanged. A twin apply is a `job`-subject event keyed on the source id (§4.5), indistinguishable from today's agency apply. That is intended: agency demand metrics continue across the flip.                                                                                                                                                                                                                                                                               |
| `feed.shown_v2`                                            | Unchanged schema. A twin impression carries the **twin** id (subject `job_posting`), joinable to the agency job through `source_job_id` (Q5).                                                                                                                                                                                                                                                                                                                                |

## 10. Open questions (owner)

Each has a recommended default. None is decided by this draft.

| #   | Question                                                                                                                                                      | Recommended default                                                                                                                                                                                                                                                             |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | V1's max-consecutive-per-company interleave: what is an agency twin's "company"?                                                                              | **The source job's `payer_id` (the agency), read opaque.** Otherwise every agency shares the system bucket and is throttled as one company. An agency places for several employers that `jobs` does not record, so per-employer interleave is not possible without a new field. |
| Q2  | Breadth control: can an agency untick related skills, as a company can (ADR-0036 §1, "breadth belongs to the company")?                                       | **Not in this phase.** Twins reach `match ∪ related` (D4's behaviour and `related_skills_default`). Untick control on the agency form is a follow-up with its own column and its own UI.                                                                                        |
| Q3  | The system `created_by` actor id and the neutral `org_label`                                                                                                  | **A fixed system-actor UUID and a fixed neutral label, both in `packages/config`,** checked at boot. D4 demands them as CLI args. A continuous sync needs them as configuration, never per-run guesses.                                                                         |
| Q4  | `vacancy_band` for a twin. `jobs` has no vacancy count.                                                                                                       | **`'1'`** (D4's conservative band). A twin has no payer, so ADR-0016 capacity never counts it. A band on the agency form is a later, additive change.                                                                                                                           |
| Q5  | The id space of V1 impressions for agency inventory                                                                                                           | **The twin id** in `feed.shown_v2`, which is strict and unchanged. Agency impression reports join through `source_job_id`. Rewriting impressions into the source id space would need a new event version for no matching benefit.                                               |
| Q6  | What does an agency see on its applicants page after the ADR-0036 retirement deletes the weighted engine? Today it sees the weighted full pool (ADR-0049 O8). | **Out of this ADR's scope; flagged.** Twin applies carry V1 snapshots (§4.5), so the V1 candidate list can serve the agency later. The ruling belongs to the retirement ADR.                                                                                                    |
| Q7  | P9's invariant "an unverified posting is never visible to any worker" (unbuilt; deferred by ADR-0049 O3). Twins are `unverified` and have no payer to verify. | **Twins are exempt from a P9 verified-only gate.** The agency's KYC (`agency_kyc.verified`) is the trust signal for agency inventory. Otherwise P9 hides all agency demand. This needs the owner's ruling and security-engineer's review.                                       |
| Q8  | Are there open `jobs` rows with a non-NULL `payer_id` that are not agency rows (legacy employer rows on `jobs`)?                                              | **Probe before step (c).** If any exist, the owner rules whether each row gets a twin or is closed. D4 never converts them (§6.2).                                                                                                                                              |
| Q9  | Must the agency job form require `match_skill_ids`?                                                                                                           | **Optional at the API** (backward-compatible for shipped clients), and **required by the payer-web form** once the picker ships (frontend's call, in Rishi's issue). Until then, ops sets it, and the pre-flip check in §6.3 holds.                                             |

## 11. Consequences

1. V1 serves agency vacancies without changing how agencies author, so #1885 stands. `job_postings` is the only
   served entity, in line with ADR-0036 §6 and team ruling 3, because `jobs` leaves the worker path and remains only
   as the agency's authoring store. Collapsing the tables remains post-launch debt, as ADR-0036 §6 already says.
2. **Two writers, one owner per row.** Every native posting is written by its payer or ops. Every twin is written
   by the sync alone, and the CHECK in §4.1 plus the fences in §4.3 enforce it.
3. Agency applications, unlocks and counters never change id space across the flip. Agency demand metrics and the
   agency applicants page continue without a migration or a repoint.
4. **One new flag, one new event, two new columns, no breaking change.** The union and its flag are untouched and
   are retired on ADR-0049's own schedule.
5. Agency inventory reaches V1 workers **only through match skills a person chose**. An agency job with none is
   visibly `paused`, never silently served on a guess. The cost is ops work before the flip (§6.3 c).
6. A twin can lag its source by up to one sweep interval if an event is lost. The V1 read fence (§4.4) and the apply
   resolution (§4.5) keep a stale twin from ever serving a closed or paused vacancy, or accepting an apply to one.

## 12. Alternatives rejected

| Alternative                                                      | Why it lost                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Agency postings on `job_postings`** (agencies author postings) | **Reverses #1885** (owner ruling 2026-10-01: agencies post agency jobs only, to `jobs`; the posting surface is employer-only). It moves the agency UI to a form that was just made employer-only. It creates agent-owned postings and the `payer_id`-scoped read access #1885's comment asks to settle. And it strands the 17 existing agency applies on `jobs` ids, or forces a repoint, which invariant 8 forbids. |
| **Collapse `jobs` and `job_postings` into one table**            | **Breaking and non-additive.** It renames or drops production columns, rewrites `applications.job_id` / `unlocks.job_id` FKs and every consumer, and changes the meaning of `feed.shown` v1 `payload.job_id` for 93% of the spine. That is against CLAUDE.md §3 and §10, and ADR-0036 §6 already defers it as post-launch debt. It also cannot ship dark or roll back with a flag.                                   |
| **Posting → `jobs` mirror** (serve everything from `jobs`)       | **It invents `trade_key`**: `jobs.trade_key` and `jobs.city` are NOT NULL, and a posting has no trade, so the mirror fabricates a classification the payer never entered (ADR-0049 §9 row 3). It entrenches `jobs` on the worker path, the opposite of ADR-0036 §6, and does nothing for V1, which reads only `job_postings`.                                                                                        |
| **D4 as written, agency rows included**                          | It creates agent-owned postings (`payer_id` copied), closes the agency's live job, and infers match skills from `TRADE_TO_MATCH_SKILL` at runtime. Each of those breaks C1, C2 or C4.                                                                                                                                                                                                                                |
| **Dual write inside the agency service**                         | It couples an agency write's success to a posting write and has no kill switch short of a revert. Its failure modes produce drift with no convergence step (ADR-0049 §9 row 2). C3 rejects it.                                                                                                                                                                                                                       |
| **Serve twins on the legacy deck while V1 is off**               | The union already serves the agency vacancy from `jobs`. A live twin would duplicate it in search and detail (which read any open posting), and the union's apply resolution would write it to `job_posting_id`, against C5. Avoiding that would need changes to #1823's union internals. Keeping twins `draft` until the flip needs none.                                                                           |

---

```
Proposed 2026-10-05. Owner sign-off pending: the direction (system-owned twin) and constraints C1–C6 are the
owner's; Q1–Q9 are open with recommended defaults.
Signed: ____________________ (product owner)          Date: __________
```
