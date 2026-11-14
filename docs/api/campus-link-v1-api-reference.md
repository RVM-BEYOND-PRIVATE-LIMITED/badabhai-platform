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
  postings and review) is built.

## Rules for every call

| Rule                            | Detail                                                                                                                                                                                                   |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Base path                       | `/internal/campus/v1`                                                                                                                                                                                    |
| Token                           | `X-Service-Token: <token>`. BadaBhai stores only its sha256 and accepts two tokens while one is rotated. Never `Authorization: Bearer`.                                                                  |
| Address                         | The caller's address must be on BadaBhai's allow-list. Campus calls BadaBhai over the internet (separate hosts), so this is the Campus server's **public** egress address.                               |
| Writes                          | Every `POST`, `PUT` and `DELETE` carries `Idempotency-Key`: 8–200 characters of `A-Z a-z 0-9 . _ : -`. Missing or malformed → 400 `IDEMPOTENCY_KEY_REQUIRED`.                                            |
| Lasting idempotency             | Redis remembers a key for minutes. The guards that last are `external_ref` on applications and `grant_ref` on grants: the same ref again answers the row it made.                                        |
| Call id                         | Every authenticated answer carries `X-Campus-Call-Id`, the id of BadaBhai's audit row for that call. Log it to correlate.                                                                                |
| Flag                            | With `CAMPUS_LINK_ENABLED` off every route answers a neutral 404.                                                                                                                                        |
| Direction                       | Campus calls BadaBhai for everything here, status included (the `GET applications` feed). BadaBhai pushes nothing on these routes.                                                                       |
| Requests strict, responses open | An unknown key in a request is a 400. A response may gain fields without a version bump; ignore keys you do not know. Removing or retyping a field is a v2.                                              |
| Phones                          | 10 digits starting 6–9. BadaBhai normalises to +91 E.164 before hashing, so one person stays one row.                                                                                                    |
| Student reference               | The hand-off token's `sub`: the Student API account uuid, text up to 128 characters.                                                                                                                     |
| Branches and courses            | `branch_ids` are RVM location ids (Campus's `allowed_location_ids`). Courses travel as `{id, name}`: Scheduler course ids, names for display and for matching until the Student API returns a course id. |

## Errors

Every error uses the api's envelope: `{ statusCode, error: { code, message? }, requestId, path, timestamp }`.

| Status | `error.code`               | When                                                                                  | Retry?             |
| ------ | -------------------------- | ------------------------------------------------------------------------------------- | ------------------ |
| 400    | `VALIDATION_FAILED`        | Body or query fails the schema (including an unknown key)                             | No                 |
| 400    | `IDEMPOTENCY_KEY_REQUIRED` | A write without a valid key                                                           | No                 |
| 401    | `UNAUTHENTICATED`          | Missing or wrong token, or none configured                                            | No                 |
| 403    | `ADDRESS_NOT_ALLOWED`      | Caller address is not on the allow-list                                               | No                 |
| 404    | none                       | Flag off, unknown route, or an id that does not exist                                 | No                 |
| 409    | `EXTERNAL_REF_CONFLICT`    | The same `external_ref` (or `grant_ref`) with a different posting, company or student | No                 |
| 409    | `POSTING_NOT_OPEN`         | Posting closed, paused or hidden, including one that closed at the same moment        | No                 |
| 409    | `POSTING_NOT_APPROVED`     | Posting's RVM review is pending or rejected                                           | No                 |
| 409    | `AUDIENCE_EXCLUDES_RVM`    | Posting is for BadaBhai workers only                                                  | No                 |
| 409    | `STUDENT_NOT_AVAILABLE`    | RVM refuses the student (no consent, not linked, any reason); no row is created       | No                 |
| 429    | `RATE_LIMITED`             | Over the per-minute cap                                                               | Yes, after a pause |
| 503    | `RVM_UNAVAILABLE`          | RVM's Student API did not answer; nothing was created                                 | Yes, same key      |

## Routes

| Method and path                     | Purpose                                                 | Lands with    |
| ----------------------------------- | ------------------------------------------------------- | ------------- |
| `GET ping`                          | Proves flag, address and token                          | **live**      |
| `GET job-postings`                  | Postings whose audience includes RVM students           | #2752 + #2746 |
| `PUT job-postings/:id/review`       | Placement team approves or rejects                      | #2752 + #2746 |
| `POST job-postings`                 | Placement team posts for a company                      | #2752 + #2746 |
| `GET companies?phone=`              | Find a company by exact phone                           | #2752         |
| `POST applications`                 | A student applies                                       | #2752 + #2746 |
| `GET applications`                  | Status feed Campus polls                                | #2752         |
| `DELETE applications/:external_ref` | Student withdraws                                       | #2752         |
| `PUT search-grants/:grant_ref`      | Named-company search grant, after the student's own yes | **live**      |
| `DELETE search-grants/:grant_ref`   | Revoke a grant                                          | **live**      |
| `DELETE students/:student_ref`      | Unlink a student (consent withdrawn or deleted)         | **live**      |

Mounted behind the same guard by their own issues: campus-drive requests and decisions (#2746),
credit waivers (#2750).

### GET ping

`200 { "ok": true, "call_id": "<uuid>" }`. Use it to prove a new token or address before anything else.

### GET job-postings

Query: `review_state` (`pending`|`approved`|`rejected`), `branch_id`, `course_id`, `changed_since`
(ISO 8601 with offset), `cursor`, `limit` (1–200, default 100). With `changed_since`, postings that
closed since are included with `status: "closed"`, so Campus learns about a close.

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
      "changed_at": "2026-11-13T09:30:00.000+05:30"
    }
  ],
  "next_cursor": null
}
```

Empty `branch_ids` or `courses` means every branch or course. `status: "open"` takes applications
only once `review_state` is `approved`.

### PUT job-postings/:id/review

```json
{ "state": "approved", "reviewer_ref": "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d", "branch_ids": [1] }
```

Optional `course_ids` and `reason` (≤ 500 characters). A narrowed `branch_ids` or `course_ids`
replaces the posting's own for RVM students; when sent it must be non-empty (an empty list would
mean every branch) and within the posting's own targeting. Answers
`{ "posting_id", "review_state", "reviewed_at" }`. Any later edit by the company to a field RVM
students see (title, description, requirements, benefits, pay, location, shift, experience,
vacancy, audience or targeting) returns the posting to `pending`.

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

BadaBhai reads the student's own yes from RVM by `consent_ref` (RVM's consent-request `request_id`,
`GET /internal/campus/consent-requests/{id}`) before storing the grant. The reply must carry
`company.ref` equal to `company_id` (asked of RVM on Scheduler_Backend#162, 14 Nov 2026) and this
student's entry with `state: "yes"`. A mismatch, a missing company, or a student who said no gets
`STUDENT_NOT_AVAILABLE` and no row, and no BadaBhai worker row is created for him: one consent cannot
be replayed for another company. An unknown or barred `company_id` is a neutral 404. RVM down →
`RVM_UNAVAILABLE`, retryable. Answers
`{ "grant_ref", "company_id", "student_ref", "state": "active", "changed_at" }`; the same
`grant_ref` again answers the same grant, for good, and the same ref for another company or student
is `EXTERNAL_REF_CONFLICT`, as is a second live grant for one company and student.
`DELETE search-grants/:grant_ref` answers the same with `state: "revoked"` (idempotent; an unknown
ref is a 404). While a grant is live, the student appears in that company's candidate search only,
on the one skill his course maps to, and that company may open him (it pays as for an applicant,
#2750).

### DELETE students/:student_ref

Unlinks: no new opens, copied fields erased, the BadaBhai row deleted when he has no BadaBhai
account of his own. Answers `{ "student_ref", "state": "unlinked" }`.

Call it when the student withdraws his RVM consent or asks RVM to delete him. Idempotent: a
reference BadaBhai never linked, or one already unlinked, answers the same and changes nothing.
Contacts companies opened before the unlink stay with them. A later consent links him again on his
next application.

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
   link is active). The one exception: the company that holds his live named-company search grant
   sees him in its own search.
2. **Opening** (`InstituteOpenGate`, asked by unlock, reveal and résumé disclosure). A company opens
   him only if he applied to one of its jobs (through Campus or the worker app) or it holds his live
   search grant. His own BadaBhai
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
