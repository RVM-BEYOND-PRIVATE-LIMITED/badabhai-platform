# Admin API — candidate full detail (`GET /admin/candidates/:id`)

Issue #2560 (plan B6) · ADR-0062 §2, §3.8, §3.9 · code: `apps/api/src/admin/admin-candidate-detail.*`

One candidate's record exactly as employers and the résumé read it, where every value came from, the résumé versions and the account state. Read-only.

## Request

|               |                                                                       |
| ------------- | --------------------------------------------------------------------- |
| Method / path | `GET /admin/candidates/:id`                                           |
| `:id`         | worker uuid (zod `uuid`, `.strict()` params) — anything else is `400` |
| Auth          | admin session (`AdminAuthGuard`) + `AdminRolesGuard`                  |
| Capability    | `read_candidates` — super_admin, ops_admin, support, analyst          |
| Headers out   | `Cache-Control: no-store` (always)                                    |

## Errors

| Status | When                                                                                                                                          |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `400`  | `:id` is not a uuid                                                                                                                           |
| `401`  | no / expired admin session                                                                                                                    |
| `403`  | role without `read_candidates` (none of the four today)                                                                                       |
| `404`  | no such worker — body `{"message":"Worker not found"}`, the same as `GET /admin/workers/:id`. Nothing is audited and no name budget is spent. |
| `5xx`  | the audit event could not be written, or any read failed — no partial record is ever returned                                                 |

## Audit

Every successful view emits `admin.candidate_viewed` v1 — payload `{ admin_id, worker_id }`, subject `worker` — after the 404 check and **before** any profile value is read or any name is decrypted. A failed emit fails the request.

A disclosed name additionally emits `admin.identity_viewed` (surface `workers`) through `AdminIdentityService`, under the existing per-admin entity name budget.

## Names

`identity.name` follows the identity rules: only an admin holding `read_identity` (super_admin, ops_admin, support) within budget sees it. Otherwise `name.value` is `null` and `name_disclosed` is `false` — no error. The phone and the WhatsApp number are never on this surface.

## Field shape

Every field is

```ts
{
  value: T;
  source: FieldSource;
  correction: FieldCorrection;
}
type FieldCorrection = {
  override_id: string;
  admin_id: string;
  reason_code: string;
  created_at: string;
} | null;
```

`correction` is always `null` until #2561 adds the correction layer. `reason_text` is never part of this response.

### `source` (closed enum, `FIELD_SOURCES` in `worker-field-precedence.ts`)

| Value           | Meaning                                                                                                                                                                                                                     |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `interview`     | the AI profiling interview — a chat-road profile row, a `chat`/`chip` pack answer, or an `llm_parse` attribute                                                                                                              |
| `form`          | the trade form or the general form                                                                                                                                                                                          |
| `resume_import` | a CV the worker uploaded and accepted                                                                                                                                                                                       |
| `worker_edit`   | the worker's own answer through a worker-route writer (onboarding name/location screen, profile-edit pages, finishing-form preferences write, a confirmed Bada Bhai chat edit — they stamp no marker that tells them apart) |
| `ops`           | an operator-authored row (`worker_skill.source='ops'`, an `ops` pack answer); #2561's corrections will report here                                                                                                          |
| `derived`       | computed by the platform — the match derivation, the occupation matcher, a default                                                                                                                                          |
| `none`          | nothing is stored (always the source of an empty value)                                                                                                                                                                     |
| `unknown`       | a value is stored but its row cannot say which writer put it there                                                                                                                                                          |

There is no `chat` member: a confirmed chat edit lands through the same writers as the profile-edit screens and is reported as `worker_edit`.

Fields that report `unknown` whenever they hold a value: `identity.name` (worker and ops routes both write it), `identity.resume_show_photo` (NOT NULL default), `identity.preferred_language`, `trade.secondary_roles` and `education.training` (the worker's page and the interview's insert-only fallback write the same rows), `employer_card.trade_levels`, `preferences.night_shift_ready` (worker toggle or seeded from the shift answer), and any attribute-backed field whose pack-backed row has no matching pack answer.

## Groups

