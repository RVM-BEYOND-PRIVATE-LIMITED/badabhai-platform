# ADR-0049: Company job postings on the legacy worker feed — an interim union while Matching V1 is off

- **Status:** **Accepted and signed 2026-10-01.** O1–O10 and S1–S3 were decided on 2026-10-01 by Divyanshu
  (Backend Platform), every recommended default taken (§3), and he signed the foot the same day. The build is
  #1823, and it ships dark behind `FEED_POSTINGS_UNION_ENABLED`; arming needs the §6 pre-arm checks.
- **Date:** 2026-10-01
- **Owner:** Divyanshu (Backend Platform). O1–O10 and S1–S3 are his own decisions, not relayed from the product
  owner (Prakash), unlike ADR-0045, ADR-0047 and ADR-0048. This ADR deviates from Prakash's rulings of 2026-07-31
  (ADR-0036 §6/§8, team ruling 3). No approval of that deviation by Prakash is recorded here.
- **Deviates from, as an interim with a named exit (§8):** [ADR-0036](0036-matching-algorithm-v1.md) §6 (the
  legacy `jobs` table retires from the worker path and `job_postings` is the served entity) and §8
  (`MATCH_V1_ENABLED` is the one feed-source env var). Also team ruling 3 of 2026-07-31
  ([team-decisions.md](../registers/team-decisions.md): "`job_postings` becomes THE served job entity").
- **Amends:** [ADR-0024](0024-worker-visible-job-fields-pii.md) (addendum 2026-10-01: posting cards on the legacy
  feed) · closes TD37(b) in the [tech-debt register](../registers/tech-debt-register.md)
- **Relates:** [ADR-0009](0009-alpha-swipe-to-apply-seeded-jobs.md) (swipe-to-apply) ·
  [ADR-0037](0037-payer-lifecycle-and-suspension.md) (the suspension cascade this arm inherits) · #1240 (the
  relevance rule) · #1649 (newest-first) · #1885 (agencies post on `jobs` only) · #1903 · #1904 · #1905 · #1906
- **Flag:** `FEED_POSTINGS_UNION_ENABLED` (default off; a GitHub `production` environment secret; ignored whenever
  `MATCH_V1_ENABLED` is on)

---

## 1. Context

A company posting is written only to `job_postings`. That covers payer-web `/postings/new`, the payer-app company
form and the AI job-posting chat's publish. The worker `GET /feed` reads one of two sources, chosen by
`MATCH_V1_ENABLED`:

- **off (production):** `ApplicationsRepository.findOpenJobs`, which reads only the legacy `jobs` table;
- **on:** `job_reach ⋈ job_postings` (`MatchFeedRepository`).

