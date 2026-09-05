# Spec — `GET /workers/me/profile-summary` (TD54, worker-app home card)

> Half-page field spec for the worker-app's "my profile" summary card. Additive read route;
> no schema change, no new event. Guards: `@UseGuards(WorkerAuthGuard, ConsentGuard)` (same
> order as `PATCH /workers/me/name`); identity from `@CurrentWorker` — never a path/body id.

## Response (all fields derived from the LATEST `worker_profiles` row via `WorkersRepository.latestProfile`)

| Field | Source | Nullability / fallback |
|---|---|---|
| `profile_status` | `worker_profiles.profile_status` (`draft \| extracting \| extracted \| confirmed`) | never null (defaults `draft`); **no profile row yet ⇒ `"none"`** |
| `confirmed_at` | `worker_profiles.confirmed_at` (ISO-8601) | `null` until confirmed |
| `trade` | `{ canonical_trade_id, canonical_role_id, display_name }`; `display_name` = `getRole(canonicalRoleId)?.name` (taxonomy) → else `resolveTradeContent(...)?.display_name` → else `null` | every part nullable — extraction may not have canonicalized yet; client shows a "complete your profile" hint on null |
| `city` | `workers.current_city` FIRST (#1428 — the worker own onboarding answer, owner ruling 2026-09-05), then `locationPreference.current_city`, then `locationPreference.preferred_cities[0]` (defensive `asObject` narrowing — the JSONB is untyped at the DB layer) | `null` when all three are absent/empty |
| `strength` | **recomputed** on read, `countFields`-equivalent over the stored row (see below) | `0` when no profile |

**`strength` recompute** (mirror of `profile-extraction.processor.ts#countFields`, over the stored row):
+1 `canonical_role_id`, +1 `canonical_trade_id`, +`skills.length`, +`machines.length`,
+1 `experience.total_years != null`, +1 salary min/max present, +1 `preferred_cities` non-empty,
+1 `availability.status !== "unknown"`. Deliberately **not stored** — no new column, no drift.

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
