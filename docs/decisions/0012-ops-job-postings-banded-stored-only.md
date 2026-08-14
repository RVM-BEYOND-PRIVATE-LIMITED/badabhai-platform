# ADR-0012: Ops-created, vacancy-banded, stored-only Job Postings

- **Status:** Accepted — approved as an alpha-gate feature. This ADR is the architecture
  gate; it records the design before any code, schema, or migration is written.
- **Date:** 2026-06-15
- **Phase:** 1 (alpha-gate). Strictly additive; no Phase-2 scope is started.
- **Supersedes/relates:** Adds to the governed event contract (`@badabhai/event-schema`).
  A **distinct entity** from the merged [ADR-0009](0009-alpha-swipe-to-apply-seeded-jobs.md)
  swipe `jobs`/`applications` (coexists, no bridge — see the reconciliation note below).
  Upholds the dead-decision "**No Employer entity**" (master-context ledger) and CLAUDE.md
  §2 invariants 1, 2, 7.

> **Numbering & cross-reference reconciliation note (post-merge, 2026-06-15).** This ADR was
> drafted as "ADR-0010" referencing an *unmerged "PR #42 jobs entity" (then-`ADR-0009`, with
> `job.*` events + an integer `vacancy_count`)*. At merge, `main` had independently assigned
> **0010 to [Contact Unlock + Reveal](0010-contact-unlock-and-reveal.md)**, and **ADR-0009 to
> the merged "alpha swipe-to-apply on seeded jobs"** — a *different* `jobs` table (seeded,
> coarse `trade_key`/`title`/`city`, **no** `vacancy_count`; emits `application.*`, not
> `job.*`). Therefore: (1) this ADR is **renumbered to 0012**; (2) every "PR #42 / `ADR-0009`
> / `job.*` / `vacancy_count`" reference below should be read as **"the parallel ADR-0009
> swipe `jobs` entity"** — the two remain **distinct** entities and the D2 "keep separate, no
> bridge" decision holds unchanged; (3) the migration was regenerated against `main` as
> **`0014`**, and the slice's tech-debt/risk rows are **TD34 / R17**.

## Context

The alpha gate needs ops to be able to record real vacancies — an internal "what roles are
out there" register — so the team can demo and reason about supply/demand without standing up
any of the deferred Phase-2 surfaces. The requirement is deliberately small: an internal
operator types in an opening, it is **stored**, it is **listed/viewable** in the ops console,
and it can be **closed**. Nothing reads these rows for matching, ranking, the Reach Engine,
payments, unlock, or worker-facing exposure — those are all out of scope.

Two constraints shape the design:

1. **The dead-decision "No Employer entity"** stands. We do **not** add an `employers` table,
   a payer self-serve flow, or any join target. An **ops actor** owns the row; the customer
   is captured only as opaque, **non-PII** org/role free text.
2. **A separate `jobs` entity already exists in open PR #42** (`ADR-0009`): Reach-Engine-facing,
   opaque **payer** owner, **integer** `vacancy_count`, quota/lifecycle/boost machinery,
   `job.*` events, `apps/api/src/jobs`. The alpha need is a *different* concern — an ops-typed,
   **banded**, stored-only register — and must not be folded into, or confused with, that
   payer-facing entity. The coexistence is recorded below so it is not later rediscovered as
   accidental debt.

Everything here is **strictly additive**. No existing table, column, event payload, or module
is changed beyond unavoidable wiring (one enum entry per list, one registry entry per event,
one root-module import, one nav link).

## Decision

Build an **ops-created, vacancy-banded, stored-only Job Posting** flow as a new, isolated,
additive slice. The customer-facing concept is "Job Posting"; the entity is `job_postings`;
the event domain is `job_posting`. (Names chosen to stay **unambiguous against** PR #42's
`jobs` / `job.*`.)

