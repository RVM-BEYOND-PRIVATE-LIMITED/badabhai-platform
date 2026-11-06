# Admin API — company records (`/admin/companies/*`)

Issue #2564 (plan B10) · code: `apps/api/src/admin/admin-companies.*` · migration `0158_company_records` · backfill `pnpm db:backfill:company-names`

One row per ORGANISATION: the Companies tab's list, detail, team, create, edit, archive and restore. A team-member login never appears as a row — it appears under its org (and in User accounts, org-filtered). Read-only shape, then the governed writes.

## Requests

| Method / path | Capability | Purpose |
|---|---|---|
| `GET /admin/companies` | `read_entities` | Numbered org page: search, filters, sort, totals |
| `GET /admin/companies/:id` | `read_entities` | One company's record (profile PII additive) |
| `GET /admin/companies/:id/members` | `read_entities` | Non-removed logins in the org (faceless) |
| `POST /admin/companies` | `manage_companies` | Create company/agency + first owner login |
| `PATCH /admin/companies/:id` | `manage_companies` | Edit the company record (diffed, keys evented) |
| `POST /admin/companies/:id/archive` | `manage_companies` | Freeze the whole company |
| `POST /admin/companies/:id/restore` | `manage_companies` | Hand every login back to its previous status |

`:id` is the org ANCHOR's payer id (the founder login). A member id resolves to the same org, never to a second company. `Cache-Control: no-store` on the create and detail reads (identity-bearing responses).

## List

Query: `search` (whole-word name, GSTIN or city fragment — one box, ORed), `kind`
(`employer` = company, `agent` = agency), `status` (`pending|active|suspended|archived`),
`verification` (`pending|verified|rejected|suspended`), `sort` (`newest|oldest`,
default `newest`), `page` (1-based, default 1), `pageSize` (default 50, max 100 —
clamped to 50 when names resolve, the identity rule).

```ts
{ items: [{
    org_id: string; anchor_payer_id: string; kind: "employer"|"agent";
    status: "pending"|"active"|"suspended"|"archived";
    verification: "pending"|"verified"|"rejected"|"suspended";
    org_name?: string | null;   // ABSENT without read_identity; null when none on record
    balance: number;            // summed across the org's wallets
    open_postings: number; total_postings: number;
    last_payment_at: string | null;   // null = never paid, never ₹0
    member_count: number; created_at: string;
  }],
  total: number; page: number; page_size: number; }
```

Search runs on keyed HMACs (name word-hashes, GST hash) and the coarse `city`
column — never on plaintext. A pre-0158 row (NULL hashes) is invisible to name
search until the backfill or its next login fills them; it still lists and filters.

## Detail

The list row plus `email`, `phone` and `profile` (GST, address, city, contact
name, website, industry/size/hiring-locations or the agency fields,
verification). Contact identifiers and profile PII decrypt through the
`company_profile` identity surface (read_identity gate, per-field budget +
audit, `admin.identity_viewed` before decrypt) — without it the response is the
faceless record. GST/address/contact are ciphertext at rest and are NEVER
evented, logged or searched.

## Members

`[{ member_id, member_payer_id | null, org_role, status, invited_at,
accepted_at | null }]` — opaque ids only. Login identifiers come from `GET
/admin/accounts?org_id=` (same `read_identity` contract); this endpoint does
not re-disclose them.

## Create

Body: `kind`, `org_name`, at least one of `email`/`phone`, optional profile
fields (employer: `industry`, `company_size`, `hiring_locations`; agency:
`agency_type`, `service_locations`, `operating_cities`, `recruiter_count`,
`source_channels`; both: `gst`, `address`, `city`, `contact_name`, `website`,
`verification`), plus `reason_code: "company_created"` + `reason_text`
(15–500 chars, no hard identifier).

Effect: payer + solo org + owner membership + profile row + temporary password
(`must_change_password`, first sign-in forces the change — the #2563 mechanism,
verbatim) + `payer.activated` + `payer.created` + free-tier grant; audit reason
row and `admin.action_performed(company_created)` in the SAME transaction.
`201` returns `{ org_id, anchor_payer_id, login_id, temporary_password,
must_change_password: true }`. A taken email/phone 409s with a SEPARATE
value-free `company_create_conflict` audit row (the rolled-back transaction
leaves no trace).

## Edit

Body: any subset of the company fields + `reason_code:
"company_profile_updated"` + `reason_text`. The server diffs against the stored
row (decrypting for comparison only) and writes ONLY what changed, in one
transaction with the audit row and the events:
`admin.action_performed(company_profile_updated)` + `payer.profile_updated`
with the CHANGED KEYS only (never values). An empty diff is a 400.

Email change re-checks uniqueness (a taken address 409s); sessions are
id-keyed, so they survive an identifier change.

## Archive / restore

Body: `reason_code` (`company_archived` / `company_restored`) + `reason_text`.
Archive freezes every member login (`pending|active|suspended` → `archived`,
stamping the current status as `previous_status` — suspends compose through
restores) plus the live inventory (postings `open|paused` → `archived`, jobs
`open` → `archived`, agency twins via their source jobs). System-owned twins
(`payer_id` NULL) freeze the same way; the twin sync skips frozen rows on both
ends (`skipped_archived`, no write, no event). Sessions end after the commit.
Per login: audit reason + `admin.action_performed(company_archived)` +
`payer.archived` + `payer.inventory_archived` (counts, not ids). An already
frozen company returns `changed:false` with no write and no event.

Restore hands every `archived` login back to its own previous state (`NULL` →
`pending`, the fail-closed direction) and thaws only `archived` inventory —
suspended-for-other-reasons rows never move. Billing history is untouched by
both: the ledger is never written here.

## Errors

| Status | When |
|---|---|
| `400` | bad uuid / query; empty edit; closed-job style guards (archived posting via ordinary close) |
| `401` | no / expired admin session |
| `403` | role without the route's capability |
| `404` | no such payer / org |
| `409` | taken email/phone; archived company cannot be suspended (restore first) etc. |

## Audit

Every write: one `audit_logs` row per affected login (admin id, action code,
target, `{reason_code, reason_text}`) + the value-free `admin.action_performed`
+ the domain events (`payer.created` / `payer.activated` on create,
`payer.profile_updated` on edit, `payer.archived/restored` +
`payer.inventory_archived/restored` per login on archive/restore) — all in ONE
Postgres transaction per call. Reads emit nothing except the identity boundary's
own `admin.identity_viewed` (awaited, fail-closed, before any decrypt).

## Deploy order

1. Apply migration `0158_company_records` BEFORE the deploy (writers name every
   new column; the archive cascade writes `status='archived'`, which the
   narrowed CHECK rejects — a new build on an unmigrated database 500s).
2. Merge + deploy.
3. Run `pnpm db:backfill:company-names` (dry run first) to fill word/GST hashes
   from the live ciphertext. Idempotent — re-runs report counts with zero writes.
