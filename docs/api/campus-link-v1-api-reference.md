# Campus link v1 — API reference (BadaBhai side)

BadaBhai Campus (RVM-BEYOND-PRIVATE-LIMITED/RVMBeyond_jobportal) calls these routes to list jobs
marked for RVM students, record the placement team's review, post for a company, pass a student's
application to BadaBhai and keep its status in step. Issue #2752; the Campus side is
RVMBeyond_jobportal#155 and #154.

- **Source of truth:** `apps/api/src/campus-link/campus-link.contract.ts` (zod). Every example in
  `campus-link.examples.ts` is parsed against its schema in CI.
- **Mock:** `pnpm --filter @badabhai/api build && pnpm --filter @badabhai/api campus:mock -- --port=4100 --token=<test token>`.
  Same paths, headers, schemas and errors; examples plus in-memory state; no database.
- **Status:** `GET ping` and `DELETE students/:student_ref` are live behind the flag. The other
  routes are the contract Campus builds against; each lands as the rest of #2752 (and #2746 for
  postings and review) is built. The drive-request routes (#2746) are built. Companies can make new
  requests only where `CAMPUS_DRIVE_REQUESTS_ROLLOUT` is `pilot` (for them) or `on`; the two
  Campus routes answer for every existing request whatever the switch says.

## Rules for every call

| Rule                            | Detail                                                                                                                                                                                                   |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Base path                       | `/internal/campus/v1`                                                                                                                                                                                    |
| Token                           | `X-Service-Token: <token>`. BadaBhai stores only its sha256 and accepts two tokens while one is rotated. Never `Authorization: Bearer`.                                                                  |
| Address                         | The caller's address must be on BadaBhai's allow-list. Campus calls BadaBhai over the internet (separate hosts), so this is the Campus server's **public** egress address.                               |
| Writes                          | Every `POST`, `PUT` and `DELETE` carries `Idempotency-Key`: 8–200 characters of `A-Z a-z 0-9 . _ : -`. Missing or malformed → 400 `IDEMPOTENCY_KEY_REQUIRED`.                                            |
| Lasting idempotency             | Redis remembers a key for minutes, except on the two PUTs in the next row. The guards that last are `external_ref` on applications and `grant_ref` on grants: the same ref again answers its row.        |
| Review and targeting writes     | `PUT job-postings/:id/review` and `PUT targeting-options` check the key but do not store it. Retrying the SAME body (same `decided_at` / `as_of`) is safe: it answers what is held and changes nothing.  |
| Decision time                   | `decided_at` / `as_of` are Campus's clock; the newest wins (older or same-time-different: 409 `DECISION_SUPERSEDED`). A review gone pending refuses one 10+ min older: 409 `POSTING_CHANGED`.            |
| Clock skew                      | From 2026-01-01, offset within ±14:00, at most 60 s ahead of BadaBhai's clock, else 400 `VALIDATION_FAILED`. Keep the Campus server NTP-synced: the review's floor tolerates 10 min behind.              |
| Body size                       | 100 kB of JSON at most (Express's default). The largest valid `PUT targeting-options` body is about 90 kB; anything larger is refused before validation.                                                 |
| Call id                         | Every authenticated answer carries `X-Campus-Call-Id`, the id of BadaBhai's audit row for that call. Log it to correlate.                                                                                |
| Flag                            | With `CAMPUS_LINK_ENABLED` off every route answers a neutral 404.                                                                                                                                        |
| Direction                       | Campus calls BadaBhai for everything here, status included (the `GET applications` feed). BadaBhai pushes nothing on these routes.                                                                       |
| Requests strict, responses open | An unknown key in a request is a 400. A response may gain fields without a version bump; ignore keys you do not know. Removing or retyping a field is a v2.                                              |
| Phones                          | 10 digits starting 6–9. BadaBhai normalises to +91 E.164 before hashing, so one person stays one row.                                                                                                    |
| Student reference               | The hand-off token's `sub`: the Student API account uuid, text up to 128 characters.                                                                                                                     |
| Branches and courses            | `branch_ids` are RVM location ids (Campus's `allowed_location_ids`). Courses travel as `{id, name}`: Scheduler course ids, names for display and for matching until the Student API returns a course id. |

## Errors

Every error uses the api's envelope: `{ statusCode, error: { code, message? }, requestId, path, timestamp }`.

| Status | `error.code`               | When                                                                            | Retry?             |
| ------ | -------------------------- | ------------------------------------------------------------------------------- | ------------------ |
| 400    | `VALIDATION_FAILED`        | Body or query fails the schema (including an unknown key)                       | No                 |
| 400    | `IDEMPOTENCY_KEY_REQUIRED` | A write without a valid key                                                     | No                 |
| 401    | `UNAUTHENTICATED`          | Missing or wrong token, or none configured                                      | No                 |
| 403    | `ADDRESS_NOT_ALLOWED`      | Caller address is not on the allow-list                                         | No                 |
| 404    | none                       | Flag off, unknown route, or an id that does not exist                           | No                 |
| 409    | `EXTERNAL_REF_CONFLICT`    | The same `external_ref` with a different posting or student                     | No                 |
| 409    | `POSTING_NOT_OPEN`         | Posting closed, paused or hidden, including one that closed at the same moment  | No                 |
| 409    | `POSTING_NOT_APPROVED`     | Posting's RVM review is pending or rejected                                     | No                 |
| 409    | `AUDIENCE_EXCLUDES_RVM`    | Posting is for BadaBhai workers only                                            | No                 |
| 409    | `STUDENT_NOT_AVAILABLE`    | RVM refuses the student (no consent, not linked, any reason); no row is created | No                 |
| 409    | `POSTING_CHANGED`          | Changed (or its review reset) since the reviewer saw it; re-fetch, re-review    | No, not same body  |
| 409    | `DECISION_SUPERSEDED`      | A newer decision or list is held, or a differing one at the same time           | No                 |
| 409    | `DECISION_NOT_ALLOWED`     | The drive request's `status` (in the body) allows no such decision              | No                 |
| 409    | `COMPANY_WITHDRAWN`        | The request's company is no longer verified, or is suspended or archived        | Once reinstated    |
| 429    | `RATE_LIMITED`             | Over the per-minute cap                                                         | Yes, after a pause |
| 503    | `RVM_UNAVAILABLE`          | RVM's Student API did not answer; nothing was created                           | Yes, same key      |

## Routes

| Method and path                     | Purpose                                                 | Lands with    |
| ----------------------------------- | ------------------------------------------------------- | ------------- |
| `GET ping`                          | Proves flag, address and token                          | **live**      |
| `GET job-postings`                  | Postings whose audience includes RVM students           | #2752 + #2746 |
| `PUT job-postings/:id/review`       | Placement team approves or rejects                      | #2746         |
| `PUT targeting-options`             | Branches and courses a company may target               | #2746         |
| `POST job-postings`                 | Placement team posts for a company                      | #2752 + #2746 |
| `GET companies?phone=`              | Find a company by exact phone                           | #2752         |
| `POST applications`                 | A student applies                                       | #2752 + #2746 |
| `GET applications`                  | Status feed Campus polls                                | #2752         |
| `DELETE applications/:external_ref` | Student withdraws                                       | #2752         |
| `PUT search-grants/:grant_ref`      | Named-company search grant, after the student's own yes | #2752         |
| `DELETE search-grants/:grant_ref`   | Revoke a grant                                          | #2752         |
| `DELETE students/:student_ref`      | Unlink a student (consent withdrawn or deleted)         | **live**      |
| `GET drive-requests`                | Companies' campus-drive requests, with contacts         | #2746         |
| `POST drive-requests/:id/decision`  | Schedule, decline or complete a drive request           | #2746         |

Mounted behind the same guard by its own issue: credit waivers (#2750).

### GET ping

`200 { "ok": true, "call_id": "<uuid>" }`. Use it to prove a new token or address before anything else.

### GET job-postings

Query: `review_state` (`pending`|`approved`|`rejected`), `branch_id`, `course_id`, `changed_since`
(ISO 8601 with offset), `cursor`, `limit` (1–200, default 100). With `changed_since`, postings that
closed since are included with `status: "closed"`, so Campus learns about a close.

**Building `changed_since`.** Take it from the `changed_at` of the last feed page you read, minus a
margin (a minute is plenty), and drop the postings you have already seen by `id` and `changed_at`.
Never from a review PUT's `reviewed_at` (that is your own `decided_at`, Campus's clock) and never
from Campus's own clock. `changed_at` is the later of the posting's and its review's change times:
the posting's is stamped by the api host's clock, the review's by the database's
(`clock_timestamp()`), and a change can commit after a later stamp is already visible. Re-reading
a margin is what keeps a slow commit from being skipped.

```json
{
  "postings": [
    {
      "id": "b2c4e6f8-1a3b-4c5d-8e7f-90a1b2c3d4e5",
      "company": { "id": "7d3f2a10-5b8e-4c1d-9a6f-0e2b4c6d8f10", "name": "Sharma Precision Works" },
      "title": "CNC Operator",
      "description": "Run a 3-axis CNC lathe on day shift. Fanuc control preferred.",
      "location": {
        "label": "Sector 24 industrial area",
        "city": "Faridabad",
        "state": "Haryana",
        "area": null
      },
      "pay": { "min": 16000, "max": 22000, "type": "in_hand" },
      "vacancy_band": "2-5",
      "shift": "day",
      "experience_years": { "min": 0, "max": 2 },
      "requirements": ["ITI or diploma"],
      "benefits": ["PF", "ESI"],
      "status": "open",
      "audience": "both",
      "branch_ids": [1],
      "courses": [{ "id": "cnc-programming", "name": "CNC Programming" }],
      "review_state": "approved",
      "changed_at": "2026-11-13T09:30:00.000+05:30",
      "content_hash": "dae961f775f42c5205c320f1bc9eed1046f92b7856b4f97b1e3a1eed94300fc9"
    }
  ],
  "next_cursor": null
}
```

Empty `branch_ids` or `courses` means every branch or course. `status: "open"` takes applications
only once `review_state` is `approved`. `content_hash` identifies the content shown above (every
field a student sees): keep it with what the reviewer is shown and send it back on the review. It
is opaque; BadaBhai computes it, and it changes whenever that content changes.

### PUT job-postings/:id/review

```json
{
  "state": "approved",
  "reviewer_ref": "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d",
  "branch_ids": [1],
  "content_hash": "dae961f775f42c5205c320f1bc9eed1046f92b7856b4f97b1e3a1eed94300fc9",
  "decided_at": "2026-11-13T10:00:00.000+05:30"
}
```

Two fields are **required** besides `state` and `reviewer_ref`:

- `content_hash`: the posting's `content_hash` from the `GET job-postings` read the reviewer
  decided on. BadaBhai compares it with the posting's hash under a row lock; if the posting changed
  since, the answer is `409 POSTING_CHANGED` and nothing is stored (no decision, no event). Fetch
  the posting again, show the reviewer the new content, and send the decision with the new hash.
- `decided_at`: when the reviewer decided, by Campus's clock (ISO 8601 with an offset within
  ±14:00, from 2026-01-01T00:00:00Z on). BadaBhai stores it as the review time and answers it back as
  `reviewed_at`. The posting keeps the NEWEST decision: a decision older than the one held, or one
  at the same instant that differs from it (state, reviewer, reason, narrowing or hash), is
  `409 DECISION_SUPERSEDED` and stores nothing. So a late retry can never undo a newer decision.
  Earlier than 2026-01-01, or more than 60 seconds ahead of BadaBhai's clock, is
  `400 VALIDATION_FAILED`.

Optional `course_ids` and `reason` (≤ 500 characters). The company sees `reason` as written, so
write it for them. BadaBhai drops control characters (newlines are kept), invisible format
characters (bidi overrides, zero-width spaces; ZWNJ and ZWJ are kept, Indic spellings need them),
line and paragraph separators, private-use, unassigned and lone-surrogate code points from it
before storing; a reason of nothing else counts as no reason. A narrowed `branch_ids` or
`course_ids` replaces the posting's own for RVM students; when sent it must be non-empty (an empty
list would mean every branch) and within the posting's own targeting: each id must be in the
posting's own list, or, when that list is empty (every branch or course), an active targeting
option (`PUT targeting-options`). Otherwise 400 `VALIDATION_FAILED`, naming the ids. A rejection
may carry a narrowing too; it is checked and stored the same way, and has no effect while the
posting is rejected.

Answers `200 { "posting_id", "review_state", "reviewed_at" }`, `reviewed_at` being the decision's
`decided_at`. A newer decision replaces the earlier one. The same body again (same `decided_at`, same
decision) changes nothing and answers the decision held, so retrying the SAME body is safe; the
`Idempotency-Key` is validated, not stored. A new decision needs a new `decided_at`. A replay
answers the held decision only while it still holds: when the posting's content has changed since
(even by a BadaBhai edit that did not reset the review), the replay is `409 POSTING_CHANGED`, as
any stale body is.

The checks, in order:

| Answer                      | When                                                                                                                                                                                   |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400 `VALIDATION_FAILED`     | The body fails the schema, or `decided_at` is before 2026-01-01, has an offset past ±14:00, or is more than 60 s ahead of BadaBhai's clock                                             |
| 404 (no code)               | The id is not a posting, or the posting is a draft, is hidden by BadaBhai, has no owning company, or the company is not in the RVM-audience rollout; `CAMPUS_LINK_ENABLED` off as well |
| 409 `AUDIENCE_EXCLUDES_RVM` | The posting is for BadaBhai workers only                                                                                                                                               |
| 409 `POSTING_NOT_OPEN`      | The posting is closed. Closing is final, so a decision could never reach a student. A paused or suspended posting can be reviewed: it opens again with the same content                |
| 200 (replay)                | The posting holds this exact decision at this `decided_at`, and its content is unchanged                                                                                               |
| 409 `DECISION_SUPERSEDED`   | A later decision is held, or a different one at the same `decided_at`: the newer decision stands, do not re-review                                                                     |
| 409 `POSTING_CHANGED`       | `content_hash` is not the posting's hash now (a replay included), or the review went back to pending more than 10 minutes after `decided_at`                                           |
| 400 `VALIDATION_FAILED`     | A narrowed id is outside the posting's own targeting                                                                                                                                   |

Time is checked before content. A decision older than the one held is obsolete whatever the content
did, so it is `DECISION_SUPERSEDED` (do not re-review it: a newer decision exists). A decision on a
posting whose review went back to pending after it, or on changed content, is `POSTING_CHANGED`
(re-fetch and re-review). A decision is stored only when every check passes, and the write itself
re-checks them, so no answer can let another's stale case through.

Any later edit by the company to a field RVM students see (company name, title, description,
requirements, benefits, pay, location, shift, experience, vacancy, audience or targeting) returns
the posting to `pending`. A decision counts only for the content it saw: BadaBhai stores its hash
with it and compares it on every read, so a posting edited after approval reads `pending` even
before anything resets it. A posting back at `pending` refuses a decision made more than 10 minutes
before it went back, with `POSTING_CHANGED`: the posting needs a fresh review, and a decision lost
in the network cannot land after the company edited the posting away and back (A→B→A). The 10
minutes cover Campus's clock running behind BadaBhai's plus delivery delay; a clock further behind
would keep answering `POSTING_CHANGED` to fresh reviews, so keep the Campus server NTP-synced. A
first decision on a posting with no review row always applies. The review never changes which
BadaBhai workers see the posting.

### PUT targeting-options

The whole current list of branches and courses a company may target. Send every option Campus
offers, each time; the position in the list is the order companies see.

```json
{
  "as_of": "2026-11-13T08:00:00.000+05:30",
  "branches": [
    { "id": 1, "name": "Faridabad" },
    { "id": 2, "name": "Pune" },
    { "id": 3, "name": "Ahmedabad" },
    { "id": 4, "name": "Lucknow" }
  ],
  "courses": [
    { "id": "cnc-programming", "name": "CNC Programming" },
    { "id": "cad-design", "name": "CAD Design" }
  ]
}
```

`as_of` is **required**: when Campus read this list, by its clock (from 2026-01-01 on, with an
offset within ±14:00). A list is
applied only when its `as_of` is newer than the last list applied. An older or same-instant list
that differs from what is held is `409 DECISION_SUPERSEDED` and changes nothing, so a late retry
never puts back an option Campus has since removed; one that equals what is held answers `200` with
nothing written (retrying the SAME body is safe; the key is validated, not stored). Earlier than
2026-01-01, or more than 60 seconds ahead of BadaBhai's clock, is `400 VALIDATION_FAILED`.

Both lists are required and must be NON-EMPTY: at least one branch and one course (to retire an
option, leave it out of a list that still names another). At most 50 branches and 100 courses (what
one posting may target), each id at most once per list. Branch `id` is the RVM location id (1 to
9,999,999,999). Course `id` is a Scheduler course id, 1 to 64 characters after trimming; a plain
space inside it is allowed, but no other separator and no control, format, private-use, unassigned
or lone-surrogate character; no other charset is imposed. `name` is 1 to 150 characters after
trimming, with no control, format (ZWNJ and ZWJ excepted), line or paragraph separator,
private-use, unassigned or lone-surrogate character. These bounds keep the largest valid body near
90 kB, under the 100 kB JSON limit. An option BadaBhai holds that is not in the list is marked
inactive, never deleted: postings that already target it keep it, and new targeting cannot pick
it. An option that returns is active again.

Answers `200` with what changed, per kind:

```json
{
  "branches": { "listed": 4, "added": 0, "updated": 1, "deactivated": 0 },
  "courses": { "listed": 2, "added": 1, "updated": 0, "deactivated": 1 }
}
```

`updated` counts a changed name or position, or an option that came back. No `job_audience` rollout
gate: the options are global, and companies see them only where their own rollout is on.

### POST job-postings

```json
{
  "company": { "phone": "9000000001", "name": "Sharma Precision Works" },
  "title": "CNC Operator",
  "description": "Run a 3-axis CNC lathe on day shift.",
  "city": "Faridabad",
  "state": "Haryana",
  "openings": 3,
  "pay": { "min": 16000, "max": 22000, "type": "in_hand" },
  "branch_ids": [1],
  "course_ids": ["cnc-programming"],
  "staff_ref": "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d"
}
```

The company is found by exact phone, or created as **pending** (its owner activates it by signing
in with a code). The posting is open, for RVM students, with its review recorded as approved by
`staff_ref`. Answers `201 { "posting_id", "company_id", "company_created", "review_state": "approved" }`.
`openings` is stored as the matching `vacancy_band`.

### GET companies?phone=

`200 { "company": { "id", "name", "status": "active" | "pending" } }`, or `{ "company": null }`.

### POST applications

```json
{
  "external_ref": "campus-app-000123",
  "posting_id": "b2c4e6f8-1a3b-4c5d-8e7f-90a1b2c3d4e5",
  "student_ref": "3c9e7b21-4f6a-4d8e-b1c2-a3d4e5f60718",
  "applied_at": "2026-11-13T11:15:00.000+05:30"
}
```

Send the Campus application id as both `external_ref` and `Idempotency-Key`. Only the reference
travels: BadaBhai reads the student's agreed fields from RVM's Student API itself, under the
student's consent, so no name, phone, course or résumé link is sent here. BadaBhai sets the RVM tag
and the came-from itself. `applied_at` is kept as information only; BadaBhai orders and dates
applications by its own clock.

Answers `201` with the application, or `200` with the same application on a replay:

```json
{
  "application_id": "c0d1e2f3-a4b5-4c6d-9e8f-a0b1c2d3e4f5",
  "external_ref": "campus-app-000123",
  "posting_id": "b2c4e6f8-1a3b-4c5d-8e7f-90a1b2c3d4e5",
  "student_ref": "3c9e7b21-4f6a-4d8e-b1c2-a3d4e5f60718",
  "stage": "new",
  "changed_at": "2026-11-13T11:15:01.000+05:30"
}
```

### GET applications (status feed)

Query: `changed_since`, `cursor`, `limit`. Answers `{ "applications": [ …as above… ], "next_cursor" }`.
`stage` is one of `new`, `shortlist`, `selected`, `hired`, `passed`, `withdrawn`. `new`, `shortlist`
and `passed` exist today; `selected` and `hired` arrive with #2747. Campus maps `passed` to its own
`rejected`.

### DELETE applications/:external_ref

Withdraws. Idempotent. Answers the application with `stage: "withdrawn"`.

### PUT search-grants/:grant_ref

```json
{
  "company_id": "7d3f2a10-5b8e-4c1d-9a6f-0e2b4c6d8f10",
  "student_ref": "3c9e7b21-4f6a-4d8e-b1c2-a3d4e5f60718",
  "consent_ref": "consent-req-000456"
}
```

BadaBhai reads the student's own yes from RVM by `consent_ref` before storing the grant. The consent
RVM returns must name this same student and this same company: a mismatch, like a student who said
no, gets `STUDENT_NOT_AVAILABLE` and no row, so one consent cannot be replayed for another company.
Answers
`{ "grant_ref", "company_id", "student_ref", "state": "active", "changed_at" }`.
`DELETE search-grants/:grant_ref` answers the same with `state: "revoked"`.

### DELETE students/:student_ref

Unlinks: no new opens, copied fields erased, the BadaBhai row deleted when he has no BadaBhai
account of his own. Answers `{ "student_ref", "state": "unlinked" }`.

Call it when the student withdraws his RVM consent or asks RVM to delete him. Idempotent: a
reference BadaBhai never linked, or one already unlinked, answers the same and changes nothing.
Contacts companies opened before the unlink stay with them. A later consent links him again on his
next application.

### GET drive-requests

The placement team's queue (#2746). PULL, NOT PUSH: Campus reads the requests here and posts each
decision back; BadaBhai never calls Campus about a drive.

**No rollout switch here** (owner ruling R1, 14 Nov 2026). `CAMPUS_DRIVE_REQUESTS_ROLLOUT` gates a
company making a NEW request, nothing else. Every request that exists is listed and can be decided,
whether its company was removed from the pilot or the switch is off everywhere, and its
cancellation and an erasure of its contact reach the feed. Nothing is skipped, so a page holds
`limit` items unless it is the last.

Only a verified employer can make a request: admin approval plus a GSTIN on file, and nothing else
(owner ruling 14 Nov 2026; the phone route can be added later). Agency accounts cannot.

Query: `status` (`requested`|`scheduled`|`declined`|`completed`|`cancelled`), `changed_since`
(ISO 8601 with offset), `cursor`, `limit` (1–200, default 100). Ordered by `changed_at`, then
`id`; `changed_since` returns requests changed at or after the instant. A `changed_since` before
`2026-01-01T00:00:00Z` (a first sync sending the epoch) is read as that date, never refused.

`changed_at` is when BadaBhai last changed the ITEM: the request itself, or its company's account or
company record. A company withdrawn or reinstated by an admin therefore comes back in the feed
although the request did not change.

- **Overlap window: two minutes.** A write is stamped a moment before it commits, so a poll can miss
  a request stamped just before the last one it saw. Poll with `changed_since` = the largest
  `changed_at` you processed **minus two minutes**, and process items by (`id`, `changed_at`):
  the same pair again is the same state.
- **Paging.** Follow `next_cursor` until it is `null`. An item may come back unchanged.

```json
{
  "drive_requests": [
    {
      "id": "5a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
      "company": { "id": "7d3f2a10-5b8e-4c1d-9a6f-0e2b4c6d8f10", "name": "Sharma Precision Works" },
      "company_withdrawn": false,
      "job_posting_id": "b2c4e6f8-1a3b-4c5d-8e7f-90a1b2c3d4e5",
      "branch_ids": [1],
      "preferred_from": "2026-12-01",
      "preferred_to": "2026-12-15",
      "openings": 12,
      "roles_note": "CNC operators and setters for two shifts. Fanuc experience a plus.",
      "contact": { "name": "Ravi Sharma", "phone": "+919000000001" },
      "status": "scheduled",
      "scheduled_on": "2026-12-05",
      "campus_drive_ref": "campus-drive:000417",
      "decided_at": "2026-11-20T03:30:00.000Z",
      "decided_by_ref": "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d",
      "reason": null,
      "is_test": false,
      "requested_at": "2026-11-14T06:15:00.000Z",
      "cancelled_at": null,
      "changed_at": "2026-11-20T03:30:00.412851Z"
    }
  ],
  "next_cursor": null
}
```

- `company.name` is the company's display name; `job_posting_id` (optional) is one of its own
  postings, as context for the roles. It may be a BadaBhai-only posting that `GET job-postings`
  never lists.
- `branch_ids`: preferred RVM location ids; empty means any branch.
- **`contact` is personal data**: the company's contact person for the drive, decrypted for the
  placement team to call and for nothing else. `phone` is E.164. Do not copy it beyond the
  drive's own record. It becomes `null` when BadaBhai erases it (a DPDP request, or the login that
  entered it was deleted); the request then comes back in the feed with `contact: null`, and
  Campus should drop its own copy.