**1. New event domain + subject_type (additive enum entries only).**
- Add `"job_posting"` to `EVENT_DOMAINS` in `packages/event-schema/src/enums.ts`.
- Add `"job_posting"` to `SUBJECT_TYPES` in the same file.
- `actor_type = "ops"` **already exists** (`ACTOR_TYPES`, no change needed); writes use it.
- All writes set `subject_type = "job_posting"`, `subject_id = <job_posting_id>`.
- No change to any existing domain, subject, payload, or the envelope.

**2. New `job_postings` table (`packages/db`).** A standalone table; **no FK to any
employer/payer/jobs entity** (none of those are in Phase-1 scope here). High-level columns:

| Column | Type / shape | Notes |
| --- | --- | --- |
| `id` | uuid (pk) | the `subject_id` for all `job_posting.*` events |
| `created_by` | uuid | opaque ops-actor id; **not** a join to any users/employers table |
| `org_label` | text (NON-PII) | customer/org name as typed; **never** in any event payload |
| `role_title` | text (NON-PII) | role/title as typed; **never** in any event payload |
| `location_label` | text (NON-PII, nullable) | city/area as typed; **never** in any event payload |
| `description` | text (NON-PII, nullable) | free-text notes; **never** in any event payload |
| `vacancy_band` | enum: `"1" \| "2-5" \| "6-10" \| "11-25" \| "25+"` | **banded, not an integer**; distinct from PR #42's `vacancy_count` |
| `status` | enum: `"draft" \| "open" \| "closed"` | see open-item (b) |
| `created_at` / `updated_at` | timestamptz | standard audit columns |
| `closed_at` | timestamptz (nullable) | set on transition to `closed` |

The free-text columns hold the human-readable values. Those values live **only** in this
table — exactly as raw worker PII lives only in `workers` (CLAUDE.md §2.2). They are **never**
copied into events, `ai_jobs`, `audit_logs`, or logs.

**3. New `apps/api/src/job-postings` module** following the repo convention
(`controller → service → repository` + `dto` + `module`). Endpoints, each a thin controller
over a service that emits a validated event:

| Endpoint | Event emitted (v1) |
| --- | --- |
| `POST   /job-postings` (create) | `job_posting.created` |
| `GET    /job-postings` (list) | — (read; no event) |
| `GET    /job-postings/:id` (get) | — (read; no event) |
| `PATCH  /job-postings/:id` (update) | `job_posting.updated` |
| `POST   /job-postings/:id/close` (close) | `job_posting.closed` |

Every **write** emits a `createEvent`-built, registry-validated `job_posting.*` event with
`actor_type = "ops"`, `subject_type = "job_posting"`. The root `AppModule` imports the new
module (the one unavoidable wiring change there).

**4. New read-only ops-console route (`apps/web`).** A list + detail view of job postings,
plus the create/update/close forms, behind a single new nav link. Stored-only; no matching,
no ranking, no worker data joined.

**5. PII discipline (CLAUDE.md §2.2 + §2.7).** The `job_posting.*` payloads carry **IDs,
enums, status, band, and changed-field *keys* only — never the free-text values**, mirroring
`WorkerNameRecordedPayload` ("record the fact, not the value"). See open-item (d) for exact
shapes and open-item (c) for the free-text guardrail.

## Principal-engineer review amendments (2026-06-15)

A principal-engineer pass (recommendation sent to TL) reviewed every open decision against
alpha-speed / maintainability / migration-cost / architecture-fit and adversarially verified
each. Net for this ADR: **approve with three amendments**, all folded in below.

- **D1 — keep `draft` default + 3-state lifecycle** (open-items a/b). Confirmed for
  save-before-publish + an explicit, auditable go-live edge that ADR-0011's `JobSource`
  (`"open"` = live) depends on. *Reasoning correction:* the case is forward-compatibility, NOT
  "reusing an existing event convention" — no `job_posting` event domain exists yet, so both
  options are equal on event work. The `JobSource` mapper's `WHERE status='open'` is a product
  publish-predicate, not a relevance filter (sort-never-block intact).
