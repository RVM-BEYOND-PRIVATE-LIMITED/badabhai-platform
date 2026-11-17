# Admin API — the numbers screen (`/admin/numbers/*`)

Issue #2755 (parts A, B and C) · code: `apps/api/src/admin/numbers/*` · switch `ADMIN_NUMBERS_ENABLED` (default off) · capability `read_business_numbers` · migrations `*_numbers_weekly` (the snapshot and its recompute log) and `*_credit_call_log` (the call log), both APPLY BEFORE THE SWITCH · setting `NUMBERS_FREEZE_AFTER_DAYS` (default 3)

The CEO's weekly numbers screen. Part A ships the foundations: the definitions catalogue and the test-company marks. Part B ships the weekly figures: the `numbers_weekly` snapshot a nightly sweep keeps (with the freeze, the logged recompute tool and the history baseline) and `GET /admin/numbers/weekly`. Part C ships repeat buying (cohorts by first payment, in the snapshot) and the telecaller's out-of-credits call list with its call log. The launch-test records (part D) build on the same module.

## Access (every route)

|            |                                                                                            |
| ---------- | ------------------------------------------------------------------------------------------ |
| Auth       | admin session (`AdminAuthGuard`), then `AdminNumbersEnabledGuard`, then `AdminRolesGuard`  |
| Capability | `read_business_numbers` — super_admin, ops_admin (ADR-0025 §3.1; owner question 1 default) |
| Caching    | `Cache-Control: no-store` on every response                                                |