- **`company_withdrawn: true`** (owner ruling R2): the company is no longer verified (its admin
  approval or its GSTIN was removed) or its account is suspended or archived. The item then keeps
  its status and dates only: `contact` and `roles_note` are `null`, and a decision is 409
  `COMPANY_WITHDRAWN`. Drop the contact you hold. When the company is reinstated the full item
  comes back (`company_withdrawn: false`) and decisions work again.
- **Campus's copy of the contact** (owner, 14 Nov 2026). BadaBhai's erasure reaches the copy Campus
  holds only through the feed's `contact: null`, which needs the request row to exist. A
  whole-company delete removes the rows (`ON DELETE CASCADE`) and sends Campus no signal, so that
  copy would stay. **#2811's fix must not go live until a company delete sends Campus an erasure
  signal (a tombstone) for each of its drive requests.**
- `is_test: true` marks a test company's request. Test requests are listed like any other, so a
  pilot can be proved end to end in production: filter or label them on Campus's side.
- `decided_at`, `decided_by_ref` and `reason` are the latest decision, as Campus sent them.

### POST drive-requests/:id/decision

```json
{
  "decision": "scheduled",
  "decided_by_ref": "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d",
  "decided_at": "2026-11-20T09:00:00.000+05:30",
  "scheduled_on": "2026-12-05",
  "campus_drive_ref": "campus-drive:000417"
}
```

