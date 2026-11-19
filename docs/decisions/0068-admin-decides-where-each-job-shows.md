# ADR-0068 — An admin decides where each job shows

- **Status:** proposed (the owner signs)
- **Date:** 19 Nov 2026
- **Issues:** #2956 (backend), #2957 (the Campus trade list), #2958 (screens); tracking #2959
- **Amends:** ADR-0063 §3.1 ("only the company's own routes may set the audience")

## 1. Context

There are two products: BadaBhai Campus, a white-label placement portal for colleges and RVM, and
BadaBhai, the open hiring app. The owner's direction of 19 Nov 2026:

1. Every company comes in through BadaBhai. Campus's company pages send companies there.
2. A BadaBhai admin, not the company, decides where each job shows:
   - **Campus only** — a CNC turner job with 2 to 3 openings; RVM's trained students fill it.
   - **Both** — the same trade with 50 to 100 openings.
   - **BadaBhai only** — a painter job; RVM has no students in that trade.
3. Only trades RVM trains can go to Campus.

ADR-0063 built the opposite: the company chose the audience on its own form (behind
`JOB_AUDIENCE_ROLLOUT`, never armed for a company), and the admin edit stripped the field. #2746
was closed for that reason. Its storage and reads are kept.

## 2. Decision

### 2.1 What stays

`job_postings.audience` (`badabhai_workers`, `rvm_students`, `both`) and the targeting columns stay
the one value every reader obeys, through `reachesBadaBhaiWorkers()` (with the #2891 hold) and
`reachesRvmStudents()`. The Campus feed, the RVM review table with its live content hash, the
reach lock and the #2891 hold are unchanged. No switch changes what a stored audience means (R81).

### 2.2 The admin writes the audience

`PUT /admin/postings/:id/audience` (one posting) and `POST /admin/postings/audience` (up to 100),
capability `manage_postings`, behind `ADMIN_JOB_AUDIENCE_ENABLED` (off by default; a neutral 404).
Each decision, in one transaction, locks the posting first (then the hold row, then the decision
row; the review row after the posting is written), and:

- writes the audience and targeting (targeting validated by `PostingAudienceService.resolveWrite`);
- **approves the RVM part as the admin** (`reviewer_ref` = the admin id, the content hash now) when
  the choice includes Campus and no approval for this content stands. The admin's choice IS the
  approval. The placement team can still reject it from Campus with a newer decision;
- sets a Campus-origin posting's #2891 hold to match (`on` when the choice includes BadaBhai
  workers, `off` otherwise), so there is one control;
- records the decision in `job_posting_audience_decisions` (who, when, the content hash);
- writes `audit_logs` (reason code and text, before and after) and emits `job_posting.audience_set`
  (admin actor) when the audience or targeting changed, and `admin.action_performed`
  (`posting_audience_set`).

The reach rebuild or clear runs after the commit (non-fatal; `db:materialize:reach` repairs).

### 2.3 The rules

In order; a refusal stores nothing and is answered as an outcome, not an error:

| Outcome | When |
|---|---|
| `twin_not_allowed` | an agency job's synced copy (BadaBhai only by `job_postings_twin_audience_chk`) |
| `posting_closed` | a closed posting |
| `trade_required` | the choice reaches BadaBhai workers on a live posting without one of the 16 trades (#2635); or the choice includes Campus and the posting has no trade |
| `trade_not_taught_at_campus` | the choice includes Campus and the trade is not an active `campus_trades` row (#2957). A Campus-origin posting is exempt: RVM made it for its own students |
| `targeting_option_not_offered` | a branch or course id is not an active RVM option |

Nothing chooses an audience from the number of openings. The admin list shows the openings band
so the admin can decide.

### 2.4 The list

`GET /admin/postings/audience?filter=to_decide|campus|both|badabhai|changed`, live non-agency
postings, oldest first:
- `to_decide` — no decision yet, and the trade is taught at Campus or the job came from Campus;
- `campus` / `both` / `badabhai` — where it shows now, read through the two fragments (a held
  Campus-origin job counts as Campus only);
- `changed` — the stored decision hash no longer equals the posting's hash: the company changed
  what a student sees (openings included) since the decision.

### 2.5 Campus

- **Review:** while `ADMIN_JOB_AUDIENCE_ENABLED` is on, Campus's `PUT job-postings/:id/review` no
  longer reads the company's `job_audience` switch or pilot list: the admin put the job on Campus.
- **Withdrawal:** a job an admin takes off Campus keeps its review row, which the decision bumps.
  The feed's changed-since read now also lists postings with a review row whose audience lost its
  RVM part, as `closed` and with audience `rvm_students` (the wire has no BadaBhai-only value), so
  Campus's pull closes its copy. Before this, such a posting dropped out of the feed and Campus kept
  showing it to students.

### 2.6 What follows

- The company's audience write (`POST`/`PATCH /payer/job-postings` fields and
  `GET /payer/job-postings/audience-options`) is removed in #2956's next part. Until then it stays
  unreachable: `JOB_AUDIENCE_ROLLOUT` is `pilot` with an empty pilot list.
- The Campus trade list routes (#2957). Until a trade is on the list, only BadaBhai only is
  possible for a company job.
- The admin screens (#2958).

## 3. Owner questions (built with the defaults)

1. A new company job in a trade RVM trains goes live to BadaBhai workers at once and waits in
   `to_decide`. The alternative holds it from workers until an admin decides.
2. The company sees where its job shows, read-only.
3. The placement team can still reject an admin-sent job from Campus. An admin re-deciding the same
   job approves it again.
4. Campus-drive requests (ADR-0063 §3.6) are outside this flow and stay off.

## 4. Switch-on order

1. Apply migration `0190_admin_job_audience` and record it in the ledger.
2. Enter the Campus trade list (#2957).
3. Set `ADMIN_JOB_AUDIENCE_ENABLED=true` in the `production` environment and redeploy.
4. Decide a test company's job through all three choices.