- **D2 — keep `job_postings` and PR #42 `jobs` separate** (coexistence note stands). The
  convergence artifact is deliberately the **lightest**: a tech-debt register row + this ADR's
  follow-ups — **not** a speculative convergence ADR against unmerged #42. Flag carried
  forward: `feed.shown.job_id` is a single opaque UUID with **no source discriminator**; if
  both entities ever emit `feed.shown`, distinguishing them is a future **versioned** payload
  bump (never an in-place mutation).
- **D3 — discipline the PII guardrail** (open-item c, revised): defense-in-depth not primary
  control; phone/email heuristic on `description` only; length caps on all four fields;
  `looksLikePii` extracted to `@badabhai/validators` (no re-paste).

## Open items resolved (PM brief)

**(a) `create` default status → `"draft"`.** Create defaults to `draft`, not `open`. This
gives ops a save-before-publish state, keeps "this opening is live" an explicit, event-marked
act, and makes the lifecycle in (b) meaningful from the first row. (If the human prefers
zero-friction demo creation, the fallback is to default to `open` and drop `draft` — but the
recommendation is `draft`.)

**(b) Lifecycle → `draft → open → closed`, `closed` terminal, no reopen.** Recommended over
the narrower `open → closed`. Rationale: `draft` is cheap, additive, and matches (a); a
terminal `closed` with **no reopen** keeps the state machine trivially auditable (every
transition is one forward-only `job_posting.*` event) and avoids a reopen path that would
imply lifecycle semantics we are explicitly **not** building (that machinery is PR #42's job).
Allowed transitions: `draft → open`, `draft → closed`, `open → closed`. A correction to a
`closed` row is a new posting, not a reopen.

**(c) Lightweight PII guardrail on free-text fields → defense-in-depth, NOT the primary
control.** The real guarantee is **structural**: these four free-text values live only in
`job_postings` and are never copied into events, `ai_jobs`, `audit_logs`, logs, or LLM input
(the §2.2 boundary). The heuristic below is cheap belt-and-suspenders on top of that boundary —
it is explicitly **not** a PII classifier and will not catch an employer name or an address
typed in plain words. The privacy review must treat the boundary, not the heuristic, as the
control.
- **Shared validator, no re-paste.** `looksLikePii` (email-like + phone-digit-run) already
  ships in `apps/api/src/actions`. Extract it to **`@badabhai/validators`** and import it in
  both call sites so the two copies cannot drift.
- **Phone/email heuristic on `description` only.** The digit-run / email reject runs on the
  inherently-free `description` field. It is **NOT** run on `org_label` / `role_title` /
  `location_label`, where a long digit run is a false positive (machine model numbers,
  pincodes, job codes). Reject → 422 "remove contact details" (no LLM involved).
- **Length cap on all four fields** (DTO/Zod) to bound stored free text.
- **Ops-form warning** (`apps/web`): an inline note — "Do not enter worker or personal contact
  details; this is an internal register" — plus a client-side mirror of the `description`
  reject so ops gets the message before submit.

**(d) Exact `job_posting.*` v1 payload field lists (IDs/enums/status/band/changed-keys only —
NO free-text values).** All three are version 1 in `EVENT_REGISTRY`:

- **`job_posting.created`** (v1)
  - `job_posting_id: uuid`
  - `vacancy_band: enum("1","2-5","6-10","11-25","25+")`
  - `status: enum("draft","open","closed")` *(the created status, per (a) = `draft`)*
  - `created_by: uuid` *(opaque ops-actor id)*
  - `has_location: boolean`, `has_description: boolean` *(presence flags only — never the text)*

- **`job_posting.updated`** (v1)
  - `job_posting_id: uuid`
  - `changed_fields: string[]` *(field **keys** only, e.g. `["role_title","vacancy_band"]` —
    **never** the old/new values)*
  - `vacancy_band: enum(...)` *(the post-update band, if it changed; enum is non-PII)*
  - `status: enum(...)` *(the post-update status)*

- **`job_posting.closed`** (v1)
  - `job_posting_id: uuid`
  - `previous_status: enum("draft","open")`
  - `status: literal("closed")`

None of these carry `org_label`, `role_title`, `location_label`, or `description` values —
only their **keys** (in `changed_fields`) or **presence flags**. This is the
"record the fact, not the value" mirror of `WorkerNameRecordedPayload`.

**(e) Enum additions confirmed.** `"job_posting"` is **absent** from both `EVENT_DOMAINS` and
`SUBJECT_TYPES` today and must be **added** (additive). `actor_type = "ops"` **already exists**
in `ACTOR_TYPES` — no change there. These three facts are the full scope of the enum surface.

## Coexistence with PR #42 (`jobs` / `job.*`) — recorded coexistence flag

This is a **recorded note for human confirmation**, not a re-litigation:

1. **Two distinct additive concerns by design.** `job_postings` (this ADR) is an **ops-typed,
   vacancy-banded, stored-only** internal register — no matching, no ranking, no payer.
   `jobs` (PR #42 / ADR-0009) is the **Reach-Engine-facing**, **opaque-payer-owned**,
   **integer-`vacancy_count`** entity with quota/lifecycle/boost. They serve different actors
   and different stages and are intentionally separate entities.
2. **Naming must stay unambiguous.** Keep the pairs distinct and never alias them:
   `job_posting.*` (events) vs `job.*`; `job_postings` (table/module) vs `jobs`;
   `subject_type "job_posting"` vs `"job"`; `vacancy_band` (enum) vs `vacancy_count` (integer).
   Reviewers should reject any code that blurs these.
3. **No bridge in alpha.** An ops `job_posting` is **NOT** intended to become, feed, or be
   joined to a payer `job` in alpha — **explicitly no**. There is no FK, no projection, no
   sync. If a future phase wants ops postings to seed payer jobs, that is a **new, separately
   decided** mapping (its own ADR), not an assumed path. Recording this now so the separation
   is not later mistaken for accidental duplication/debt.

## Out of scope (explicit)

Matching, ranking, the Reach Engine; payments, unlock, boosts; any **employer entity** (dead
decision); payer self-serve; worker-facing exposure of postings; and **the PR #42 `jobs`
entity** itself. None of these are touched, joined to, or pre-wired by this slice.

## Consequences

- **Positive:** a fully isolated, additive vertical slice (enum entries → table → API module →
  ops route) with zero change to shipped contracts; ships the alpha-gate need cleanly; every
  write is event-first and §2.2-clean (free text never leaves its table). Trivially reversible
  — the whole slice can be dropped without touching any existing feature.
- **Negative / risks:** **two job-shaped concepts coexist** (`job_postings` vs `jobs`) — a
  naming/clarity risk mitigated by the coexistence note above and by reviewer vigilance. The
  PII guardrail (open-item c) is **heuristic** and will not catch a determined operator typing
  PII in disguise — accepted for an internal-only register, revisit if the surface ever faces
  outside users.
- **Reversibility / rollback:** drop the `apps/api/src/job-postings` module + the
  `apps/web` route, remove the two enum entries and three registry entries, and drop the
  `job_postings` table via a standard down-migration. No existing event payload or column is
  mutated, so rollback is clean (CLAUDE.md §2.8 holds — additive only).
- **Version strategy:** all three events ship as **v1**. Any later field change is a **new
  version**, never an in-place mutation (CLAUDE.md §2.8, event-schema-change skill).

## Follow-ups (tracked, NOT in this slice)

- On PR #42 merge, re-confirm the coexistence note (naming, no-bridge) survives the actual
  `jobs` code.
- If alpha feedback wants ops postings to feed payer jobs, open a **new ADR** for that mapping
  (do not retrofit a bridge here).

*This ADR records the approved architecture for the ops-created, vacancy-banded, stored-only
Job Posting flow (2026-06-15). It is the gate; implementation is handed to the engineer agents
only after human sign-off on the coexistence flag.*