| Group           | Contents                                                                                                                                                                                                                                                                                                                                              | Values computed by                                                                                                                                      |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `identity`      | `name`, `name_disclosed`, `has_photo`, `resume_show_photo`, `preferred_language`                                                                                                                                                                                                                                                                      | `AdminIdentityService`; worker core                                                                                                                     |
| `location`      | `current_city`, `current_state`, `preferred_locations`                                                                                                                                                                                                                                                                                                | `resolveCityForSummaryWithSource`; `readPreferenceFacts`                                                                                                |
| `trade`         | `canonical_trade_id`, `canonical_role_id`, `display_name`, `job_domain`, `secondary_roles`                                                                                                                                                                                                                                                            | `toProfileSummary`; current profile's occupation match                                                                                                  |
| `employer_card` | `in_search_pool`, `is_sample`, `role`, `other_roles`, `role_months`, `industry`, `industry_months`, `city`, `trade_levels`                                                                                                                                                                                                                            | the payer search's own statement narrowed to this worker (`CandidateSearchRepository.findCardRow`) + `toCandidateRow`; empty when he is not in the pool |
| `skills`        | `skills`, `machines`, `match_skills[]` (`worker_skill` rows with their own source)                                                                                                                                                                                                                                                                    | `toProfileSummary`; `worker_skill`                                                                                                                      |
| `experience`    | `total_years`, `industry_tenure`                                                                                                                                                                                                                                                                                                                      | `toProfileSummary`; `worker_industry_tenure`                                                                                                            |
| `work_history`  | rows: city/state, start/end, duration_stated, roles (label, dates, `work_done`, `work_done_polished`, `work_done_polish_declined`)                                                                                                                                                                                                                    | `worker_employment(+_role)` — **no employer name** (encrypted at rest; not decrypted here)                                                              |
| `education`     | `headline`, `education`, `certifications`, `training`, `education_level`, `education_field`, `education_detail`, `education_credential`                                                                                                                                                                                                               | `qualificationFactsFrom`; `toProfileSummary`; `readPreferenceFacts` — no licence numbers                                                                |
| `languages`     | printed language lines                                                                                                                                                                                                                                                                                                                                | the résumé's rule: language rows win, else the `languages` attribute                                                                                    |
| `salary`        | `band {low, high}`, `period`, `open_top_chip`                                                                                                                                                                                                                                                                                                         | `resolveSalaryBandWithSource` (container wins outright, else the attribute band), `resolveSalaryPeriodWithSource`                                       |
| `preferences`   | `availability`, `shift`, `night_shift_ready`, `relocation`, `accommodation`, `job_type`, `work_types`, `commute_max_km`, `willing_to_travel`, `documents`                                                                                                                                                                                             | `readPreferenceFacts`, `resolveAvailabilityStateWithSource`, `resolveWorkTypesWithSource`                                                               |
| `resume`        | `versions[]` (≤ 50, newest first: `resume_id`, `version`, `generation_trigger`, `generation_source`, `render_status`, `template_id`, `has_pdf`, `generated_at`, `rendered_at`), `version_count`, `truncated`                                                                                                                                          | `generated_resumes` — **no download link, no PDF bytes, no storage key**                                                                                |
| `account`       | `status`, `verification_state`, `verified_at`, `is_test_account`, `is_sample`, `deletion_scheduled_at`, timestamps, `profile {status, source, confirmed_at, form_level}`, `consent {state, consent_version, accepted_at, purposes, employer_sharing}`, `devices {count, latest_app_version, last_seen_at}`, `flag {flagged, reason_code, flagged_at}` | worker core + one aggregate statement                                                                                                                   |
| `activity`      | `application_count` (applied), `skipped_count`, `recent_applications[]` (≤ 10 applied, via the admin application list), `unlock_count`                                                                                                                                                                                                                | `applications`, `unlocks`                                                                                                                               |

The printed résumé salary line and work-done text are composed by the render pipeline per road and kill-switch; this read returns the stored facts those are composed from.

## Example (fake data, abridged)

```json
{
  "worker_id": "0b7f1a52-4a0e-4c41-9d61-2f1f3c1e9a01",
  "identity": {
    "name": { "value": "Test Worker", "source": "unknown", "correction": null },
    "name_disclosed": true,
    "has_photo": { "value": true, "source": "worker_edit", "correction": null },
    "resume_show_photo": { "value": true, "source": "unknown", "correction": null },
    "preferred_language": { "value": "hi", "source": "unknown", "correction": null }
  },
  "location": {
    "current_city": { "value": "Pune", "source": "worker_edit", "correction": null },
    "current_state": { "value": "Maharashtra", "source": "worker_edit", "correction": null },
    "preferred_locations": {
      "value": ["Pune", "Chakan"],
      "source": "worker_edit",
      "correction": null
    }
  },
  "employer_card": {
    "in_search_pool": true,
    "is_sample": false,
    "role": {
      "value": { "id": "mskill_tig_welder", "label": "TIG Welder" },
      "source": "derived",
      "correction": null
    },
    "role_months": { "value": 48, "source": "derived", "correction": null },
    "city": { "value": "Pune", "source": "worker_edit", "correction": null }
  },
  "salary": {
    "band": {
      "value": { "low": 18000, "high": 22000 },
      "source": "worker_edit",
      "correction": null
    },
    "period": { "value": "month", "source": "worker_edit", "correction": null },
    "open_top_chip": false
  },
  "resume": {
    "versions": [
      {
        "resume_id": "d0d0d0d0-0000-4000-8000-000000000002",
        "version": 2,
        "generation_trigger": "chat_edit",
        "generation_source": "chat",
        "render_status": "rendered",
        "template_id": "bb_trade",
        "has_pdf": true,
        "generated_at": "2026-11-01T10:00:00.000Z",
        "rendered_at": "2026-11-01T10:00:00.000Z"
      }
    ],
    "version_count": 1,
    "truncated": false
  },
  "activity": {
    "application_count": 3,
    "skipped_count": 5,
    "recent_applications": [],
    "unlock_count": 2
  }
}
```

The full typed contract is `AdminCandidateDetailSchema` in `apps/api/src/admin/admin-candidate-detail.dto.ts`; the service parses every response through it (`.strict()`) before it leaves.

## Reads per request

One worker-core read (the 404), the audit insert, then one parallel wave of a fixed set of statements (profile, occupation match, attribute bag, attribute provenance, credentials ×3, languages, occupations, work history ×2, match skills, tenure, search card, wanted roles, stated rungs, résumé versions, account aggregate ×3, recent applications) plus the identity layer's own lookup when names are permitted. Never one statement per row.

## Tests

`admin-candidate-detail.{mapper,service,authz,contract}.test.ts`, `admin-candidate-detail.db.test.ts` (CI "DB-backed gates"), the `#2560` block in `admin-static-guards.test.ts`, `worker-field-precedence.with-source.test.ts`, `profile-field-sources.test.ts`, `packages/event-schema/src/admin-candidate-viewed.test.ts`.