- `decision`: `scheduled` | `declined` | `completed`. Cancelling is the company's alone.
- `decided_by_ref` (required): the staff member, a uuid. Stored as a reference, never resolved.
- `decided_at` (required): when the staff member decided, by Campus's clock. The review's rule:
  before `2026-01-01T00:00:00Z` or more than 60 seconds ahead of BadaBhai's clock is 400
  `VALIDATION_FAILED`. A `completed` dated (as a day in India) before the drive's
  `scheduled_on` is 409 `DECISION_NOT_ALLOWED`: a drive cannot have happened before its day.
- `scheduled_on` and `campus_drive_ref`: required with `scheduled`, refused with the others.
  `scheduled_on` runs from today in India to a year after it; otherwise 400 `VALIDATION_FAILED`.
  `campus_drive_ref` is Campus's id for its drive record (1–200 characters of
  `A-Z a-z 0-9 . _ : -`), stored as sent.
- `reason` (optional, ≤ 500 characters): the company sees it as written, so write it for them.
  Hidden characters are removed as from a review note: control and invisible format characters
  go, newlines and ZWNJ / ZWJ (Indic spellings) stay; a reason of nothing else counts as no reason.

Answers `200 { "drive_request_id", "status", "scheduled_on", "campus_drive_ref", "decided_at",
"changed_at" }`: the request as it now stands. The `Idempotency-Key` is required and checked, not
stored: the decision is idempotent by content.

