# Spec — `GET /workers/me/profile-summary` (TD54, worker-app home card)

> Half-page field spec for the worker-app's "my profile" summary card. Additive read route;
> no schema change, no new event. Guards: `@UseGuards(WorkerAuthGuard, ConsentGuard)` (same
> order as `PATCH /workers/me/name`); identity from `@CurrentWorker` — never a path/body id.

## Response (derived from the LATEST `worker_profiles` row via `WorkersRepository.latestProfile`; `strength` / `missing_fields` also fold in the worker's `worker_attributes`, see below)

| Field            | Source                                                                                                                                                                                                                                                          | Nullability / fallback                                                                                               |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `profile_status` | `worker_profiles.profile_status` (`draft \| extracting \| extracted \| confirmed`)                                                                                                                                                                              | never null (defaults `draft`); **no profile row yet ⇒ `"none"`**                                                     |
| `source`         | `worker_profiles.source` (`form \| chat`) — the road that produced the profile (Task 1, migration 0107)                                                                                                                                                         | `null` when unknown: no profile row yet, or a pre-0107 row. Clients must treat `null` as unknown, never as a road    |
| `confirmed_at`   | `worker_profiles.confirmed_at` (ISO-8601)                                                                                                                                                                                                                       | `null` until confirmed                                                                                               |
| `trade`          | `{ canonical_trade_id, canonical_role_id, display_name }`; `display_name` = `getRole(canonicalRoleId)?.name` (taxonomy) → else `resolveTradeContent(...)?.display_name` → else `null`                                                                           | every part nullable — extraction may not have canonicalized yet; client shows a "complete your profile" hint on null |
| `city`           | `workers.current_city` FIRST (#1428 — the worker own onboarding answer, owner ruling 2026-09-05), then `locationPreference.current_city`, then `locationPreference.preferred_cities[0]` (defensive `asObject` narrowing — the JSONB is untyped at the DB layer) | `null` when all three are absent/empty                                                                               |
| `strength`       | **recomputed** on read, `countFields`-equivalent over the stored row (see below)                                                                                                                                                                                | `0` when no profile                                                                                                  |

**`strength` recompute** (mirror of `profile-extraction.processor.ts#countFields`, over the stored row):
+1 `canonical_role_id`, +1 `canonical_trade_id`, +`skills.length`, +`machines.length`,
+1 `experience.total_years != null`, +1 salary min/max present, +1 `preferred_cities` non-empty,
+1 `availability.status !== "unknown"`, +1 photo uploaded. Deliberately **not stored** — no new
column, no drift. `missing_fields` names the slots that score 0, in that order.

**Form fold (#2257).** The trade form and the preferences page write `worker_attributes`, never
`worker_profiles`, so the summary also reads the worker's attribute rows
(`WorkersRepository.listSummaryAttributes`). A slot the profile row leaves at 0 scores **1** when
the worker's own answer fills it; a slot the row already scores is unchanged (fill-only, so
chat-road numbers are byte-identical). Role, trade and photo never fold. Rules
(`workers/profile-summary-form-slots.ts`):

| Slot           | Filled by                                                                                                       |
| -------------- | --------------------------------------------------------------------------------------------------------------- |
| `skills`       | pack answers that imply a taxonomy skill through `packAnswerEvidence` (the same table the skills rebuild reads) |
| `machines`     | the pack's machine/controller/equipment key (`PACK_MACHINE_KEYS`) holding a slug the résumé row would print     |
| `experience`   | the role's tier answer (`tenureQuestionKey`) under its own pack                                                 |
| `salary`       | `salary_expected_min` or `salary_expected_max` > 0                                                              |
| `location`     | `preferred_locations` non-empty                                                                                 |
| `availability` | `availability.status` in the closed `AVAILABILITY_STATUSES` set                                                 |

`qp_cad_drafting` and `qp_quality_inspection` ask no machine question, so their `machines` slot
stays open on the form road. A failed attribute read degrades to the profile-only score.
Presentation only: no ranking reads `strength` or `missing_fields`, and the displayed
`skills` / `machines` lists are still the profile row's.

## Explicitly DROPPED (do not build)

- **`verified`** — no such flag exists anywhere in the schema; do not invent one.
- **`name`** — ESCALATED, see below. The route ships **without** it; adding it later is additive.

## ESCALATION (invariant §2 boundary ruling) — **RULED 2026-07-14 · ALLOWED (narrow)**

`workers.full_name` is AES-256-GCM ciphertext. Question: **may the API decrypt `full_name` to
return it to the worker's OWN authenticated session** (`/workers/me/*`)?
Arguments for: it's the worker's own datum; the worker-app resume-edit screen must show the current
name so the worker can correct its spelling.
Arguments against: it creates the FIRST worker-session decrypt-and-return path — a new §2
egress class that widens the blast radius of a stolen worker token from opaque ids to raw PII.

**RULING (2026-07-14, recorded by Divyanshu — schema co-owner):** **ALLOWED, narrowly.**
The name is captured in a **separate, LLM-free step** precisely so it never reaches an LLM; the
§2 invariant it protects is **name → never LLM/event/`ai_jobs`/`audit_logs`/log**, which this path
upholds. Constraints on the allowance:

- **Own-session only** — identity from `@CurrentWorker`, never a path/body id; consent-gated.
- **Response-only egress** — the decrypted name appears in the HTTP response to the owner over TLS
  and **nowhere else**: never in an event, log, `ai_jobs`, `audit_logs`, or LLM input.
- **Fail closed** — decrypt failure DEGRADES name-less (no throw, no PII in logs).
- **First consumer:** `GET /workers/me/resume-fields` (this PR). This `profile-summary` route may
  stay name-less; adding the name to it later is additive and covered by the same ruling.

Supersedes TD21's "never RETURNED" wording for this own-session read (see TD21 note).
