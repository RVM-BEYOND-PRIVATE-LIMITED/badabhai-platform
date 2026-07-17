# ADR-0024: Worker-visible job-posting fields — PII boundary (job-detail stays mock-only)

- Status: Accepted — **field ruling RATIFIED 2026-07-16 (see final addendum); the mock-only freeze is LIFTED for the ruled fields**
- Date: 2026-06-27
- Scope: `apps/worker-app` (Flutter) job surface + the future worker-facing job
  contract. No code change in this ADR — it gates one.
- Relates to: [ADR-0012](0012-ops-job-postings-banded-stored-only.md) (banded
  postings), [ADR-0010](0010-contact-unlock-and-reveal.md) (unlock + reveal),
  [ADR-0015](0015-reach-feed-on-real-jobs.md) (PII-free feed). Invariants:
  CLAUDE.md §2 (PII), §4 (LLMs don't decide), §8 (back-compat).

## Context

The worker-app Jobs tab shows a rich swipe deck and a job-detail screen with
**employer / company name, an exact pay band, "spots left", requirement tags,
and shift**. Today these are **MOCK-ONLY display data synthesised client-side**:

- the deck card fields come from `_mockCardData(...)` in
  [`swipe_jobs_screen.dart`](../../apps/worker-app/lib/features/swipe/presentation/swipe_jobs_screen.dart)
  (a presentation mapper, not the API), and
- the detail screen is fabricated by the mock
  [`JobsRepositoryImpl`](../../apps/worker-app/lib/features/swipe/data/jobs_repository_impl.dart).

The **real** worker-facing feed contract — `FeedItem` / `getFeed` — is
deliberately **PII-free**: it carries `trade_key`, `title`, `city`, `area`,
`rank` only (no employer, no pay). CLAUDE.md §2 lists **employer names** as PII.

There is an existing `GET /job-postings/:id`, but it is **ops-scoped** and
exposes the employer name + vacancy band. It must **never** back the worker
surface — doing so would put PII on a worker-authed read path.

So: before any of the rich fields can be served for real, we need an explicit
ruling on *which* job fields a worker may see, and under what boundary.

## Decision

**The job-detail screen and the rich card fields remain MOCK-ONLY** until a
dedicated, worker-scoped job contract is designed with the PII ruling below.
`JobsRepositoryImpl` is left as the client-side mock; no `ApiClient.jobDetail`
method, no `JobDetail` JSON model, and no `MockApiClient` override are added (the
rich fields are not part of the PII-free `FeedItem` contract, so wiring them to
the `ApiClient` seam now would imply a real endpoint that must not exist yet).

### Options considered

1. **PII-free only.** Show just the `FeedItem` fields (trade / title / city /
   area). Safest; no new boundary. But it strips the screen of the signal
   workers care about (who, how much) — low product value.
2. **Unlock-gated precise reveal.** Treat employer name + exact pay as PII;
   reveal them only after a gated, **audited** step, mirroring the payer-side
   Contact Unlock "Stream A" ([ADR-0010](0010-contact-unlock-and-reveal.md)).
   Strong privacy posture; heavier to build; precise identity is the exception,
   not the default view.
3. **Masked employer + banded pay (recommended default).** The worker-visible
   projection shows a **coarse employer descriptor** (e.g. "Auto-components
   manufacturer · Pimpri") and a **pay band** — never the legal entity name and
   never an exact salary. Banded pay aligns with
   [ADR-0012](0012-ops-job-postings-banded-stored-only.md); the masked descriptor
   keeps the employer's identity off the worker read path.

### Recommendation

Adopt **Option 3 as the default worker-visible surface**, with **Option 2
layered** for precise employer/pay reveal *after* an application or an
employer-initiated contact (audited reveal event). Concretely, when this is
built:

- a new **worker-scoped** endpoint (`WorkerAuthGuard` + `ConsentGuard`) returns
  the **masked/banded** projection — distinct from the ops `GET /job-postings/:id`;
- the **exact** employer identity / pay is only ever delivered through an
  **audited reveal** (ADR-0010 shape), never in the feed or the default detail;
- the projection emits a validated event and carries **no raw employer name** in
  events / `ai_jobs` / `audit_logs` / logs (§2); and
- the LLM never sees raw employer PII and never ranks/decides (§4).

## Consequences

- **No code, schema, or event change now.** `jobs_repository_impl.dart` and the
  `_mockCardData` mapper are untouched; the fabricated employer/pay values are
  never sent to a real endpoint, an event, `ai_jobs`, `audit_logs`, or a log.
- The real `FeedItem` / `getFeed` path stays PII-free and unchanged.
- A real worker-facing job-detail endpoint is **deferred and blocked on this
  ADR** — tracked in the tech-debt register (TD53). It must NOT reuse the ops
  `GET /job-postings/:id`.
- When picked up, the work is: design the masked/banded projection + the audited
  reveal, add the worker-scoped endpoint, then wire the Flutter client to the
  `ApiClient` seam (a `MockApiClient` override + a typed model) — at which point
  job-detail leaves mock-only.

## Alternatives rejected

- **Serve the ops `GET /job-postings/:id` to the worker app** — rejected:
  exposes employer name + vacancy band on a worker read path (§2 violation).
- **Ship the rich fields on a real PII-free-by-omission feed** — rejected:
  there is no PII-free way to show the *exact* employer/pay, which is the whole
  point of the rich card; masking/banding (Option 3) is the honest middle.

## Addendum (2026-07-15) — `FeedItem` gained the experience window

The **freeze above still stands unchanged**. This note only keeps the Context
section truthful after an additive, PII-free contract change.

`FeedItem` now carries two more fields — `min_experience_years` and
`max_experience_years` (nullable ints, from `jobs.min_experience_years` /
`jobs.max_experience_years`). So the Context line describing the contract as
"`trade_key`, `title`, `city`, `area`, `rank` **only**" is **no longer literal**;
read it as the PII-free set, which these join.

Why this does **not** touch this ADR's decision:

- Experience is **not** one of the frozen fields. The freeze covers *employer /
  company name, exact pay band, "spots left", requirement tags, and shift* —
  every one of which is still fabricated client-side and still frozen. Nothing
  in `_mockCardData` or `jobs_repository_impl.dart` was touched.
- Year counts are **PII-FREE by the schema's own classification** (`schema.ts`
  jobs: *"PII-FREE: pay bands / year counts / a coarse timing enum — never an
  employer or a worker identity"*), so no §2 boundary moves.
- The change is **additive and backward-compatible** (§8): a response field only.
  The `feed.shown` event payload is untouched and needs no version bump.
- No LLM, no ranking, no decision (§4). The window is passed through honestly —
  nulls preserved, never coerced to `0`.

**Shipped alongside it** (worker-app Jobs tab): real Trade / City / Experience
filters, matched client-side over the loaded page. The dead controls were
removed — the top-row `Verified` and `Day shift` chips (no backing field exists
for either), the inert `Shift` group in the Filters sheet (shift is not on the
wire), and the hardcoded `Pune · 15 km` header (no distance data exists anywhere
in the stack). Area is deliberately **not** a filter dimension: `jobs.area` is
NULL for the entire reach pool, so an area filter would silently drop those jobs;
`jobs.city` is NOT NULL and is the honest location control.

**Still blocked on this ADR's ratification:** pay band and the masked employer
descriptor. Note the ambiguity flagged during that review — this ADR's header
reads *Accepted*, but its **Decision** ratifies only the mock-only freeze, while
the Option-3 field ruling sits under **Recommendation** in recommendation
language, and TD53's un-defer trigger reads *"ADR-0024 **ratified**"*. Whether
Option 3 is binding or merely recommended is **UNKNOWN** and needs an owner call
before any pay/employer field is built.

> The UNKNOWN above is resolved by the final addendum below.

## Final addendum (2026-07-16) — Field ruling RATIFIED (Prakash)

**Ruling** (approved by Prakash; relayed by Divyanshu Pant, 2026-07-16). This
resolves the ambiguity flagged in the 2026-07-15 addendum and lifts the
mock-only freeze for the fields ruled visible below.

- **HIDDEN — never on the worker read path, in any column OR free text:**
  employer identity (company/legal/person name) and ALL contact details
  (phone, email, address, contact links). These remain the paid / audited-reveal
  information (ADR-0010 shape). `payer_id` never appears in any worker-facing
  response.
- **SHOWN — real, worker-visible:** `title`, `city`/`area`, the stored **pay
  band** (`pay_min`–`pay_max`, per ADR-0012 banded storage), the experience
  window, `needed_by`, **plus new fields: `description`, `shift`, `benefits`,
  requirement tags.**
- **Free-text guard (fail closed):** every free-text field (`title`,
  `description`, `benefits`, tags) MUST be validated at the write path against
  embedded employer identity / contact (reuse `looksLikePii` in
  `@badabhai/validators`; reject on match). An employer typing their name or
  phone into the description must be blocked, not stored.
- **Supersedes** the Option-3 "masked employer descriptor" in one respect: NO
  employer descriptor field is added at all — nothing about the employer is
  shown, masked or otherwise. Pay shows as the stored band; nothing more precise
  than the band is stored or shown.
- **Out of scope of this ruling:** "spots left" stays frozen (no backing field);
  the audited precise-reveal layer (Option 2) remains deferred.
- **Consequence:** TD53's un-defer trigger ("ADR-0024 ratified") **fires** — the
  worker-scoped job-detail contract may now be built per this ruling. It must
  still NOT reuse the ops `GET /job-postings/:id`.

### Build notes (recorded with the PR that implements this ruling)

- **Guard implementation — three heuristics, not one.** `looksLikePii` is
  documented as catching ONLY phone/email shapes — not employer names, not
  links. To honor the HIDDEN clause fail-closed, every `jobs` write path
  validates each free-text field (`title`, `description`, each
  `benefits`/`requirements` item) with **`looksLikePii` + `looksLikeOrgName`**
  (legal-entity suffixes — "Pvt Ltd" / "Private Limited" / "LLP" / …) **+
  `looksLikeUrl`** (link shapes — covers the ruling's "contact links"), all in
  `@badabhai/validators`. A match is a clear 400 naming the field, never the
  content; nothing is stored. Heuristics are best-effort by design (documented
  slip cases pinned in tests); authored/seeded content stays employer-free as
  the primary control.
- **Event ruling — the detail read emits NO event.** `GET /jobs/:jobId` is a
  pure read of already-served content: the impression was already evented by
  `feed.shown` when `/feed` served the card, and the state change that may
  follow (apply) emits `application.submitted`. Reusing `feed.shown` for detail
  renders was rejected: its payload requires a positive 1-based **feed
  position** (`rank`), which a detail render does not have — a fake rank would
  corrupt the impression spine, and mutating the shipped payload is barred by
  §2.8. Detail-view analytics, if wanted later, are a NEW versioned event
  (logged in future-improvements), never a repurposed one.
- **Feed contract.** `FeedItem` additively gains `pay_min`, `pay_max`, `shift`
  (nullable, honest nulls — same §8 argument as the 2026-07-15
  experience-window addendum). `feed.shown` unchanged. `JOB_CHANGED_FIELDS`
  (the `job.updated` `changed_fields` key enum) additively gains the four new
  column KEYS — keys only, free text never enters a payload.
- **Why this does not move the §2 boundary.** Employer identity stays off the
  worker path entirely (stricter than Option 3); pay bands / year counts /
  timing enums are PII-free by the schema's own classification; the new free
  text is poster-authored worker-visible content, guarded fail-closed at write;
  nothing here touches LLM input, events, `ai_jobs`, `audit_logs`, or logs. No
  LLM, no ranking, no decision (§4).

### Sign-off

| Who     | Role | Decision                                                                                                      | Date       |
| ------- | ---- | -------------------------------------------------------------------------------------------------------------- | ---------- |
| Prakash | TL   | Approved (ruling relayed + recorded by Divyanshu; explicit confirmation requested at this PR's review — bb-security-review gate condition) | 2026-07-16 |
