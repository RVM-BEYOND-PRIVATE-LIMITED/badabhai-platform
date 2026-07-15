# Row Level Security (RLS) Plan — TODO, NOT finalized in Phase 1

> ⚠️ **Phase 1 does not finalize production RLS.** During Phase 1 the NestJS
> backend connects with the Supabase **service role** and is the only client that
> reads/writes these tables. No untrusted client connects directly yet. This
> document is the plan to implement before any direct-client access (Phase 2+).

## Principles

- Workers may access **only their own** data.
- Ops/admin access goes through the backend (service role), never raw client keys.
- The `events` table is **insert-only** from backend services; never client-writable.
- No direct client write to sensitive tables.
- Voice-note audio lives in a private Storage bucket with its own policies.

## Per-table plan (to implement later)

| Table                | Worker (own row)        | Backend (service role) | Notes                              |
| -------------------- | ----------------------- | ---------------------- | ---------------------------------- |
| `workers`            | read own (later)        | full                   | PII; no client write in Phase 1    |
| `worker_consents`    | read own (later)        | insert/read            | append-only; revoke via `revoked_at` |
| `worker_profiles`    | read own (later)        | full                   | confirm via backend                |
| `chat_sessions`      | read/insert own (later) | full                   |                                    |
| `chat_messages`      | read own; insert inbound (later) | full          | outbound written by backend        |
| `voice_notes`        | read own (later)        | full                   | audio in Storage, not in table     |
| `generated_resumes`  | read own (later)        | full                   |                                    |
| `events`             | **none**                | **insert only**        | never client-writable or readable  |
| `ai_jobs`            | **none**                | full                   | internal                           |
| `audit_logs`         | **none**                | insert only            | internal                           |
| `payers`             | **none** (B2B PII)      | full                   | payer **own** account only (Phase 2 payer-RLS); migration 0020 already `ENABLE`+`FORCE ROW LEVEL SECURITY`+`REVOKE ALL` so it is deny-by-default today |
| `agency_invites`     | **none**                | full                   | faceless agency supply-attribution INTENT (ADR-0022); `invited_worker_id` is a payer→worker handle, so migration 0025 ships `ENABLE`+`FORCE ROW LEVEL SECURITY`+`REVOKE ALL` (deny-by-default today). Phase-1 isolation = app-layer `assertPayerOwns(inviter_payer_id)`; per-payer DB-RLS is the open-GA gate (payer tenancy axis below) |
| `skill`              | **none**                | full                   | ADR-0030/TAX-1 canonical skill vocabulary (migration 0037); reference data, not per-worker. Ships `ENABLE ROW LEVEL SECURITY` in-model (deny-by-default; **RLS policies NOT finalized here** — service role today) |
| `skill_alias`        | **none**                | full                   | ADR-0030/TAX-1 embedded aliases (migration 0037); reference data + a `vector(768)` embedding, no worker link. `ENABLE ROW LEVEL SECURITY` in-model (RLS not finalized) |
| `unresolved_phrase`  | **none**                | full                   | ADR-0030/TAX-1 below-floor growth queue (migration 0037); **PSEUDONYMIZED phrase + count, NO `worker_id`** (aggregate → not a per-worker DSAR surface, ADR-0026). `ENABLE ROW LEVEL SECURITY` in-model (RLS not finalized) |

## Payer tenancy axis (ADR-0019 Decision C — added 2026-06-20)

The self-serve payer portal (ADR-0019, PR `feat/r16-payer-auth-wiring`) introduces a **second
principal with durable PII** (`payers` B2B contact data — the B-R2 class) and a **two-axis
isolation** requirement:

- **payer ↔ payer** — a payer may read/act on **only their own** `payer_id`-scoped rows
  (`posting_plans` / `posting_boosts` / `payer_credits` / `credit_ledger` / `unlocks` /
  `resume_disclosures` / `payer_capacity` / `agency_invites` — the last scoped by
  `inviter_payer_id`, ADR-0022). **Phase-1 enforcement is the APP-LAYER chokepoint**
  (`PayerAuthGuard` session identity + `payer-scope.ts` + the `UnlockService` ownership check,
  XB-A) — proven by the horizontal-authz tests. **DB-enforced per-payer RLS is the open-GA
  launch gate (XL-A)**, not built here: it needs either a least-privilege payer
  connection/role or a request-scoped `SET LOCAL app.payer_id` policy (land WITH the worker
  `current_worker_id()` mapping below; ADR-0019 C-R1 / Q5).
- **payer ↔ worker** — a payer **never** reads `workers` or any raw worker PII; worker identity
  reaches a payer ONLY via the masked, consented, capped disclosure chokepoint. `workers` stays
  FORCE-RLS + REVOKE (ADR-0004), unchanged.

> **Until DB-enforced payer RLS lands, external payer access stays STAGING / CLOSED-BETA only**
> (app-layer chokepoint is the enforced control). `payers` is already `ENABLE`+`FORCE`+`REVOKE`
> (migration 0020) so the service-role backend is the only reader today.

## Sketch (DO NOT enable blindly — review per environment)

```sql
-- Example shape for Phase 2+; worker identity will map to auth.uid().
-- ALTER TABLE worker_profiles ENABLE ROW LEVEL SECURITY;
-- CREATE POLICY worker_reads_own_profile ON worker_profiles
--   FOR SELECT USING (worker_id = current_worker_id());

-- events: lock down entirely from anon/authenticated; backend uses service role
-- ALTER TABLE events ENABLE ROW LEVEL SECURITY;
-- (no SELECT/INSERT policies for anon/authenticated => effectively no access)
```

## Storage buckets

Buckets are provisioned **out-of-band** (not via the Drizzle chain — plain Postgres in
CI/local has no `storage` schema). See [storage-buckets.md](storage-buckets.md) +
[storage-buckets.sql](storage-buckets.sql).

- `worker-resumes` — **PRIVATE**, signed-URL-only (TD5 / R13); object path
  `resumes/<worker_id>/<resume_id>/v<n>.pdf`. Idempotent SQL provided.
- `worker-conversations` (ADR-0003 / R10) and `voice-notes` (later) — same private model.
- Signed URLs issued by the backend (service role); no public/anon read.

## Checklist before enabling direct client access

- [ ] Define worker auth → DB identity mapping (`current_worker_id()`)
- [ ] Define payer auth → DB identity mapping (`current_payer_id()`) + per-payer policies on the payer-owned tables (ADR-0019 C / XL-A launch gate — app-layer chokepoint enforced in Phase 1)
- [ ] Enable RLS on every table and add explicit policies
- [ ] Verify `events`/`audit_logs`/`ai_jobs` are unreachable by anon/authenticated
- [x] Storage bucket policies + signed URL flow — `worker-resumes` private + signed-URL-only ([storage-buckets.md](storage-buckets.md)); `worker-conversations` / `voice-notes` pending
- [ ] Penetration test the policies