**The newest decision wins, by `decided_at`** (the owner's rule for Campus decisions, 14 Nov 2026),
checked under the request's row lock before anything else:

| Body's `decided_at` against the held decision      | Answer                                                    |
| -------------------------------------------------- | --------------------------------------------------------- |
| Older                                              | 409 `DECISION_SUPERSEDED`, nothing stored                 |
| The same instant, the same decision, still current | 200, the request unchanged (a replay: no write, no event) |
| The same instant, any field different              | 409 `DECISION_SUPERSEDED`, nothing stored                 |
| Newer, or no decision held yet                     | The transition rules below                                |

"The same decision" is the same `decision`, `decided_by_ref` and `reason`, and for `scheduled` the
same `scheduled_on` and `campus_drive_ref`. The same instant in another offset is the same instant.
A replay answers the held decision only while it is still the request's status: once the company
has cancelled, the same body is `DECISION_NOT_ALLOWED` (below). There is no pending-row floor as on
the review: a drive request never goes back to `requested` and the company cannot edit it, so a
request with no decision accepts any `decided_at` the clock rule allows.

**Transitions.** Anything not listed is 409 `DECISION_NOT_ALLOWED` with the current `status` in the
body, and stores nothing:

| From        | `scheduled`                | `declined`                 | `completed`                  |
| ----------- | -------------------------- | -------------------------- | ---------------------------- |
| `requested` | yes                        | yes                        | no (never scheduled)         |
| `scheduled` | yes (reschedule: new date) | yes (date and drive id go) | yes (date and drive id kept) |
| `declined`  | no                         | no                         | no                           |
| `completed` | no                         | no                         | no                           |
| `cancelled` | no                         | no                         | no                           |

The company may cancel from `requested` or `scheduled`; it takes the same row lock as a decision,
so the two run one after the other. A decision that arrives after a cancel, including a late retry
of the decision the company then cancelled, is 409 `DECISION_NOT_ALLOWED` (`status: "cancelled"`).
Cancelling never touches Campus's drive record: read it in the feed.

Which requests can be decided: every request that exists, whatever the rollout switch says (404, no
code, for an id that is not a request). A request whose company is withdrawn is 409
`COMPANY_WITHDRAWN`, nothing stored, until the company is reinstated. No tenancy is read or
written.

A decision that changed the request writes, in one transaction, the request, the event
`campus_drive.decided` v1 (ids, enums and dates: never the reason text) and an `audit_logs` row
whose actor is `decided_by_ref` (`actor_type` `campus_staff`) and which names this call's
`X-Campus-Call-Id`.

## Decisions behind this shape (answers to Campus's points of 13 Nov 2026)

1. **Header:** `X-Service-Token`, as the Student API. Two live tokens during a rotation.
2. **Status back:** a pull feed (`GET applications`), not a push to Campus. One direction, one
   credential, and Campus's dispatcher already runs every minute.
3. **Job-changed nudge:** dropped. `changed_since` covers it; #179 is a proposed enhancement.
4. **Application payload:** the reference only. Student facts come from RVM under his consent, and
   the résumé link is fetched short-lived when a company opens his contact (#2747).
5. **`POST companies`:** not a route. `POST job-postings` finds or creates the company.
6. **Waiver and drive date:** owned by #2750 (waiver) and #2746 (drive requests: Campus pulls them
   and posts a decision carrying the date), mounted behind this guard.
7. **Courses:** `{id, name}`. Campus matches on the name today; ask the Student API
   (Scheduler_Backend#162) for `course_id` next to `branch_id`, then match on ids.
8. **Review carries the `content_hash` the reviewer saw** (owner, 14 Nov 2026), so an approval
   never lands on content nobody saw.
9. **Decisions carry `decided_at`** (owner, 14 Nov 2026), so a late retry never undoes a newer
   decision. The targeting list carries `as_of` for the same reason.

## Inside BadaBhai: how a student becomes a worker row (#2752 part B)

Not a route. `InstituteLinkService.linkStudent(student_ref)` runs inside the routes that need a
linked student (apply, grant):

1. Reads his six agreed fields from RVM's Student API (`RvmStudentApiClient`, Scheduler_Backend#162),
   before any write. RVM's refusal → `STUDENT_NOT_AVAILABLE`, nothing created. RVM down, slow or
   off-contract → `RVM_UNAVAILABLE`, retryable, nothing created, never read as a withdrawal.
2. In one transaction: finds or creates the `workers` row by the hashed +91 phone (a new row is
   `pending`, name and phone encrypted), writes `worker_institute_links` and, for a new row, a
   `worker_origins` row (`institute` / `rvm`), and emits `worker.institute_linked` v1
   (`worker_id`, `institute_code`, `worker_created`; ids only). No `worker_consents` row, no
   `worker.created`.
3. A worker who already uses BadaBhai keeps his own row, name and origin. RVM's phone change moves
   only a row that has never signed in.

Manual list (`audit_logs`, ids and a reason code): `institute_link.phone_mismatch`
(`phone_held_by_another_worker`, `worker_signs_in_himself`) and `institute_link.refused`
(`worker_linked_to_another_ref`, `worker_suspended`, `worker_deletion_scheduled`).

## Inside BadaBhai: who may see or open a linked student (#2752 part C)

Not routes. These rules hold with `CAMPUS_LINK_ENABLED` off too, because a link outlives the flag.

1. **Search.** An actively linked student never appears in a company's candidate search, even if
   he also accepted BadaBhai's own consent in the worker app (issue question 2: hidden while the
   link is active).
2. **Opening** (`InstituteOpenGate`, asked by unlock, reveal and résumé disclosure). A company opens
   him only if he applied to one of its jobs, through Campus or the worker app. His own BadaBhai
   consent does not widen that while the link is active. Every refusal is the same neutral body a
   company gets for anyone it may not open.
3. **Consent re-read before an open.** A confirmation older than `RVM_CONSENT_RECHECK_SECONDS`
   (default 300) is read again from RVM's Student API. RVM's `NOT_AVAILABLE` withdraws the link
   and erases the copied facts (`worker.institute_unlinked`, reason `consent_not_confirmed`), so a
   missed unlink call cannot leave him open. It never deletes a row: RVM gives that answer for any
   reason, an inactive account included. An outage refuses the open and ends nothing.
4. **Unlink** (`DELETE students/:student_ref`, reason `campus_request`). The link is withdrawn and
   its course, branch, status and score are erased. A row the link created is deleted with his
   applications when he never used it as a BadaBhai account (no BadaBhai consent, PIN or device);
   anyone else keeps his row, name and profile. Event `worker.institute_unlinked` v1: `worker_id`,
   `institute_code`, `reason` (`campus_request` | `consent_not_confirmed`), `worker_deleted`; ids
   only. Audit rows record the route template, never the reference in the path.
5. **Send `DELETE students/:student_ref` only for a withdrawal or a deletion request.** A retried
   DELETE that arrives after he consented again still unlinks him; his next application links him
   again.
6. **Admin.** A row the link created that he never signed in to (`pending`, origin `institute`) is
   in no onboarding-funnel cohort, has no worker journey (404) and is in no dashboard status count
   until his first worker-app sign-in. The admin candidates search labels an actively linked row
   (`institute_code: "rvm"`) and filters on it (`filters.institute_linked`).

## Open decisions (owner, before the route is built)

1. **Posting in an existing company's name.** As written (issue item 5), `POST job-postings` finds
   an active company by phone and publishes an approved, open posting in its name without the
   company confirming, and `GET companies?phone=` tells whether a phone is a company. A leaked
   Campus token could then post as any employer whose phone it knows. The alternative is to hold a
   posting for an existing active company until that company confirms, and to answer
   `GET companies` only for companies Campus created. Needs Prakash's and Akshit's call.

## Setting the link up

1. Generate a token (32+ random bytes); give it to Campus as `SERVICE_OUTBOUND_BADABHAI_TOKEN`.
2. Put its sha256 hex in `CAMPUS_SERVICE_TOKEN_SHA256S` and the Campus server's **public** egress
   address in `CAMPUS_SERVICE_ALLOWED_IPS`. A refused call logs the address it came from (at most
   once a minute). Outside development a loopback, private or link-local peer is always refused:
   seeing one means the proxy hop is not trusted (`TRUST_PROXY_HOP_COUNT` must be 1 behind the box
   nginx), and that address is the proxy's, never Campus's.
3. Turn `CAMPUS_LINK_ENABLED` on and call `GET ping`.
4. Rotation: add the new hash beside the old, move Campus to the new token, then remove the old hash.
   Each audit row records which slot matched.

Production: these are not yet bridged from GitHub secrets (`docs/environment-variables.md`); the
bridge lands with the pilot.
