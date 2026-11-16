# Admin API — hire records (`GET /admin/hires`)

Issue #2753 item 9 · code: `apps/api/src/hires/*` · migration `0168_hires` · switch `HIRE_RECORDS_ENABLED` (default off)

One record per company, worker and posting: who the company took on, and how that is known. Read-only. Only `confirmed` records count toward the hires target.

## Request

|               |                                                                                                                   |
| ------------- | ----------------------------------------------------------------------------------------------------------------- |
| Method / path | `GET /admin/hires`                                                                                                |
| Query         | `cursor` (opaque keyset), `limit` (1–100, default 50), `status` (`reported` / `confirmed` / `rejected`, optional) |
| Strict        | any other query key is `400`                                                                                      |
| Auth          | admin session (`AdminAuthGuard`), then `HireRecordsEnabledGuard`, then `AdminRolesGuard`                          |
| Capability    | `manage_companies` — super_admin, ops_admin (an existing ADR-0025 row; the matrix is unchanged)                   |

| Caller                               | Answer                                    |
| ------------------------------------ | ----------------------------------------- |
| no admin session                     | `401`                                     |
| `HIRE_RECORDS_ENABLED` off, any role | `404` (Nest's bare body; nothing is read) |
| on, support or analyst               | `403`                                     |
| on, super_admin or ops_admin         | `200`                                     |

## Response

Newest record first, keyset on `(created_at, id)` DESC — the admin entity lists' order and cursor. `nextCursor` is `null` on the last page; a malformed cursor reads as the first page.

```ts
{
  items: {
    id: string; // the hire record
    tenant_payer_id: string; // the company's tenant key (its root payer id under org tenancy `on`)
    worker_id: string;
    posting_kind: "company_posting" | "agency_job";
    posting_id: string; // a job_postings id or a jobs id, by posting_kind
    status: "reported" | "confirmed" | "rejected";
    company_marked_at: string | null; // ISO; the company first moved him INTO `hired` on its board
    company_answered_at: string | null; // the company's follow-up answer first said hired (item 10)
    worker_answered_at: string | null; // the worker's own answer first said hired (item 5)
    desk_confirmed_at: string | null; // the worker desk first confirmed it
    hired_on: string | null; // YYYY-MM-DD, India time, of the first confirming source
    created_at: string;
    updated_at: string;
  }
  [];
  nextCursor: string | null;
}
```

FACELESS: ids, closed codes and dates only, as the admin applications list. No worker name or phone and no company name; the worker's and the company's own admin screens show who they are. No `Cache-Control: no-store` (on the admin surface that header marks a body that may hold PII).

## What moves a record

Each source writes the same row (unique on company, worker, posting kind, posting id), in its own transaction, and emits `hire.recorded` `{ hire_id, worker_id, posting_kind, posting_id, status, source }` on each real change. A timestamp is set once and never cleared.

| Source (`source` on the event)                         | Status after                                                                                       | Wired today                   |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------- | ----------------------------- |
| `company_mark` — a real move into `hired` on the board | `confirmed`                                                                                        | yes, in the stage transaction |
| `company_unmark` — a real move out of `hired`          | `rejected` if the mark was the only confirmation (no company answer, no desk); otherwise unchanged | yes                           |
| `company_answer`                                       | `confirmed`                                                                                        | no (item 10)                  |
| `worker_answer`                                        | `reported`, or stays `confirmed`; a repeat changes nothing                                         | no (item 5)                   |
| `desk_confirm` / `desk_reject`                         | `confirmed` / `rejected`                                                                           | no (desk routes later)        |

A no-op stage move writes nothing. With the switch off nothing reads or writes `hires`, and a stage move is unchanged.
