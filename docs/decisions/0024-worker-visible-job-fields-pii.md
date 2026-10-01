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
- **Addendum 2026-09-22 (owner rulings, issues #1648 / #1649 / #1651).** Three
  fields join or are explicitly kept off this SHOW set:
  - **`pay_type` — SHOWN (#1648).** A coarse closed enum, `in_hand | gross |
    ctc`, stating what the band MEANS. "Kitna haath me aayega" is the worker's
    first question and the card previously printed "TAKE HOME PAY" over a band
    no poster had ever labelled. It is **nullable with no default and no
    inference**: NULL means the poster did not state it and the card shows the
    band with no pay-type pill. A guessed answer to that question is worse than
    no answer, and a default would make the platform assert a net-vs-gross claim
    nobody made.
  - **`posted_at` — SHOWN (#1649).** The publish timestamp
    (`job_postings.published_at`, `jobs.created_at`), one key on both feed
    shapes. It is a date, not an identity signal. The Jobs tab said "Aaj N naye
    jobs" while the feed carried no date at all and was ordered oldest-first;
    the legacy feed now orders newest-first to match the V1 feed, which has
    always done so.
  - **`verification_status` — NOT SHOWN, and this is a decision, not a gap
    (#1651).** The column exists and admin writes it, but no posting has been
    through a review designed for worker-facing use. Projecting a `verified`
    boolean would light a "VERIFIED FACTORY" trust claim off a field nobody
    audited for that purpose, so **the alpha makes no trust claim to a worker**
    and the worker app deletes the pill, the "Direct Company Payroll · Zero
    Fees" strip and the model slot. The same ruling covers the "Urgent Hiring"
    pill, which had no source at all: **`boosted_until` must never become that
    source** — a boost is a PAID promotion, and rendering it to a worker as
    urgency sells him a claim the employer bought rather than earned.
    Re-introducing either needs a NEW ruling; the absence is the decision.
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

## Addendum (2026-09-29) — `role_kind` exists on postings and is on NO worker read

The field ruling above **still stands unchanged**. This records a new column and where it may
not go.

Migration `0131` adds `role_kind` to `job_postings` and `jobs`: the role a payer picks for a
posting, one of the 21 declared worker-side kinds (`TRADE_FORM_KINDS_ALL`). Owner ruling
2026-09-29; the matching side of the ruling is the [ADR-0036 addendum](0036-matching-algorithm-v1.md)
of the same date (display / classification only, never a match or rank input).

- **PII classification: none.** A closed enum of 21 occupation slugs, enforced by a DB CHECK, a
  Zod enum at every write boundary and a `z.enum` on the event spine. It carries no employer
  identity, no worker identity and no free text, so it may appear in `job.created` /
  `job_posting.created` (by value) and in `changed_fields` (by key) on the same footing as
  `vacancy_band` and `trade_key`.
- **On NO worker read in this phase.** `GET /feed` (both `FeedItem` and `MatchFeedItem`),
  `GET /jobs/search` and the worker job-detail read do not select it and do not return it. The
  exact-keys pin on `/feed` in `tests/e2e/swipe-to-apply.e2e.test.ts` is unchanged and is the
  guard; `match-feed.repository.test.ts` and `jobs.repository.test.ts` additionally assert the
  column is never selected. It is returned only on payer/ops/admin projections (the owning
  payer's posting and agency-job views, and the admin posting detail).
- **Honest copy.** The payer portal's card preview may draw the role label, but it must not claim
  that workers see it: the worker card has no role line today. Whether it should gain one is
  **#1823**, and adding `role_kind` to any worker projection is that decision — not a mapper edit.
- **No worker-facing trust or urgency signal** follows from it (the #1651 ruling is untouched).

## Addendum (2026-10-01) — company posting cards on the legacy feed (#1823, ADR-0049)

The field ruling above **still stands unchanged**. [ADR-0049](0049-interim-union-feed.md) lets
open, published `job_postings` reach the legacy `GET /feed` while `MATCH_V1_ENABLED` is off,
behind `FEED_POSTINGS_UNION_ENABLED`, through the SAME 17-key `FeedItem`. This records how a
posting fills that item, so the card stays inside the SHOW set.

- **`trade_key` is `""`.** A posting has no trade column, and nothing is derived to fill the
  slot: not an `mskill_*` id (the client hides those, and they would leak match vocabulary), and
  not `role_kind` (below). The shipped app draws no trade line for `""`.
- **`city` is `""` when the posting's city is NULL.** `FeedItem.city` is a string, and the V1
  card does the same. `title` is `role_title`. Every other SHOW field (`area`, the experience
  window, the pay band, `pay_type`, `shift`, `description`, `benefits`, `requirements`,
  `needed_by`) passes through verbatim, with nulls preserved.
- **`posted_at` is `job_postings.published_at`**, the #1649 "one key on both feed shapes" ruling
  above. The arm serves only postings whose publish completed (`published_at IS NOT NULL`), so it
  is never null.
- **No role line (ADR-0049 O6).** The 2026-09-29 addendum left "should the worker card gain one"
  to #1823. For this phase the answer is no: `role_kind` stays on no worker read, and the
  exact-keys pin on `/feed` is unchanged. The posting's role words reach the worker through
  `title`. A role line later needs a new ruling here.
- **HIDDEN still holds.** The arm's projection carries none of `org_label`, `payer_id`,
  `created_by`, `location_label`, `verification_status`, `boosted_until` or `vacancy_band`, and
  `city` / `area` are never back-filled from `location_label`. No verified pill and no urgency
  claim (#1651).
- **Arming precondition: free-text screen parity.** The free-text guard above (the build notes'
  three heuristics) is met on agency `jobs` writes but not on postings. A posting's `role_title`
  is unscreened, and its `description` gets `looksLikePii` only; `benefits` and `requirements`
  already get all three. Search and detail already serve these fields, and the union would put
  them on the deck. `FEED_POSTINGS_UNION_ENABLED` is not armed until posting `role_title` and
  `description` are screened at write with `looksLikePii` + `looksLikeOrgName` + `looksLikeUrl`
  (ADR-0049 O10c) and the existing open postings are reviewed (O10a). That screen is ADR-0049's
  B3, built in its own PR under #1823 (branch `fix/1823-posting-text-screen`); it also moves the
  `benefits` / `requirements` chip arrays onto the same screen. Posting `city` / `area` are
  outside B3 and tracked in #1848.
