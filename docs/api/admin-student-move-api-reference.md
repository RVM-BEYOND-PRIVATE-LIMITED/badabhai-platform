# Admin moved-students API (`/admin/students`)

Issue #2887 · ADR-0067 · code: `apps/api/src/student-move/*`, `apps/api/src/admin/students/*` · migration `<slot>_student_move` · switch `STUDENT_MOVE_ENABLED` (default off)

## What it is

RVM students moved from Campus into BadaBhai (ruling of 17 Nov 2026) arrive **hidden**: one `student_visibility` row each, with `visible` false.

| | Hidden (visibility off) | Visible (visibility on) |
| --- | --- | --- |
| Matching | Out: no posting reaches him and he counts in no reach total | Matched like any worker; his reach is rebuilt when the switch flips |
| Company search | Out | In |
| Opens | Only a company he applied to can open him (#2752's rule) | Ordinary worker |

A worker who was never moved is untouched.

The student himself signs in to the worker app with the same phone and sees his profile whatever his visibility.

## Access

All routes: `AdminAuthGuard` + `AdminRolesGuard`, capability **`manage_student_visibility`** (super_admin, ops_admin).

All answer `404` while `STUDENT_MOVE_ENABLED` is off, and `503` with it on and the `student_move` migration not applied.

Matching is not switched. Reach depends on no switch (#2746 M2): a hidden moved student is out of `job_reach` whenever the table exists. Company search and opens follow the switch.

## `GET /admin/students`

Query (strict), all optional except the defaults:

| Parameter | Meaning |
| --- | --- |
| `batch_id` | One import run (uuid) |
| `visible` | `true` / `false` |
| `branch` | Branch name, up to 150 characters |
| `course` | Course name, up to 150 characters |
| `cursor` | Next-page token |
| `limit` | 1–200, default 50 |

`200 { students: Student[], next_cursor: string | null }`, newest first.

```json
{
  "worker_id": "22222222-2222-4222-8222-222222222222",
  "visible": false,
  "batch_id": "33333333-3333-4333-8333-333333333333",
  "branch": "Pune",
  "course": "Diploma in CAD",
  "changed_at": "2026-11-17T10:00:00.000Z"
}
```

`branch` and `course` come from the student's active #2752 link, when he has one. The response carries no name or phone.

## `PUT /admin/students/:workerId/visibility`

Body: `{ "visible": true, "reason_text": "Placement team cleared the November batch" }`.

`reason_text` is 15–500 characters, with no hard identifiers.

`200 { student: Student, changed: boolean }`.
- `changed: false` means he was already in that state, and nothing was written.
- `404` means the worker was never moved.

## `POST /admin/students/visibility`

The same switch for many students. The body names exactly one selector: `batch_id`, `branch` or `course`.

```json
{ "visible": true, "reason_text": "Placement team cleared the November batch", "batch_id": "33333333-3333-4333-8333-333333333333" }
```

`200 { changed: number }`: how many students changed state. A repeat changes none.

## What a change writes

One transaction holds:
- the row changes;
- ONE `audit_logs` row:
  - single change: action `student_visibility_changed`, entity `worker`;
  - bulk change: action `student_visibility_bulk_changed`, entity `student_visibility_bulk` with an operation id;
  - in both cases it carries the reason and, for a bulk change, the selector;
- ONE event: `admin.student_visibility_changed` `{ worker_id, visible }`, or `admin.student_visibility_bulk_changed` `{ selector, batch_id, visible, changed }`. Neither carries a branch name, course name or reason.

After commit, each changed student's match supply and reach are rebuilt. A failure is logged and repaired by the next rebuild or `db:materialize:reach`.

## Consent of a moved student

The import writes his Campus consent as his consent row: `consent_version` = `campus_import:<Campus text version>`, `accepted_at` = his Campus consent date, purposes including `employer_sharing`. A visible student can therefore be searched before he signs in.

At his first sign-in, `consent_accepted` is `false` for that row. The worker app therefore shows BadaBhai's own consent screen once, with the 18+ tick. Accepting supersedes the imported row.