| Caller                                | Answer                                    |
| ------------------------------------- | ----------------------------------------- |
| no admin session                      | `401`                                     |
| `ADMIN_NUMBERS_ENABLED` off, any role | `404` (Nest's bare body; nothing is read) |
| on, support or analyst                | `403`                                     |
| on, super_admin or ops_admin          | the route's answer                        |

`support` is added to the capability only if telecallers sign in as support; `analyst` only on the owner's word. The finance summary (`GET /admin/finance/summary`) stays on `read_entities`.

## `GET /admin/numbers/definitions`

The catalogue as code holds it. Reads no table: every field comes from code, and the payments posture from config.

```ts
{
  definition_version: number; // 1; part B stamps it on every stored row, a rule change bumps it
  week: {
    rule: string; // Monday 00:00 to Sunday 23:59:59 India time, named by its Monday
    time_zone: "Asia/Kolkata";
    utc_offset: "+05:30";
    starts_on: "monday";
  };
  cities: {
    normalisation: string; // lower case, up to the first comma, hyphens as spaces, spaces collapsed
    buckets: string;
    groups: { id: "all" | "ncr" | "pune" | "ahmedabad" | "other" | "unknown"; title: string; members: string[] }[];
  };
  trades: {
    buckets: string;
    groups: {
      id: "all" | "cnc_operator" | "cnc_cam_programmer" | "sheet_metal" | "cad_3d_designer" | "other" | "unknown";
      title: string;
      role_kinds: string[]; // job_postings.role_kind / a form worker's form_kind
      taxonomy_roles: string[]; // worker_occupation.role_id / worker_profiles.canonical_role_id
    }[];
  };
  exclusions: { companies: string; workers: string };
  metric_groups: {
    number: number; // 1..10, brief section 8
    id: string;
    title: string;
    metrics: {
      id: string; // part B's numbers_weekly.metric
      title: string;
      unit: "count" | "paise" | "share" | "ratio";
      source: string;
      rule: string;
      availability:
        | { status: "live" }
        | {
            status: "not_available";
            reason: string;
            waits_on: "#2749" | "#2750" | "#2751";
          };
      kind: "headline" | "diagnostic"; // a diagnostic measures a headline's known gap
      list_route?: string; // a live figure served as a LIST by its own route (group 10)
    }[];
  }[];
  small_cell_floor: number; // 5, the onboarding funnel's ADMIN_FUNNEL_K_ANON_FLOOR
  payments: { mode: "real" | "mock"; blocked_reason: string | null }; // the finance PaymentsPosture
}
```

A metric with no live source is `not_available` with its reason and the issue it waits on — never a zero. Live today in the weekly snapshot: paying companies (in the week, and ever), repeat buying (paid again within 30, 60 and 90 days, by first-payment cohort), companies that posted their first job (in the week, and ever), completed profiles (in the week, and in total), active workers (30 days), confirmed hires (in the week, and in total), contacts per hire, revenue by pack as charged, and the form-worker gap DIAGNOSTIC (`form_completed_unconfirmed`, not a headline). Live as a LIST: group 10, the companies whose credits ran out (`out_of_credits_companies`, `list_route: "GET /admin/numbers/out-of-credits"`, never a weekly number). Waiting: the posting-button shares (#2751), welcome credits, couldn't-reach claims and waivers (#2750), the GST split (#2749 part 3) and Managed Hiring revenue (#2751).

## `GET /admin/numbers/weekly`

Every metric of the catalogue for ONE city group and ONE trade group, with this week, last week, the change and the series (part B). It reads ONLY the `numbers_weekly` snapshot (see "The weekly snapshot" below), never a live table, so a frozen week cannot drift; it writes nothing and emits nothing.

| Query   |                                                                                                                          |
| ------- | ------------------------------------------------------------------------------------------------------------------------ |
| `city`  | `all` (default), `ncr`, `pune`, `ahmedabad`, `other`, `unknown` — anything else (a raw city name too) is `400`           |
| `trade` | `all` (default), `cnc_operator`, `cnc_cam_programmer`, `sheet_metal`, `cad_3d_designer`, `other`, `unknown` — else `400` |
| `weeks` | how many weeks of series, `1`..`26`, default `12` — else `400`                                                           |
| other   | any other key is `400` (strict)                                                                                          |

The switch off is a `404` and a role without the capability a `403`, as on every route. On before the `*_numbers_weekly` migration is applied, the read answers `503` (42P01: fail closed, never an empty screen that reads as "nothing happened").

Response `200`:

```ts
{
  definition_version: number; // the code's version now; each point carries the version it was counted under
  payments_posture: { mode: "real" | "mock"; blocked_reason: string | null }; // read every money figure with it
  city: string; // the filter, as applied
  trade: string;
  weeks: string[]; // the series' Mondays, oldest first; the last is the CURRENT week (in progress)
  computed_at: string | null; // ISO time of the newest snapshot row read; null when none was
  metrics: {
    id: string; // catalogue id; one pack's revenue is "revenue_by_pack:<pack_code>"
    group: string; // the catalogue group id
    title: string;
    unit: "count" | "paise" | "share" | "ratio";
    kind: "headline" | "diagnostic";
    availability: "live" | "not_available";
    reason?: string; // not_available only
    waits_on?: "#2749" | "#2750" | "#2751"; // not_available only
    pack?: string; // revenue_by_pack:<code> only
    list_route?: string; // group 10 only: served by that route, no values here
    latest_complete?: Point | null; // repeat buying only: the newest CLOSED cohort (see below)
    this_week: number | null; // the current week's value
    last_week: number | null; // the week before
    change: { absolute: number; percent: number | null } | null;
    series: {
      // one Point per week
      week_start: string;
      value: number | null; // a count, paise, (ratio) the quotient with two decimals, (share) a fraction 0..1 with two decimals
      numerator: number | null; // a ratio's / a share's / the diagnostic's two terms; null otherwise
      denominator: number | null; // a pending share keeps its cohort size here
      suppressed: boolean; // a worker cell under the floor of 5: no number is shown
      pending: boolean; // repeat buying: the window has not elapsed for the whole cohort yet
      before_real_payments: boolean; // the week ends before the first real paid order
      frozen: boolean; // final: only a logged recompute can change it
      definition_version: number | null; // null when the week has not been computed
    }[]; // [] when not_available
  }[];
}
```

- **The metrics, in catalogue order.** A `live` catalogue metric is served from the snapshot; a `not_available` one carries its reason and the issue it waits on, with no values and an empty series, never a zero. `revenue_by_pack` (the all-packs total) is followed by one entry per pack the snapshot holds in the window (`revenue_by_pack:<code>`, `pack: "<code>"`), sorted by code; in a computed week with no row for a pack, that pack had sold nothing yet and its value is `0`.
- **The cell.** Each figure is the filter's OWN stored cell, the `all` roll-ups included (a roll-up is counted from the source rows, never by adding stored cells), so a filter never adds suppressed cells together.
- **`this_week` is the week in progress**, so early in a week it is partial; `frozen: false` says the sweep still updates it.
- **`change`** is `null` when either week has no value (suppressed, not computable, not computed) or the two weeks were counted under different definition versions. `percent` is `null` when last week is `0`, otherwise one decimal. A ratio's change is in the ratio's unit.
- **Repeat buying** (`repeat_purchase_30d` / `_60d` / `_90d`, unit `share`) is a COHORT figure stored under the week of the cohort's first payment: the value is a fraction with two decimals (stored in hundredths), the cohort's size is the `denominator` and the companies that paid again the `numerator`. A point whose window has not elapsed for every company of the cohort is `pending: true` (value and numerator null, never a partial share), so the newest weeks of a series (and `this_week`, `last_week`, `change`) are always pending; `latest_complete` is the newest CLOSED cohort for the filter from any week up to this one (null until one closes), the figure to headline. A closed cohort with no company has value null (numerator 0, denominator 0), never a 0% share.
- **The call list** (group 10) is answered with `availability: "live"`, its `list_route`, no values and an empty series: it is not a weekly figure.
- **`before_real_payments`** is read from the snapshot alone: a week is before real payments when it ends before the first week whose all-cities, all-trades `paying_companies_cumulative` is above zero (no paid order of a countable company had settled by its end). The mock purchase route writes no order row, so it can never end this.

## The weekly snapshot (`numbers_weekly`)

- **One row per week × metric × city group × trade group, `all` included** (6 city labels × 7 trade labels = 42 cells per metric), stamped with `definition_version`, `computed_at` and, once final, `frozen_at`. Stored: `paying_companies`, `paying_companies_cumulative`, `companies_posted`, `companies_posted_cumulative`, `completed_profiles`, `completed_profiles_cumulative`, `active_workers_30d`, `form_completed_unconfirmed` (diagnostic), `confirmed_hires`, `confirmed_hires_cumulative`, `contacts_per_hire`, `revenue_by_pack`, and `revenue_by_pack:<pack_code>` for every pack sold by the week's end. Their rules are `definitions.ts` (served by `GET /admin/numbers/definitions`).
- **Who counts.** Company figures leave out test companies (`payers.is_test_account`) and the workforce seed's sample companies and postings (`face10…` / `face30…` ids); hires and contacts opened also leave out test-account and sample workers. Worker figures leave out test accounts, sample workers and linked RVM identities that never signed in (`exclusions.ts`).
- **Where an entity sits.** A COMPANY figure uses the city and `role_kind` of the company's latest posting (`job_postings`, by `created_at` then id) through the group maps; a company with no posting is `unknown × unknown`. A WORKER figure uses `workers.current_city` and his primary trade as the onboarding funnel reads it (the lowest `sort_order` occupation).
- **Small worker cells.** A worker figure's cell under the floor of 5 (zero included) is stored `suppressed` with every number null, except the `all × all` total. Company figures are not suppressed.
- **Ratios.** `contacts_per_hire` stores both terms; its value is the quotient in hundredths (rounded half up), null when the cell has no confirmed hire. The route divides by 100. The opens carried over by the #2754 import are left out through a named hook (`excludeImportedOpens`), which keeps every open until that import exists.
- **The nightly sweep** (`NumbersSweepProcessor`, a payload-free daily BullMQ job on the `numbers-weekly-sweep` queue). Off, it returns at once and reads nothing; on before the migration, it logs one warning per process and writes nothing. Each run recomputes every NOT-frozen week from the baseline to the current week, one transaction per week under that week's advisory lock (delete, then insert), so two processes racing leave one set of rows. A week freezes `NUMBERS_FREEZE_AFTER_DAYS` (default 3) days after it ends: its last computation sets `frozen_at`, and the sweep never touches it again. A missing SOURCE table (an unapplied lower migration) fails the tick loudly; it is never stored as zeros.
- **The baseline.** The first run computes the history: every week from the later of `NUMBERS_BASELINE_FROM` (2026-06-01, a code constant under the definition version) and the week of the earliest source row, to the current week. Past weeks freeze on that first run, so the first screen already shows a change.
- **Past weeks and the device sighting.** "Active in the last 30 days" is #2753's one last-active day (`lastActiveDayOf`), read as of the week's Sunday: `worker_activity` days up to it, and device sightings before the week's end. A device keeps only its newest sighting, so a past week rests on `worker_activity` and on the devices not seen since; the figure is final at the freeze.
- **Repeat buying** (part C). A company's cohort is the week its FIRST paid order ever settled (`payment_orders` with status paid, the same real-money rule: the mock route writes no order row, and `credit_ledger.price_inr` / `payment.captured` are never read). It paid again within N days when its SECOND paid order settled at most N × 24 hours after the first (two settled at one instant count). A window is pending until N days after the cohort week ends (the latest first payment the cohort can hold). Test and sample companies are out; cells use the company's latest posting, as for paying companies.
- **The freeze of repeat rows is keyed on the end of the longest window.** A week's rows are two FREEZE CLASSES. Its `cohort` rows (the three repeat windows) freeze `NUMBERS_FREEZE_AFTER_DAYS` after its 90-day window has closed (90 + 3 days after the week ends by default), and the sweep keeps recomputing them nightly until then; its `week` rows (every other metric) freeze 3 days after the week ends, as before. Each class is replaced and frozen on its own, so a frozen row NEVER changes (only the logged recompute rewrites it, re-freezing each class on its own time). A week is skipped only when both classes are frozen; a week frozen before part C shipped gets its cohort rows on the next sweep (frozen at once when due).
- **Revenue.** `payment_orders.amount_inr × 100`, as charged. The orders carry no GST split until #2749 part 3 (#2872) lands, so `revenue_gst_split` stays `not_available`; when it lands, the before-GST figure moves to its paise columns (a definition-version bump and a recompute).

## The logged recompute

`node apps/api/dist/admin/numbers/recompute-numbers.cli.js --from <week> --to <week> --reason "<why>" [--apply]` (`pnpm --filter @badabhai/api run recompute:numbers -- …`). Weeks are Mondays (`yyyy-mm-dd`), from the baseline to the current week, at most 104 per run. DRY RUN by default: it prints, per metric, how many stored cells would be added, removed or changed, and writes nothing. `--apply` rewrites the weeks (frozen ones included) from the source tables under the current definitions, each under its week lock, re-freezes those past their freeze time, and writes ONE `numbers_recompute_log` row (`actor` `cli`, the weeks, the definition version, `rows_changed`, the reason), all in one transaction. The reason is the operator's own words (1..500 characters): it is stored in that row only, never printed, logged or put on an event. A production write needs `--i-am-authorised-to-write-to-production` and `OPS_ALLOW_PRODUCTION=recompute-numbers`.

## `GET /admin/numbers/out-of-credits`

The telecaller's CALL LIST (metric group 10, part C): the companies whose usable balance is zero now, newest first by the moment they ran out, keyset paged. A read: it writes nothing; the only event is the identity read's own `admin.identity_viewed` when names are disclosed.

| Query    |                                                                                                   |
| -------- | ------------------------------------------------------------------------------------------------- |
| `limit`  | `1`..`100`, default `50`; a page that will carry names is clamped to 50 (the identity bound)      |
| `cursor` | the previous page's `next_cursor`; a cursor that does not decode is the first page, never a `500` |
| other    | any other key is `400` (strict)                                                                   |

- **Who is on it.** Countable companies (not a test company, not a sample company, not `archived`) whose USABLE balance is zero: `payer_credits.balance` minus the credits their `credit_lots` past `expires_at` still hold, never below 0. That is the unlock path's `readSpendableCredits` rule (packages/db `credit-wallet.ts`), spelled as ONE read-only set query over `payer_credits` and `credit_lots`: the wallet code reads one wallet per call, and the DB gate proves the two agree wallet by wallet. The wallet key is the company id (the tenant key).
- **When it ran out** (`ran_out_at`): the later of its last `payer.credits_exhausted` (emitted on the debit that spent its last credit, read through `AdminEventsRepository`) and the `expires_at` of its newest lot that EXPIRED HOLDING CREDITS (past its date and still holding, or swept with `expired_at` stamped). A lot spent to zero before its date is not an expiry. A company with neither never ran out and is not listed (a zero wallet that never held a credit).
- **Order:** `ran_out_at` descending (to the millisecond), then the payer id descending; the cursor is that keyset. A company that spends its last credit is at the top.
- **No phone, on any path.** The phone stays on the User accounts surface (`GET /admin/accounts`, `manage_payer_credentials`); `accounts_link_hint: true` tells the screen to link there.
- **The name** (`org_name`) is PRESENT only when the admin holds `read_identity` and `AdminIdentityService` disclosed names (surface `payers`: the egress cap, `admin.identity_viewed` committed, then the decrypt); `null` when none is on record; ABSENT otherwise.
- **The call log missing** (its migration not applied, 42P01): every row `last_call: null`, one warning per process. A missing source table (`credit_lots`) is a `503`.

Response `200`:

```ts
{
  rows: {
    payer_id: string;
    ran_out_at: string; // ISO
    last_purchase: { at: string; pack_code: string | null } | null; // the last paid order: settle time and pack
    last_open_at: string | null; // the newest unlock granted (granted / revealed / expired)
    last_call: { called_at: string; result: CreditCallResult; admin_id: string } | null;
    org_name?: string | null; // read_identity only
  }[];
  next_cursor: string | null;
  accounts_link_hint: true; // the phone is on GET /admin/accounts
}
```

## `POST /admin/numbers/out-of-credits/:payerId/calls`

Log one call to a company on the list. The row is `credit_call_log`: the company, the admin, the time and ONE closed result code; no note or free text.

|                 |                                                                                                              |
| --------------- | ------------------------------------------------------------------------------------------------------------ |
| Path            | `payerId`, a uuid                                                                                            |
| Body (strict)   | `{ result: "reached_will_buy" \| "reached_not_now" \| "reached_declined" \| "no_answer" \| "wrong_number" }` |
| Idempotency-Key | REQUIRED header, 8–200 of `A-Z a-z 0-9 . _ : -`; missing or malformed → `400` `idempotency_key_required`     |
| Unknown company | `404` (a test or sample company too)                                                                         |
| Key reused      | `409` `idempotency_key_reused`: the same key already logged a call for another company or result             |
| Schema behind   | `503` (the call log is missing: fail closed, nothing written)                                                |

Response `201`: `{ call: { id, payer_id, called_at, result, admin_id }, created: boolean }`. The row's id is derived from the admin and the key, so a retry is a replay: `created: false`, the stored call, nothing written or emitted again. A new call commits the row, `admin.credit_call_logged` `{ payer_id, call_id, admin_id, result }` and `admin.action_performed` (`credit_call_logged`) in one transaction.

## `PUT /admin/numbers/test-accounts/:payerId`

Mark a company as a test company: it stays out of every company figure. The mark is `payers.is_test_account` (migration 0162), the one company test marker; the rows a test company creates copy it.

|                 |                                                                                                          |
| --------------- | -------------------------------------------------------------------------------------------------------- |
| Path            | `payerId` — a uuid, the company's id as the admin Companies page shows it                                |
| Body (strict)   | `{ reason: "synthetic_sign_in" \| "staff" \| "rehearsal" \| "pilot_test" }`                              |
| Idempotency-Key | REQUIRED header, 8–200 of `A-Z a-z 0-9 . _ : -`; missing or malformed → `400` `idempotency_key_required` |
| Unknown company | `404`                                                                                                    |
| Schema behind   | `503` (the column is missing: fail closed, nothing written)                                              |

Response `200`: `{ payer_id: string; is_test_account: true; changed: boolean }`. `changed: false` means the company was already marked: nothing is written and nothing is emitted (its first reason stands; to change the reason, unmark and mark again). A real change commits the column, `admin.payer_test_account_marked` `{ payer_id, reason, admin_id }` and `admin.action_performed` (`payer_test_account_marked`) in one transaction; the key is part of the marked event's idempotency key.

## `DELETE /admin/numbers/test-accounts/:payerId`

The company counts again. No body. Response `200`: `{ payer_id: string; is_test_account: false; changed: boolean }`; `changed: false` when it was not marked. A real change emits `admin.payer_test_account_unmarked` `{ payer_id, admin_id }` and `admin.action_performed` (`payer_test_account_unmarked`). Unknown company `404`.

## The synthetic-sign-in backfill

`node apps/api/dist/admin/numbers/mark-synthetic-test-payers.cli.js [--apply] [--batch-size=<n>]` (`pnpm --filter @badabhai/api run backfill:synthetic-test-payers`). Dry run by default. It decrypts each unmarked company's sign-in email in process and marks the ones in the reserved `@e2e.badabhai.invalid` domain with reason `synthetic_sign_in` (the same write as the PUT; the event's `admin_id` is null and its actor `system`). It prints payer ids and counts only, never an email. A production write needs `--i-am-authorised-to-write-to-production` and `OPS_ALLOW_PRODUCTION=mark-synthetic-test-payers`.

## Notes on the definitions

### Completed profile (owner question 2)

The rule is the onboarding funnel's `profile_confirmed` step: the worker's current `worker_profiles` row (`CURRENT_PROFILE_ORDER`) is `confirmed`, so the two admin screens cannot disagree. A TRADE-FORM worker reaches it only through the app: finishing the form opens the building screen, which asks for a résumé; with no profile row the Resume cubit's #1371 self-heal calls `POST /profile/extract` (his latest session carries `form_kind`, so the row's `source` is `form`) and then `POST /profile/confirm`. Nothing on the server confirms a profile when a form is completed. A form worker who leaves before the building screen, whose extraction poll times out, or who already has an older unconfirmed chat profile row (the self-heal fires only when there is no row) is not counted, although his answers are saved. Changing the rule would change the funnel and the journey too (`admin-funnel.parity.db.test.ts` pins them together), so the gap is recorded here rather than fixed in the shared rule. The snapshot MEASURES it as the diagnostic `form_completed_unconfirmed`: per week, the countable workers whose first `profile.form_completed` falls in the week and whose current profile is not confirmed when the week is computed (numerator), over every countable worker who finished the form that week (denominator).

### Linked RVM identities

A `workers` row the Campus link (#2752) created has `status = 'pending'` and a `worker_origins` row with `kind = 'institute'` (`awaitingFirstSignIn`, `admin-worker-scope.ts`). It is left out of every worker figure until his first worker-app sign-in makes him active. A student who already used BadaBhai keeps his own row and is counted.
