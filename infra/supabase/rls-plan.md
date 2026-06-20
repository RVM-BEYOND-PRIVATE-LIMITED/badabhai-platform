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
| `unlocks`            | payer reads own `payer_id` (Phase 2) | full      | migration 0014 `ENABLE`+`FORCE`+`REVOKE ALL`; `worker_id` FK → RLS-locked `workers` |
| `payer_credits`      | payer reads own `payer_id` (Phase 2) | full      | migration 0014 `ENABLE`+`FORCE`+`REVOKE ALL`                    |
| `credit_ledger`      | payer reads own `payer_id` (Phase 2) | full      | migration 0014 `ENABLE`+`FORCE`+`REVOKE ALL`; append-only      |
| `unlock_routing`     | **none**                | full                   | migration 0014 `ENABLE`+`FORCE`+`REVOKE ALL`; server-internal routing only |

## Payer tenancy axis (ADR-0019 Decision C — added 2026-06-20)

The self-serve payer portal (ADR-0019, PR `feat/r16-payer-auth-wiring`) introduces a **second
principal with durable PII** (`payers` B2B contact data — the B-R2 class) and a **two-axis
isolation** requirement:

- **payer ↔ payer** — a payer may read/act on **only their own** `payer_id`-scoped rows
  (`posting_plans` / `posting_boosts` / `payer_credits` / `credit_ledger` / `unlocks` /
  `resume_disclosures` / `payer_capacity`). **Phase-1 enforcement is the APP-LAYER chokepoint**
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

### R16 / LC-1 self-serve close-out — table-level lock (added 2026-06-20)

Closing R16 / LC-1 (ADR-0019 Phase 1) retrofits the unlock + credit surface
(`/unlocks`, `/payers/:payerId/credits`) onto the **verified payer session**
(`PayerAuthGuard`) — so an EXTERNAL payer principal can now reach `payer_id`-scoped rows
where before only the service-role backend could. The two-axis isolation above is
unchanged; this records the **table-level deny-by-default lock** already in force for
every table that retrofit exposes, and pins what the OPEN-GA launch gate (XL-A / R20)
must add on top.

**What ships NOW (Phase 1) — the enforced control:** app-layer tenancy. `PayerAuthGuard`
binds `payer_id` from the verified session (JWT `sub` + revocable Redis `payer_session:<sid>`;
NO DB column), and every payer-owned read/write passes through the `payer-scope.ts`
chokepoint (`assertPayerOwns` / `assertOwnedRows` / `readOwnedById`) — a cross-tenant
access is a flat no-oracle 403. `UnlockService` adds the per-row ownership check on the
unlock spine. This is the control proven by the horizontal-authz tests (XB-A: payer A can
never read/buy against payer B's id).

**What DB-enforced RLS adds at OPEN GA (XL-A / R20) — defense in depth, NOT a replacement:**
per-payer row policies (a least-privilege payer connection/role or a request-scoped
`SET LOCAL app.payer_id`), landed WITH the worker `current_worker_id()` mapping. Until then
the backend connects directly as the `BYPASSRLS` `postgres` role, so these policies do not
affect Phase-1 service-role reads.

**Table-level lock already in force (the posting_plans pattern, migration 0016, mirrored):**
each table below ships `ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY` +
`REVOKE ALL ... FROM PUBLIC, anon, authenticated, service_role` in the SAME migration that
created it — so it is deny-by-default and never reachable via the PostgREST Data API even
briefly (the rls-spine no-drift + REVOKE-ALL regression covers it):

| Table            | Lock migration | Faceless-spine note                                                                 |
| ---------------- | -------------- | ----------------------------------------------------------------------------------- |
| `payers`         | 0020           | the ONLY payer-PII table; contact fields AES-256-GCM at rest + `email_hash` HMAC (ADR-0004 posture) |
| `unlocks`        | 0014           | `payer_id` opaque rail (no FK); `worker_id` FK → RLS-locked `workers`; no PII column |
| `payer_credits`  | 0014           | amounts + opaque `payer_id` only                                                     |
| `credit_ledger`  | 0014           | append-only; amounts + opaque `payer_id`; `payment_ref` opaque order id, never card/UPI |
| `unlock_routing` | 0014           | server-internal token → relay handle; raw phone read transiently at reveal, never stored |

```sql
-- The deny-by-default lock every payer-owned table already carries (posting_plans 0016 /
-- payers 0020 pattern). Applied in the table's CREATE migration — DO NOT re-apply blindly.
-- ALTER TABLE "payers" ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE "payers" FORCE ROW LEVEL SECURITY;
-- REVOKE ALL ON TABLE "payers" FROM PUBLIC;
-- REVOKE ALL ON TABLE "payers" FROM anon;
-- REVOKE ALL ON TABLE "payers" FROM authenticated;
-- REVOKE ALL ON TABLE "payers" FROM service_role;
-- (identical block for unlocks / payer_credits / credit_ledger / unlock_routing)
```

> **Faceless spine (unchanged).** Payer PII lives ONLY in `payers`, encrypted at rest
> (ADR-0019 B-R2 / ADR-0004). `events`, `ai_jobs`, `audit_logs`, and logs carry the opaque
> `payer_id` only — never the email/phone/org-name. The R16/LC-1 retrofit added NO PII to
> any other table (it is session-only: Redis OTP + JWT/Redis session, no new DB column).

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
- [x] Table-level deny-by-default lock on the payer-owned tables — `payers` (0020) + `unlocks`/`payer_credits`/`credit_ledger`/`unlock_routing` (0014) all `ENABLE`+`FORCE`+`REVOKE ALL` (PUBLIC/anon/authenticated/service_role); only the per-payer policies above remain for OPEN GA
- [ ] Enable RLS on every table and add explicit policies
- [ ] Verify `events`/`audit_logs`/`ai_jobs` are unreachable by anon/authenticated
- [x] Storage bucket policies + signed URL flow — `worker-resumes` private + signed-URL-only ([storage-buckets.md](storage-buckets.md)); `worker-conversations` / `voice-notes` pending
- [ ] Penetration test the policies