So a company can fill every card field and publish, and the posting still never reaches a worker. The split between
the two inventories is ruled, not accidental. On 2026-10-01 (#1885) the owner ruled that agencies post agency jobs
only, to `jobs`, and that the company posting surface is employer-only.

**Flipping V1 is not the fix today.** The read-only production probe of 2026-10-01 (11:18Z) found:

- `job_reach` has 0 rows and `worker_skill` has 0 rows, so a V1 feed would be empty for every worker.
- V1 reads only `job_postings`, so it would also hide every agency vacancy. The 3 agency jobs carry 569 impressions
  and 17 applies on the spine. They are the only real payer demand served so far.
- There are 13 company postings and 0 are verified. Of the 8 open ones, 6 fill at most 1 of the 12 card fields.
- `source_job_id` is NULL on every posting (no D4 conversion has run). `role_kind` is NULL on every row of both
  tables. No posting is boosted.
- `feed.shown` rows keyed on `jobs` ids are 93% of the spine.

**The lineage ruling behind #1823 (owner, 2026-09-29).** The web redesign makes the posting form the traceable source
of every job-card field. It verifies that lineage on the web side only: form → API → DB → payer-web card preview. The
worker-feed gap was split off into #1823 instead of being claimed by the redesign. #1823's acceptance: a company
posting published through payer-web with every card field filled appears on a worker's Jobs tab, and every field
matches what the payer entered.

## 2. Decision

**Keep `MATCH_V1_ENABLED` off and give the legacy `GET /feed` a second read arm.** The arm serves open, published
company postings through the unchanged 17-key `FeedItem` contract and the unchanged `feed.shown` v1 event. It is
merged newest-first with the unchanged `jobs` arm, behind a new dark flag:

```ts
export function isFeedPostingsUnionEnabled(c: ServerConfig): boolean {
  return !c.MATCH_V1_ENABLED && c.FEED_POSTINGS_UNION_ENABLED;
}
```

When that is false, `getFeed`, apply and skip run today's code byte for byte. The change adds no migration, no
event and no response key.

### 2.1 Two arms

| Arm      | Reads                                                                                                                              | Change |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Jobs     | `findOpenJobs`: `status = 'open'`, an applied-only anti-join, exact `trade_key` / `city`, `created_at DESC, id ASC`, `LIMIT limit` | None   |
| Postings | New `findOpenPostingsForFeed(workerId, limit, { city?, wantedSkillIds })`, with an explicit projection                             | New    |

**The postings arm's predicates.** Each is a separate predicate:

1. **`status = 'open'`.** Draft, paused, closed and suspended rows drop out. The ADR-0037 suspension cascade is a
   status move, so no `payers` join is needed.
2. **`published_at IS NOT NULL`.** A NULL means the publish never completed: a zero-skill publish throws before the
   stamp, and the posting service swallows the error. Such a row has no honest `posted_at`, and V1 never serves it
   either.
3. **Two applied-only anti-joins.** (a) The worker applied to this posting (`applications.job_posting_id`). (b) The
   worker applied to its D4 source job (`applications.job_id = source_job_id`); with a NULL `source_job_id` this can
   never match. Skipped postings are re-served (O4).
4. **The twin guard:** no open `jobs` row with `id = source_job_id`. While a D4 source is still open, the jobs arm
   serves the vacancy and its converted posting is hidden. With (3b), a later D4 run keeps both the vacancy's place
   in the deck (`published_at = jobs.created_at`) and the worker's applied state.
5. **Relevance (O2, the #1240 rule):** `reach_skill_ids ?| <wanted skill ids>`, applied only when the worker has
   wanted skills (`WorkerSkillsRepository.listWantedSkillIds`). The ids are bound as ONE `text[]` parameter
   (`sql.param`); a bare array fails at runtime with 42846. This equals "would have a `job_reach` row" without
   depending on reach materialization having run, and it reads only match inputs, never `role_kind`.
6. **City, only when the worker supplied one:** `city IS NULL OR lower(city) = lower($city)`. That is V1's
   NULL-tolerant rule. The jobs arm keeps its exact match on a NOT NULL column.

The arm orders by `published_at DESC, id ASC` and applies `LIMIT limit`.

**Not applied to postings:**

- the server `trade_key` filter (O7);
- `shift` and `pay_min`. The jobs arm already drops them silently; #1905 applies them to both arms.

**Never projected:** `org_label`, `payer_id`, `created_by`, `location_label`, `verification_status`, `role_kind`,
`boosted_until`, `state`, `vacancy_band` and the skill arrays. `source_job_id` appears in the WHERE clause only.

**Execution.** Both arms run in parallel. If either read or the wanted-skills lookup rejects, the whole `/feed`
fails and no event is emitted (fail closed).

### 2.2 The card

| `FeedItem` key | From a posting                                                                        |
| -------------- | ------------------------------------------------------------------------------------- |
| `job_id`       | `job_postings.id`. It is opaque; the client posts it back unchanged                   |
| `trade_key`    | `""`. A posting has no trade column, and the shipped app draws no trade line for `""` |
| `title`        | `role_title`                                                                          |
| `city`         | `city`, or `""` when NULL. `FeedItem.city` is a string, and the V1 card does the same |
| `posted_at`    | `published_at` as ISO. Never null on this arm, because of predicate 2                 |
| `rank`         | The 1-based position after the merge                                                  |

Every other key comes from the same-named column, verbatim, with nulls preserved: `area`,
`min_experience_years`, `max_experience_years`, `pay_min`, `pay_max`, `pay_type`, `shift`, `description`,
`benefits`, `requirements` and `needed_by`. Every payer-web card field except `role_kind` reaches the worker card
(O6).

### 2.3 Ordering

- **One key across both shapes:** `posted_at`, which is `jobs.created_at` for a job and `job_postings.published_at`
  for a posting. This is ADR-0024's #1649 ruling.
- **Total order:** `posted_at DESC`, then `id ASC`, then a `jobs` card before a posting.
- **Merge:** a pure, stable two-pointer merge of the two arms, which SQL has already sorted, truncated to `limit`. It
  gives exactly the top `limit` of the union.
- **Page:** one page of up to 50 cards shared by both sources, with no cursor (#1905 tracks pagination).
- **Not applied (O5):** boost, the per-company interleave and any score.

Pause and resume never restamp `published_at`, so cycling a posting cannot lift it up the deck.

### 2.4 Apply and skip: one route, and the server resolves the id

`POST /applications/:jobId/{apply|skip}` is unchanged: ParseUUIDPipe, both bodies, HTTP 200 and
`{ok, application_id, action}`. No type tag is added. A prefix would break the pipe and the shipped client, which
posts the card's `job_id` straight back, including from search → detail → apply.

The server resolves the id in this order:

1. An open `jobs` row (`findJobById`, unchanged) → `job`.
2. Only while the union is armed: an open `job_postings` row, read with an id-only projection → `job_posting`.
3. Otherwise `NotFoundException("Job not found")`, identical to today. Unknown, closed, paused, suspended and draft
   ids all look alike, with no write and no event.

Jobs-first is the `GET /jobs/:jobId` precedent. Both keys are random v4 uuids; on a theoretical collision, `job` wins
deterministically. The gate is "open posting", not "published" and not "has a reach row". Search and detail already
show any open posting, and a stricter apply gate would keep their 404 dead end.

|                   | `job`                                                    | `job_posting`                                                                                                     |
| ----------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Code path         | Today's legacy body                                      | The V1 posting-decision path, extracted so that V1 and the union share one implementation                         |
| Row               | `applications.job_id`, conflict on `(worker_id, job_id)` | `applications.job_posting_id` with `job_id` NULL, conflict on `(worker_id, job_posting_id)`, with the E16 freeze  |
| Rank snapshot     | None                                                     | Captured when a reach row exists, NULL otherwise (S3)                                                             |
| Counter           | `jobs.applicants_received`                               | None; `job_postings` has no counter                                                                               |
| Applied → skipped | Refused (TD73)                                           | Refused (TD73)                                                                                                    |
| Event subject     | `job`                                                    | `job_posting`                                                                                                     |
| Idempotency key   | `application.submitted:{worker}:{jobs.id}`               | `application.submitted:{worker}:{posting id}`, byte-identical to V1, so a union apply and a later V1 apply dedupe |

History is never repointed.

### 2.5 Read surfaces

- **Worker Applied tab:** it already joins both foreign keys. Unchanged.
- **Ops `GET /jobs/:jobId/applicants`:** reads `job_id = $1 OR job_posting_id = $1`. Not gated by the flag.
- **Payer `/payer/reach/jobs/:jobId/applicants` (O8).** Not gated by the flag. In order:
  - with V1 on, today's branch, unchanged;
  - an owned `jobs` id → the unchanged weighted pool;
  - an owned posting → its actual applicants, through the V1 candidate list. That list already sorts NULL
    snapshots last, and payer-web already parses its shape;
  - anything else → the identical 404.
- **Unlock (O9, #1903):** `unlocks.job_id` is a foreign key to `jobs.id`. A posting id is stored as a NULL job
  context, so the grant no longer fails.

## 3. Owner decisions (2026-10-01, decided by Divyanshu, Backend Platform)

Each question came with a recommended default, and every default was taken.

| #       | Question                                                                                                                                                     | Decided                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **O1**  | Do agency vacancies (`jobs`) and company postings (`job_postings`) mix in one Jobs deck while V1 is off?                                                     | **Yes, as a documented interim,** with the exit in §8.                                                                                                                                                                                                                                                                                                                                                                          |
| **O2**  | Which company postings does a worker see?                                                                                                                    | **The #1240 rule.** Postings whose `reach_skill_ids` overlap his wanted skills, or every published open posting when he has none. Agency and seed jobs stay liberal until the jobs arm retires; that asymmetry is accepted.                                                                                                                                                                                                     |
| **O3**  | Unverified postings. P9's invariant, "an unverified posting is never visible to any worker" (`docs/agent/phases/P9_BUILD.md`), is unbuilt and false at head. | **Shown, and the P9 deferral is recorded here.** Search, detail and the companion already serve unverified postings, and 0 of 13 production postings are verified, so a verified-only arm would show nothing. This arm is in P9's scope when P9 lands. If P9 places the gate on status, the arm inherits it with no edit.                                                                                                       |
| **O4**  | Skipped company postings                                                                                                                                     | **Re-served,** as the TD73 ruling of 2026-07-21 already does for agency and seed cards in the same deck. V1's skip exclusion becomes the rule at the V1 flip.                                                                                                                                                                                                                                                                   |
| **O5**  | Ordering across both sources                                                                                                                                 | **Pure newest-first** on `posted_at`, with an `id ASC` tiebreak. No boost and no per-company interleave on this path. One shared page of up to 50 cards.                                                                                                                                                                                                                                                                        |
| **O6**  | Does the worker card gain a role line from `role_kind`?                                                                                                      | **No, not this phase.** The posting's role words reach the worker through `title`. A role line later needs a new ADR-0024 ruling; its cheapest form uses the existing `trade_key` slot, with no new key.                                                                                                                                                                                                                        |
| **O7**  | The worker trade filter vs company postings                                                                                                                  | **The server `trade_key` filter narrows agency and seed jobs only.** Postings are narrowed only by the client's title-keyword filter. `role_kind` is never a filter input.                                                                                                                                                                                                                                                      |
| **O8**  | What a company sees on its posting's applicants page while V1 is off                                                                                         | **The posting's actual applicants,** newest first while snapshots are NULL. **Not gated by the union flag,** so disarming never hides people who already applied. Agency jobs keep the weighted full-pool list.                                                                                                                                                                                                                 |
| **O9**  | The unlock job context when a company unlocks from a posting                                                                                                 | **Store `job_id` NULL** when the id is not a `jobs` row. No migration (#1903).                                                                                                                                                                                                                                                                                                                                                  |
| **O10** | Inventory hygiene before arming                                                                                                                              | **(a)** Close or complete the thin open postings: seed `5eeded00…`, employer `8eb13cb2…`, `a512c822…`, `97fa0f89…`, `ade45d03…`, and agent `865e9870…`. **(b)** Close the agent-owned `865e9870…` under #1885. **(c)** Land the posting free-text screen at parity (B3, §5) **before arming.** **(d)** Accept that open postings with a NULL `published_at` stay off the deck while remaining appliable from search and detail. |
| **S1**  | A second feed-source env var beside `MATCH_V1_ENABLED`, which ADR-0036 §8 and `packages/config/src/server.ts` call the only one                              | **Accepted.** It tunes nothing in V1, it is ignored when V1 is on, and it is deleted with the legacy path.                                                                                                                                                                                                                                                                                                                      |
| **S2**  | The envelope `subject_type` as the id-space discriminator for worker-actor `feed.shown` and `application.*`                                                  | **Accepted. It closes TD37(b)** (§4).                                                                                                                                                                                                                                                                                                                                                                                           |
| **S3**  | A rank snapshot on a union posting apply                                                                                                                     | **Captured only when a reach row exists** (ADR-0036 §5), NULL otherwise.                                                                                                                                                                                                                                                                                                                                                        |

## 4. Telling `feed.shown` impressions apart

Every card from either arm emits **`feed.shown` v1 with its payload unchanged**: `{worker_id, job_id, rank, score: 0,
hot: false}`, unkeyed, in one batch per fetch. On a company card, `payload.job_id` carries the posting id and the
envelope subject says so. `job_posting` is already a registered subject type.

| `actor_type`       | `subject_type` | `payload.job_id` is | Emitted by                        |
| ------------------ | -------------- | ------------------- | --------------------------------- |
| `worker`           | `job`          | a `jobs.id`         | the legacy feed's jobs arm        |
| `worker`           | `job_posting`  | a `job_postings.id` | **the union's posting arm (new)** |
| `payer` / `system` | `worker`       | a `jobs.id`         | the payer and ops reach views     |

The same rule holds for `application.submitted` and `application.skipped` v1, as V1 already ships them. **Any query
that joins `payload.job_id` to a table must branch on `subject_type`.** The in-repo consumers were checked:

- the admin funnel counts `feed.shown` by name, so company impressions are counted, which is wanted;
- reach-learn pairs on payload ids and skips ids that are not in its jobs snapshot;
- LEARN reads `feed.shown_v2` only;
- `verify-demand` counts by name.

**Why not `feed.shown_v2`:** it is `.strict()` and requires `match_tier` and `matched_skill_id`, which exist only with
a reach row. **Why not a new `feed.shown_v3`:** emitting it for postings only would drop company impressions from the
funnel, and emitting it for both arms would break v1 continuity for 93% of impressions.

## 5. Privacy

- **Employer identity never reaches the worker path** (ADR-0024 HIDDEN). The posting arm and the apply/skip lookup use
  explicit projections with none of `org_label`, `payer_id`, `created_by`, `location_label`, `verification_status`,
  `boosted_until`, `role_kind`, `vacancy_band`, the skill arrays or `source_job_id`. `city` and `area` are never
  back-filled from `location_label`. The merge's source tag selects the envelope and never reaches the response.
  Structural tests pin each absence.
- **No trust or urgency claim:** no verified pill, and `boosted_until` is unused (#1651).
- **Events** carry ids, ranks and enums only. **No LLM** is on any path here: visibility and order are deterministic
  SQL and TypeScript, so `AI_RAW_PII_ENABLED` ([ADR-0047](0047-lift-pii-restriction.md)) does not apply.
- **Consent and DPDP are unchanged.** Feed, apply and skip stay behind `ConsentGuard`, and `applications` cascades on
  worker delete through both foreign keys.
- **The gap this widens, closed before arming (O10c).** **B3** is its fix: posting free-text screen parity,
  built in its own PR under #1823 (branch `fix/1823-posting-text-screen`). It covers `role_title`, `description`
  and the `benefits` / `requirements` chip arrays. Posting `city` / `area` are not in B3; they are #1848 (§6
  pre-arm). ADR-0024's free-text guard requires every worker-visible free-text field to be screened at write
  with `looksLikePii`, `looksLikeOrgName` and `looksLikeUrl`.
  - Agency `jobs.title` and `description` get all three.
  - A posting's `role_title` is unscreened, and its `description` gets `looksLikePii` only. Its `benefits` and
    `requirements` already get all three.
  - Search and detail already expose this gap; the union would put it on the deck.
  - The fix is write-side parity, not a read-time filter, so feed, search and detail stay consistent. Existing open
    rows are reviewed under O10a.

## 6. Flag, rollout and rollback

**The flag.** `FEED_POSTINGS_UNION_ENABLED: booleanFromString` in `packages/config/src/server.ts`, beside
`MATCH_V1_ENABLED`, read only through `isFeedPostingsUnionEnabled`. It is a legacy-path supply bridge, not a Matching
V1 knob.

- **It gates:** the posting arm in `getFeed`, and the posting branch of the apply/skip resolution.
- **It does not gate,** so that a rollback never hides data: the payer posting-applicants list, the ops applicants
  read and the unlock context fix.

**Plumbing.**

- The `production` environment secret, set with `--env production` (a repository secret of the same name is
  shadowed).
- The deploy job's `env:` entry and appleboy `envs:` allowlist in `.github/workflows/ci.yml`.
- `FEED_POSTINGS_UNION_ENABLED: ${FEED_POSTINGS_UNION_ENABLED:-false}` in `docker-compose.staging.yml`, and
  `.env.example`.
- A boolean preflight in `scripts/deploy/staging-deploy.sh`, as for `AI_RAW_PII_ENABLED`. `booleanFromString` throws
  at boot on anything other than `true`, `false`, `1`, `0` or empty, and the api has no automatic rollback, so a
  mistyped secret must fail the deploy, not the api.

**Rollout.**

1. **Signature: done 2026-10-01** (Divyanshu, Backend Platform). The flag-gated apply/skip resolution and feed arm
   no longer wait on it.
2. **Merge in order, each one dark:** unlock fix → flag plumbing → apply/skip resolution → feed arm → payer posting
   applicants. Before arming, the only visible change is that payer-web `/postings/:id/applicants` shows the
   posting's applicants (usually none yet) instead of a neutral not-found; the payer-app Find tab receives the
   same response (#1913).
3. **Pre-arm (owner and ops),** each item detailed in the
   [production-release-runbook](../ops/production-release-runbook.md) (P4 #13):
   - the read-only probe and the O10 hygiene;
   - B3 (§5) merged and deployed;
   - the live api image at or after the last #1823 change (the payer posting applicants), with the unlock fix
     (#1903) merged and deployed. The canary's applicants-and-unlock step needs both;
   - the feed-union e2e legs for the payer applicants list and the unlock grant pass. They are deferred in
     `tests/e2e/feed-postings-union.e2e.test.ts` until those two changes land, and are appended with them;
   - posting `city` / `area` server-side screening (#1848, pre-existing, outside B3): decided, before arming, as a
     precondition or not. Recommended: a precondition, with security-engineer's ruling on the pincode
     false-positive trade-off;
   - payer-app parses the posting-applicant row (#1913). It is a second consumer of
     `/payer/reach/jobs/:jobId/applicants`: once the payer posting-applicants change merges, an owned company
     posting returns the V1 candidate shape (camelCase) instead of a 404, armed or not;
   - security-engineer decides to arm. Arming widens the ADR-0024-protected surface: posting free text and
     unverified postings reach the worker deck.
4. **Arm:** `gh secret set FEED_POSTINGS_UNION_ENABLED --env production --body true`, then re-run the deploy. A secret
   alone reaches nothing until a deploy.
5. **Canary,** per the runbook. Confirm the flag is live from the spine (`feed.shown` rows with
   `subject_type = 'job_posting'`), never from the last local `gh secret set`.

**Rollback:** set the secret to `false` and re-run the deploy (minutes, not seconds), or revert the change. **The
rollback is asymmetric by design:**

- postings leave the deck, and apply and skip on a posting return 404 again, so a worker cannot re-apply to or
  re-skip a posting he acted on while armed;
- the posting applications written while armed remain on the worker's Applied tab, on the company's applicants page
  and on the ops read, because none of those reads is gated.

**At the V1 flip** the flag goes inert with no data step. Posting decisions already sit on `job_posting_id`, which the
V1 anti-join and the V1 candidate list read.

## 7. Consequences

1. **No migration, no new event or event version, and no new response key.** Every new read uses an explicit
   projection, so a future column cannot 500 it.
2. **The 17-key `FeedItem` contract and its e2e exact-keys pin are untouched.** Shipped and older app builds need no
   release.
3. **Flag off is byte-identical.** With `MATCH_V1_ENABLED` on, nothing changes, because every V1 branch returns first.
4. **Two asymmetries hold until the jobs arm retires, and both are accepted.** Agency and seed jobs are liberal while
   postings are skill-gated (O2). An agency sees the weighted pool while a company sees its actual applicants (O8).
5. **Union posting applies mostly carry NULL snapshots** while production reach is 0. They sort last on the post-flip
   candidate list, and their history cannot be replayed (S3, accepted).
6. **A D4 run while armed** moves every open `jobs` row it converts (agency vacancies included, today) from the
   liberal jobs arm to the skill-gated posting arm for profiled workers. For seed rows O2 intends this. An agency
   row would become an agent-owned posting, which #1885 forbids, so D4 does not run against live agency inventory
   until §8 step 1 decides the agency path (#1904).
7. **TD37(b) is closed** (decided by S2, closed by the signature of 2026-10-01). A new tech-debt row, TD152, assigns
   the deletion of this arm, the posting branch of the resolution and the flag.
8. **Follow-ups that do not block this:** #1905 (`trade_key` validation, `shift` and `pay_min` on both arms,
   pagination) and #1906 (worker app: the chip label sent as `trade_key`, the place string, the search
   `source_surface`).

## 8. Exit condition

This arm is an interim. It ends, and its code and flag are deleted, in this order:

1. The owner chooses a V1 path for agency inventory: a `job_postings` twin mirror, agency postings on `job_postings`,
   or collapsing the two tables (#1904).
2. D4 converts the remaining open `jobs` rows. Today it converts every one, agency vacancies included, so how an
   agency row crosses is step 1's decision, and D4 does not run against live agency inventory before it.
3. The other V1 flip prerequisites close (#1904): a posting-status gate on the V1 snapshot read, the admin funnel
   counting `feed.shown ∪ feed.shown_v2`, the `MATCH_V1_ENABLED` secret bridge with the V1 e2e in CI, and the D5
   recompute fix.
4. `MATCH_V1_ENABLED` flips, and this flag goes inert.
5. The ADR-0036 retirement change deletes the union arm, the posting branch of the apply/skip resolution and
   `FEED_POSTINGS_UNION_ENABLED` (TD152).

**Owner:** Backend Platform (Divyanshu) drives it, tracked in #1904; the step-1 choice is the product owner's.
#1823 also mentions a "search/visibility direction", which
has no written definition anywhere in the repo. If the owner defines it later, this union is the interim it replaces.

## 9. Alternatives considered

| Alternative                                                               | Why it lost                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Run D4 and flip V1 now                                                    | The deck would be empty (`job_reach` = 0, `worker_skill` = 0), and agency jobs would be hidden (#1885 keeps them on `jobs`). It repeats the 2026-09-18 incident, where an early D4 drained the deck. And after D4, turning the flag off does not restore the old deck.                                     |
| Mirror agency jobs as `job_postings` twins, then flip V1                  | It does not answer "while V1 is off". It needs an ungated dual write across the agency service with no kill switch, creates agent-owned postings against #1885, and promotes `TRADE_TO_MATCH_SKILL` to a runtime classifier against its own documentation. It remains the leading candidate for §8 step 1. |
| Mirror each posting into a `jobs` row                                     | `jobs.trade_key` and `jobs.city` are NOT NULL, so a mirror would invent a trade line the payer never entered. It dual-writes across every posting path and entrenches `jobs`, the opposite of ADR-0036 §6.                                                                                                 |
| A liberal posting arm: every posting to every worker                      | It ignores #1240, the owner's rule for this same inventory, and breaks "never show irrelevant jobs" (CLAUDE.md §2). It was O2's alternative A.                                                                                                                                                             |
| A reach-row (`job_reach`) gate                                            | Production reach is 0, so the arm would be empty and acceptance would fail. It was O2's alternative B.                                                                                                                                                                                                     |
| `feed.shown_v2` for company cards, or a new `feed.shown_v3`               | See §4.                                                                                                                                                                                                                                                                                                    |
| A type-prefixed id on apply and skip                                      | It breaks ParseUUIDPipe and every shipped client.                                                                                                                                                                                                                                                          |
| `role_kind` as the posting's `trade_key` and filter key                   | The ADR-0036 addendum bars it as a visibility input, the ADR-0024 addendum keeps it off every worker read without a ruling, and it is NULL on every production row.                                                                                                                                        |
| Ship live on merge, with a revert as the only rollback (S1's alternative) | Code auto-deploys on merge, and O3 and O10 must come before arming.                                                                                                                                                                                                                                        |

---

```
Owner decisions O1–O10 and S1–S3 taken 2026-10-01 by Divyanshu (Backend Platform), his own decisions; every
recommended default was accepted. Arming needs the §6 pre-arm checks. This deviates from product-owner rulings
(ADR-0036 §6/§8, team ruling 3).
Signed: Divyanshu (Backend Platform; his own decisions)          Date: 2026-10-01
```
