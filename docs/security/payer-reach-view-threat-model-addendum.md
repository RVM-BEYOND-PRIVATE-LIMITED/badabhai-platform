# PII-Disclosure Threat Model — Self-serve Payer REACH VIEW (ADR-0019 Decision C/E) — ADDENDUM

> **Addendum to** [payer-portal-external-disclosure-threat-model-addendum.md](payer-portal-external-disclosure-threat-model-addendum.md)
> (the payer DISCLOSURE surface) **and** the Reach serving model ([ADR-0011](../decisions/0011-reach-feed-serving.md)
> / [ADR-0015](../decisions/0015-reach-feed-on-real-jobs.md)). It re-runs the model for the
> **payer-self REACH read** — the faceless ranked candidate list a payer sees for a job they
> own (`GET /payer/reach/jobs/:jobId/applicants`, ADR-0019 R22 / PR2) — against an **untrusted,
> authenticated, possibly adversarial external payer**. Required as the **pre-build gate** for
> the external reach surface (ADR-0019 Decision E / E-R1). The base models' methodology,
> invariants, and controls apply **verbatim** unless overridden here. **Design-level — a
> `bb-security-review` PASS against the built surface is still required before merge.**

## 0. What this surface is (and is NOT)

The payer reach view **reuses the unchanged `ReachService` ranking orchestration** (the
deterministic `@badabhai/reach-engine` core, the faceless worker projection, sort-never-block,
count-in==count-out) over the **payer's OWNED `jobs`** (resolved by `jobs.payer_id == session
payer`). The ONLY deltas from the ops `/reach/*` View A are **ownership scoping** and the
`feed.shown` **actor**.

- It is **information-only** (ADR-0011/0019): **no quota consumption, no credit debit, no
  payment, no `applicantsViewedCount` touch**. The billable / identity path stays the SEPARATE
  fail-closed `UnlockService` disclosure chokepoint under `/payer/unlocks` (a payer reaches an
  actual worker identity only there — masked, consented, capped).
- It serves **faceless rows ONLY** — opaque `worker_id` + ranking signals + the engine's
  explainable `components[]`. **No name / phone / address / employer / worker PII** anywhere.
- It is **NOT** bound to `job_postings` / `posting_plans` (ADR-0012's "no bridge" stands); the
  monetization↔reach bridge is a separate future ADR (TD37). Reach is over `jobs.payer_id` only.
  **Superseded for company postings — see §5 (#1823):** the route now also lists the actual
  applicants of an owned `job_postings` row, ownership-checked on `job_postings.payer_id`.

## 1. Reused unchanged (must hold against an attacker)
- **FACELESS rows + events** — `feed.shown` and the response carry opaque ids + ranking signals
  only (ADR-0011). No worker PII, ever.
- **RANK core immutability** — `@badabhai/reach-engine` is imported, never modified; no LLM; no
  scoring/ranking change on this path (a payer cannot "boost" or reorder).
- **sort-never-block / count-in==count-out** — no relevance filter; the response is an ordering
  of the full pool, never a membership decision.
- **one principal per route** — `/payer/reach/*` is payer-only (`PayerAuthGuard`); the ops
  `/reach/*` stays its own (unauthenticated) principal. No route reachable by two classes.

## 2. New threats (the deltas this addendum exists for)

### RV1 — Authenticated scrape / mass harvest of the ranked pool
An adversarial payer repeatedly loads `…/applicants` to harvest the candidate set (opaque
worker ids + signal fingerprints). **Controls:** (a) **per-PAYER reach rate cap**
(`PAYER_REACH_MAX_PER_HOUR`, fail-closed via `PayerDisclosureRateLimit` scope `payer_reach`) —
the reach analogue of XB-G; (b) rows are **faceless** (no PII to harvest — only opaque ids);
(c) **ownership scoping** — a payer can only load the pool for a job they OWN, never an
arbitrary job. **MUST hold + tested.** **ACCEPTED ALPHA POSTURE:** a single call returns the
**FULL ranked pool** for the owned job (no pagination) — the deliberate sort-never-block /
count-in==count-out contract inherited from ops View A (ADR-0011); it discloses ranking signals
(not identity) for every worker, bounded by the rate cap (a) + faceless rows (b). Page-bounded
disclosure is a possible future hardening, NOT a build blocker. Residual: the cap bounds
velocity, not total over time (monitored; see RV-R1).

### RV2 — Worker de-anonymization via rank/score fingerprinting
A payer correlates `score`/`components[]` for the same opaque `worker_id` across multiple owned
jobs (or over time) to infer attributes. **Controls:** (a) the surfaced signals are the
deterministic ranking factors (trade/city/pay-band/experience/availability) — **not identity**,
and never PII; (b) `worker_id` is an opaque UUID that resolves to a real person ONLY through the
separate **consented + capped** unlock chokepoint (which has its OWN per-worker shared cap,
payer-count-independent); (c) the per-payer reach cap bounds correlation volume. **Residual
RV-R2:** cross-job correlation of ranking signals is not fully eliminable on an explainable
ranker — bounded by the rate cap + the identity-path cap, acceptable for **closed beta**,
monitored (XL-E).

### RV3 — Horizontal authz / cross-payer enumeration (tenant crossing)
Payer A requests `…/jobs/:jobId/applicants` for payer B's job, or probes random job UUIDs to
learn which exist / belong to whom. **Controls:** the payer-scoped ownership read
`findOwnedJobSignalRowById(jobId, payerId)` returns the row ONLY when `jobs.id == jobId AND
jobs.payer_id == session payer`; **a not-found job AND another payer's job both resolve to the
IDENTICAL neutral 404** (no-oracle, F-3) — a payer learns nothing about jobs they do not own.
`payer_id` is from the **verified session**, never the route/body (XB-A). **Build-blocker test:**
payer A ↔ payer B + absent-job all return the same neutral response (`reach.service.test.ts`,
`payer-reach.controller.test.ts`, `guard-contract.test.ts`). Since #1823 the no-oracle matrix
lives in `payer-applicants.service.test.ts`; see §5 for the posting read and every test location.

### RV4 — `payer_id` / worker PII leakage into events/logs
**Controls (INV #2):** `jobs.payer_id` is consumed **only** in the ownership WHERE predicate; the
SELECT reuses the faceless `JOB_SIGNAL_COLUMNS` projection (which structurally **omits**
`payer_id`, `title`, `area`), so it never enters a `JobSpec`, the response, a `feed.shown`
payload, or a log. `feed.shown` stays PII-free; `payer_id` appears only as the event **actor_id**
(an opaque rail, never resolved to `payers` contact PII). **Tested** (payload is `worker_id`/
`job_id`/`rank`/`score`/`hot` only; payer_id absent from payload).

### RV5 — `feed.shown` actor spoofing
A payer forges the impression actor. **Controls:** `actor_id` is bound to `req.payer.id` from the
validated session inside `applicantsForOwnedJob` — never the route/body. **Tested** (the emitted
`actor` equals `{actor_type:"payer", actor_id: session payer}`).

## 3. Residuals (acceptable for staged build, tracked) + conditions

**Residuals (documented):**
- RV-R1 — **cumulative scrape:** the per-payer hourly cap bounds velocity, not lifetime volume;
  abuse/velocity monitoring (XL-E) is the launch-time backstop. Closed-beta acceptable.
- RV-R2 — **rank/score correlation:** irreducible on an explainable ranker; bounded by the rate
  cap + the identity-path per-worker cap; monitored.
- RV-R3 — **no-oracle timing:** bodies are byte-identical for absent/not-owned; timing
  normalization (LC-7) remains a deferred launch gate (same posture as the disclosure surface).
- RV-R4 — **app-layer tenancy only:** ownership is enforced by `findOwnedJobSignalRowById`
  (app-layer); DB-enforced RLS on `jobs`/payer tables is the open-GA launch gate (XL-A).

**MUST hold at BUILD (mandated + tested):**
- RB-A — ownership scoping (`jobs.payer_id == session payer`) on every payer reach read; no-oracle
  identical 404 for absent + not-owned (RV3). `payer_id` from the session, never the body (XB-A).
- RB-B — faceless rows + PII-free, payer-free `feed.shown` payload; `payer_id` only in the
  ownership WHERE + as the opaque event actor_id (RV4).
- RB-C — per-payer reach rate cap, fail-closed (RV1).
- RB-D — `feed.shown.actor_id` bound to the verified session (RV5).
- RB-E — reach stays information-only: no quota/credit/payment touched; RANK core unchanged; no LLM.

**MUST clear at LAUNCH (human-gated, open external GA):**
- XL-A — **DB-enforced RLS** for `jobs` + payer-owned tables (closes RV-R4).
- XL-E — abuse / velocity monitoring on the reach read operational (closes RV-R1/RV-R2).
- LC-7 — latency-normalize the no-oracle path (closes RV-R3).

## 4. Verdict

With §1's reused controls **and** §2's new controls (RB-A…RB-E) **mandated and tested**, the
self-serve payer reach view may be built and exercised in **closed beta** (app-layer tenancy,
mock posture). The load-bearing controls are **actor-independent and faceless**: the response
exposes no PII, ownership scoping + no-oracle bound cross-tenant access, and the only path to a
real worker identity remains the separate consented + capped disclosure chokepoint — untouched by
this read. **Open external GA remains human-gated** (XL-A/XL-E/LC-7). This addendum is the
**ADR-0019 E-R1 pre-build gate** for the reach surface; a `bb-security-review` PASS against the
built surface is required before merge.

## 5. Amendment — company postings on this route (#1823, 2026-10-01)

Owner decision O8 (#1823): with `MATCH_V1_ENABLED` off, an id that is not an owned `jobs` row
but IS an owned `job_postings` row now returns that posting's **actual applicants** (the V1
candidate shape), ungated by `FEED_POSTINGS_UNION_ENABLED`. With V1 on, only the posting branch
runs, as before. The source selection moved out of the controller into
`PayerApplicantsService.listForOwned`; the controller is HTTP-only (cap, then delegate).

- **Second ownership read (RV3 / RB-A).** The id is resolved in order: an owned `jobs` row
  (`ReachRepository.findOwnedJobSignalRowById`, `jobs.id = $1 AND jobs.payer_id = $2`), then an
  owned posting (`JobPostingsRepository.findByIdAndPayer` via `JobPostingsService.getOneForPayer`,
  `job_postings.id = $1 AND job_postings.payer_id = $2`). Both bind the **session** payer only and
  consume it only in the WHERE; neither projects `payer_id`. RV-R4 (app-layer tenancy only)
  now covers `job_postings` as well as `jobs`.
- **No-oracle across three miss cases.** An unknown id, another payer's job and another payer's
  posting return the identical `404` `error` object (`message: "Job not found"`). The posting
  seam's own "Job posting not found" is re-thrown as the neutral message, so the table an id
  lives in cannot be learned from the body. Only the per-request `path`/`requestId`/`timestamp`
  differ, as on every response. RV-R3 (timing) is unchanged: every miss costs the same two
  ownership reads.
- **Fail closed.** Only `NotFoundException` becomes the neutral 404. A DB error on either
  ownership read or on the candidate read is a **5xx**. The V1 branch this replaced swallowed
  every error into the 404 (`.catch(() => undefined)`), reporting an outage as "you own nothing".
- **Faceless (RB-B).** The posting rows carry an opaque `workerId` and `applicationId`, the frozen
  snapshot integers, a match-skill label and the engine version. No worker PII, no employer.
- **No `feed.shown` on the posting branch** (the V1 precedent: people who already applied are
  not a feed impression). RB-D (actor binding) therefore applies to the legacy `jobs` branch
  only. **New residual RV-R5:** a posting-list read is rate-limited (RB-C, a Redis counter that
  expires hourly) but **not durably audited**; no event or access log records it. A durable
  read trail, if wanted, is a new versioned event, never a reused `feed.shown`.
- **ADR-0031 ruling (b) freeze.** Neither source lists a worker pending deletion: the legacy pool
  through `ReachRepository.listSignalRows`, the posting list through
  `MatchFeedRepository.listCandidates` (`JOIN workers` + `deletion_scheduled_at IS NULL`, added in
  #1823 because the V1 query lacked it and this change makes it a live surface).
- **Identity path unchanged.** Unlocking an applicant from a posting list still goes through the
  `/payer/unlocks` chokepoint. Its posting-id job context is fixed by #1903, which must be on
  `main` before this branch merges.

**Tests (RB-A and the above):** `payer-applicants.service.test.ts` (source matrix; the no-oracle
and IDOR cases run through the real `AllExceptionsFilter`; fail-closed 5xx),
`job-postings.repository.test.ts` (`findByIdAndPayer` SQL pin), `reach.repository.test.ts`
(`findOwnedJobSignalRowById` SQL pin), `payer-reach.controller.test.ts` (cap before delegation,
no data-access dependency), `match-feed.repository.test.ts` and `rank-parity.test.ts`
(pending-deletion exclusion; the latter on real Postgres under `RUN_DB_TESTS=1`).

## 6. Amendment — the cross-posting inbox `GET /payer/reach/applicants` (2026-10-07)

Owner request (Prakash, 2026-10-07): a payer-web **Candidates** tab — one list of every applicant
across all of the payer's postings, newest application first, filterable by posting. It is a new
read on the same `/payer/reach/*` route group (`PayerApplicantInboxController` →
`PayerApplicantInboxService`). Everything in §1–§5 still holds; these are the deltas.

- **Principal.** The session payer only: `PayerAuthGuard`, the same principal class as the
  per-posting list, no ops or worker principal. `payer_id` comes from the verified session (XB-A).
  The query has no slot for one: the schema is `.strict()`, so `payer_id` / `payerId` (and `stage`)
  are a `400`, never silently ignored.
- **Ownership (RV3 / RB-A), two layers.**
  1. One owner-scoped page statement (`inboxPageStatement`): a `UNION ALL` of
     `jobs j … WHERE j.payer_id = :session` and `job_postings jp … WHERE jp.payer_id = :session`.
     These are the same two predicates `listForOwned` resolves an id with, and `payer_id` is never
     projected.
  2. The detail reads that build the rows re-check ownership on their own.
     `ReachRepository.findOwnedJobSignalRowsByIds` binds `jobs.payer_id`;
     `MatchFeedRepository.listRankedCandidatesByApplication` joins `job_postings` on
     `jp.payer_id = :session`. A row the page let through but a detail read does not own is
     dropped, never shown half-built. Measured on Postgres: with either arm's ownership predicate
     in the page statement deliberately removed (one at a time), no row of another payer was
     rendered. RV-R4 (app-layer tenancy only) applies unchanged.
- **No-oracle choice.** The optional `postingId` is a filter on a collection, not a resource
  lookup. An unknown id, another payer's job, and another payer's posting all return
  `200 {"applicants":[],"nextCursor":null}`, byte-identical to an owned posting nobody has applied
  to. Every case costs the same single page read (no separate ownership probe), so neither the
  body nor the read count separates "not yours" from "yours, empty". There is no `404` on this
  route. RV-R3 (latency normalisation) is unchanged.
- **Scrape bound (RV1 / RB-C).** The SAME per-payer bucket as the per-posting list:
  `PayerDisclosureRateLimit` scope `payer_reach`, cap `PAYER_REACH_MAX_PER_HOUR`, ONE unit per page.
  It is checked in the controller BEFORE any read, so a capped payer touches no data. It fails
  closed: Redis down gives the same neutral `429`. Because the bucket is shared, the inbox and the
  per-posting list draw on one hourly budget; they do not add a second one. A page is at most 50
  rows (default 20). RV-R1 (velocity, not lifetime volume) applies unchanged.
- **Projection parity (RB-B).** Each row is EXACTLY the per-posting route's row for that
  applicant, built by the same code, plus `posting { id, title, kind }`:
  - legacy agency row: `ReachService.rankAppliers`;
  - V1 company row: `toMatchCandidateRowDto`.

  `posting.title` is the payer's own title (`jobs.title` / `job_postings.role_title`), never a
  worker field, and it never enters an event. No new PII and no new field reach a payer.
  `rank` / `hot` stay posting-relative. RV-R2 (cross-job signal correlation) is unchanged in kind:
  the inbox shows a worker who applied to two postings as two rows, each with the per-posting
  signals the payer could already read.
- **Membership.** Each per-posting list's own membership, never wider:
  - `action = 'applied'` only;
  - no worker inside the deletion grace window (ADR-0031 (b));
  - an agency applier only if he has a `worker_profiles` row (the agency list ranks profiles).
- **Events (RB-D).** Each agency row on the page emits the same `feed.shown` the per-job list emits
  for it. The actor is the session payer and the payload is the unchanged v1
  `worker_id/job_id/rank/score/hot`, sent as one all-or-nothing batch, only for rows actually on
  the page. Company rows emit nothing, as on their posting's list. A company-only inbox page is
  therefore rate-limited but **not durably audited**: the existing residual RV-R5, now covering
  this read too. A durable read trail remains a new versioned event, never a reused `feed.shown`.
- **Pagination.** Keyset on `(applications.created_at DESC, applications.id DESC)`, a total order.
  The cursor is opaque base64url of `{v:1, t:<created_at, µs UTC>, id:<application uuid>}`. It is
  validated with Zod on the way in, and anything the server did not mint is a `400`. It NEVER
  carries a payer id, a filter, or a count. A forged but well-formed cursor only moves the position
  within the caller's OWN rows, because ownership comes from the session, never the cursor. It
  names an application id the payer was already served.
- **Precedence (dual reference).** `applications_job_ref_chk` allows a row naming BOTH a `jobs` id
  and a `job_postings` id; the write path never produces one. If both are the session payer's, the
  row is listed ONCE, under the agency job: jobs-first, `listForOwned`'s resolution order, and a
  `NOT EXISTS` on the company arm. This keeps the keyset a total order (no duplicate application).
  Consequence: a `postingId` filter on that company posting omits such a row, while its per-posting
  list shows it.
- **Scale note.** Both arms start from the payer's own postings and reach `applications` through
  existing indexes (`jobs_payer_id_status_idx`, `job_postings_payer_id_*`,
  `applications_job_id_idx`, `applications_rank_idx`). They then top-N sort that one payer's
  applied applications. Measured: 1.6 ms over 236k applications. Cost grows with one payer's
  application count, never the table's. At about 100k applications per payer, newest-first across
  postings needs a `payer_id` column on `applications` (with an index on
  `payer_id, created_at DESC, id DESC`). That is an additive migration, not needed now.

**Tests:** `payer-applicant-inbox.service.test.ts` covers ownership (including the defence-in-depth
case), the neutral empty page, ordering and pagination, row parity against the real
`listForOwned`, events, and fail-closed behaviour. `payer-applicant-inbox.repository.test.ts` pins
the page SQL: both ownership predicates, membership, precedence, keyset, and order.
`match-feed.repository.test.ts` pins the window rank text against `listCandidates`.
`reach.repository.test.ts` pins the batched ownership and applier reads.
`payer-applicant-inbox.controller.test.ts` covers the shared bucket and the cap before the read.
`payer-applicant-inbox.dto.test.ts` covers strictness, bounds, and the cursor.
`payer-applicant-inbox.db.test.ts` (real Postgres under `RUN_DB_TESTS=1`, a CI DB gate) covers
ownership, the cross-arm microsecond tie walked at several page sizes, membership, precedence, row
parity, the detail-read ownership layer, and validated `feed.shown` writes.
