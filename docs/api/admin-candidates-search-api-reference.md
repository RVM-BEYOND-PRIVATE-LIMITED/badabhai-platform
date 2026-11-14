# Admin API — candidates search (`POST /admin/candidates/search`)

Issue #2559 (plan B5) · ADR-0062 §3.6, §3.7, §3.9 · code: `apps/api/src/admin/admin-candidates.*`

The Candidates data-bank list: one universal search box over every field, 16 filters, allow-list sorts with a stable tiebreaker, numbered pages with the exact total, and per-filter facet counts. Read-only.

## Request

|               |                                                                                                                  |
| ------------- | ---------------------------------------------------------------------------------------------------------------- |
| Method / path | `POST /admin/candidates/search` — POST, not GET: the free-text `q` travels in the BODY ONLY, never in a URL, route, error or validation message (ADR-0062 §3.6; the term must never reach a log line — a unit test pins that) |
| Auth          | admin session (`AdminAuthGuard`) + `AdminRolesGuard`                                                             |
| Capability    | `read_candidates` — super_admin, ops_admin, support, analyst (the read floor; names are additive via `read_identity` inside the service, never a second decorator) |
| Headers out   | `Cache-Control: no-store` (always — the route is name-bearing)                                                   |
| Body          | `AdminCandidateSearchSchema` (`.strict()` — a typo'd filter 400s, never silently unfilter)                       |

```ts
{
  q?: string;                    // 1..200 chars, optional: bare-filters list
  filters?: {
    status?: string[];                       // ≤ 10
    trade_id?: string[];                     // ≤ 20 (canonical_trade_id)
    role_id?: string[];                      // ≤ 20 (canonical_role_id)
    min_experience_years?: number;           // 0..60
    max_experience_years?: number;           // 0..60
    role_experience_months_min?: number;     // int 0..1200
    role_experience_months_max?: number;     // int 0..1200
    state?: string[];                        // ≤ 20
    city?: string[];                         // ≤ 20
    language?: string[];                     // ≤ 20 (overlap `&&`)
    profile_status?: string[];               // ≤ 20
    has_resume?: boolean;                    // resume_count > 0 / = 0
    last_active_from?: string;               // ISO-8601
    last_active_to?: string;                 // ISO-8601
    registered_from?: string;                // ISO-8601 (created_at)
    registered_to?: string;                  // ISO-8601
    deletion_scheduled?: boolean;
    flagged?: boolean;
    is_test_account?: boolean;
    form_level?: ("easy" | "medium" | "hard")[]; // ≤ 3
    institute_linked?: boolean; // #2752: true = actively linked institute (Campus) students only
  };
  sort?: CandidateSearchSort;      // default "last_active_at" — 20 listed columns, anything else 400s
  dir?: "asc" | "desc";            // default "desc"
  page?: number;                   // ≥ 1, default 1
  page_size?: 25 | 50 | 100;       // default 50 — max 100, the Candidates identity bound
}
```

Sortable columns: `last_active_at`, `created_at`, `updated_at`, `total_experience_years`, `role_experience_months`, `ai_cost_inr`, `resume_count`, `current_city`, `current_state`, `status`, `trade_label`, `role_label`, `domain_label`, `profile_status`, `salary_min_inr`, `salary_max_inr`, `availability_status`, `shift_preference`, `form_level`, `education_level`. Every sort carries the `worker_id ASC` tiebreaker, so concurrent inserts never reorder tied rows mid-paging.

## `q` classification (never logged)

| Term shape | Branches that run | `q_type` |
| ---------- | ----------------- | -------- |
| omitted / blank | none (bare-filters list) | `null` |
| letters present (e.g. `cnc`, `Mumbai 400001`) | folded `ILIKE` over `search_doc` + whole-word name tokens (`@>`, ALL words) for `read_identity` holders with a provisioned keyring | `"name"`, or `null` without keyring / for analysts |
| pure phone-shaped (bare 10-digit → `+91`, or strict E.164) | exact `phone_hash` match ONLY — no text/name smear | `"phone"` |
| phone-shaped but the caller lacks `read_identity` | nothing — the whole request `403`s (never faceless rows that would confirm "no such number") | — |

A lettered term is never guessed as a phone; a pure phone term runs only the phone branch (digits match no label). The phone travels no further than its HMAC — the repository receives the hash, never the number.

## Response

```ts
{
  candidates: AdminCandidateRow[];  // every admin_candidate_index column EXCEPT lookup material
  page: number;
  page_size: number;
  total: number;                    // exact (count(*), same predicate as the page)
  total_pages: number;              // ceil(total / page_size)
  counts: {
    by_status: { value: string; count: number }[];
    by_trade: { value: string; count: number }[];
    by_city: { value: string; count: number }[];
    by_profile_status: { value: string; count: number }[];
  };
  q_type: "name" | "phone" | null;  // which identity lookup RAN — never the term
}
```

One statement family serves page + exact total + identity-match count + all four facets under one shared WHERE, so the counts describe the rows.

## Errors

| Status | When |
| ------ | ---- |
| `400` | body fails the schema (unknown key, bad `page_size`, unlisted `sort`, over-long `q`) |
| `401` | no / expired admin session |
| `403` | role without `read_candidates`; or a phone-shaped `q` without `read_identity` (nothing served) |
| `429` | per-admin SEARCH cap tripped (300/hour, 2000/day, fail-closed) + PII-free `admin.candidates_search_cap_exceeded` |
| `5xx` / empty page | the lookup audit could not be written — an EMPTY page, never partial rows |

## Audit

- Every term search consumes the per-admin SEARCH cap first (`admin_candidates_search:*` Redis namespace, fail-closed 429).
- A name/phone lookup emits `admin.identity_searched` v1 — payload `{ admin_id, search_kind, match_count }`, subject `admin_session` — AFTER the match and BEFORE any result leaves. Awaited and fail-closed; never the term, a hash of it, or matched ids.
- Names on the page go through `AdminIdentityService` surface `candidates`: 100-name bound, OWN budget (2000/hour, 10000/day in `admin_candidates_identity:*`), `admin.identity_viewed` audit, and the once-a-day 50%-of-daily `admin.candidates_name_budget_alert`. Over-cap/over-bound reads serve the faceless projection (the `name` field stays ABSENT; disclosed-but-unnamed is `null`).

Analysts (no `read_identity`) get label search faceless — no name branch, no names, no phone lookup.

## Performance (acceptance, measured)

p95 ≤ 300 ms for search + filter + sort at 50,000 rows, measured with a local synthetic seed (never production):

```
pnpm db:seed:candidates-perf --workers=50000 --tag=<tag>   # local only, refused elsewhere
node apps/api/dist/admin/candidate-search-perf.cli.js --tag=<tag> --runs=21
pnpm db:seed:candidates-perf --clean --tag=<tag>
```

Recorded 2026-11-06, local Postgres, 21 runs × 6-query battery (text, text+filter+sort, phone, name, filtered, facets) through the real `AdminCandidatesRepository` (the endpoint's statement minus HTTP): OVERALL p50 ≈ 132–137 ms, **p95 294.7 ms then 263.9 ms** on two consecutive runs. Fixture removed afterwards.

## Field shape

One faceless candidate row — `worker_id`, `status`, `flagged`, `is_test_account`, `deletion_scheduled_at`, `employer_sharing_consent`, city/state, trade/role/domain ids + labels, experience, salary band + period, availability, shift, `form_level`, `skills[]`, `languages[]`, `education_level`, resume count/status/version, `profile_status`, `profile_source`, `app_version`, `last_active_at`, `created_at`, `updated_at`, `ai_cost_inr`, `referral_source`, `institute_code` (`"rvm"` while he is actively linked to an institute through BadaBhai Campus, else `null`; read live, so an unlink shows at once; #2752), and optional `name` (identity rules above). Never projected: `phone_hash`, `name_token_hashes`, `name_token_key_id`, `search_doc` — filter-only (pinned by `admin-static-guards.test.ts`).

The full typed contract is `AdminCandidateSearchSchema` / `AdminCandidateSearchResponse` in `apps/api/src/admin/admin-candidates.dto.ts`.

## Reads per request

One parallel wave of a fixed seven statements (page, exact total, identity-match count, four facets) plus the identity layer's own lookup when names are permitted. Never one statement per row.

## Tests

`admin-candidates.{service,dto,repository}.test.ts` (incl. the term-never-logged test), `admin-identity-candidates.test.ts` (own bound/budget/alert), `admin-candidates.db.test.ts` (CI "DB-backed gates": every filter, every sort both directions, pages + concurrency, facets, projection), the `#2559` block in `admin-static-guards.test.ts`, `admin.module.boot.test.ts` wiring, config + event-schema tests for the new keys/events.
