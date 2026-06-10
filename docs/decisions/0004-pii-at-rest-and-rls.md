# ADR-0004: Worker PII hardening — encryption at rest, keyed hashing, and RLS

- **Status:** Accepted
- **Date:** 2026-06-10
- **Supersedes/relates:** schema PII note in `packages/db/src/schema.ts`; pays down **TD3/TD4**; opens **TD20–TD23**. Distinct from ADR-0003 (conversation-storage boundary), which shipped concurrently.

## Context

Raw worker PII lives only in the `workers` table (phone, and later `full_name`).
Before this change:

- `phone_e164` was stored **plaintext**.
- `phone_hash` was an **unsalted SHA-256** of the number — brute-forceable, since
  a phone has ~10 digits of entropy (the `crypto.ts` TODO already flagged this).
- **RLS was not enforced** (TD4), so anyone with DB or Supabase-key access could
  read the number.

The platform must keep the real number (to contact/OTP workers), so one-way
hashing of the stored value is not an option — it must be *reversibly* protected
and *access-controlled*.

## Decision

Three layers, all on `workers`:

1. **Encryption at rest — application-level AES-256-GCM.** `phone_e164` stores a
   self-describing token `v1.<iv>.<tag>.<ct>`. The key (`PII_ENCRYPTION_KEY`, base64
   of 32 bytes) lives only in backend config and **never touches the database**, so
   a full DB compromise does not reveal numbers. Chosen over Supabase **pgsodium TCE**
   (deprecated on Supabase) and over **pgcrypto** (key would transit the DB session).
   GCM is authenticated (tamper-evident). The IV is random per call → ciphertext is
   non-deterministic, so the plaintext **unique index was dropped** and dedup/lookup
   moved to the hash.
2. **Keyed hashing — HMAC-SHA256 with a server pepper.** `phone_hash`/`ip_hash` use
   `HMAC(PII_HASH_PEPPER, "phone:"+e164)`, domain-separated, not brute-forceable
   without the pepper. This is the stable lookup/dedup key and the only phone
   derivative allowed in events.
3. **Row-Level Security.** `workers` has RLS **enabled + FORCE**, and **all grants
   revoked from `anon`, `authenticated`, `service_role`, and `PUBLIC`**. The backend
   connects as the `postgres` role (Supabase session-pooler `postgres.<ref>`, which
   has `BYPASSRLS`) over a **direct Postgres connection** — distinct from the PostgREST
   `service_role` used by the Data API. Because a `BYPASSRLS` role ignores RLS, the
   *effective* control is the **REVOKE** (RLS-without-policies is deny-by-default for
   non-bypass roles). Verified live: SQL `SET ROLE anon/authenticated/service_role` →
   `42501`; `GET /rest/v1/workers` with the service-role key → **HTTP 403**.

Supporting pieces: `PiiCryptoService` centralizes the secrets; `assertPiiCryptoConfig`
**fails closed** — the dev defaults (public pepper + all-zero key) are accepted only
when `NODE_ENV` is *explicitly* `development`/`test` (unset/staging/prod must supply
real secrets), and an all-zero key is rejected outright. Migrations `0003` (enable RLS +
drop the plaintext-phone unique index; also carries the interview `conversation_state`
column) and `0004` (FORCE + revoke all client-facing roles: `anon`, `authenticated`,
`service_role`, `PUBLIC`). These were regenerated on top of ADR-0003's `0002` storage
migration during integration, so the numbering follows it; `0003`'s DDL is
`IF EXISTS`/`IF NOT EXISTS`-guarded so a single `db:migrate` converges a drifted database
(e.g. the live Supabase mid-integration, which already had RLS + the dropped index but
was missing `conversation_storage_path`) in one idempotent pass — no manual
`__drizzle_migrations` edits. `drizzle.config.ts` now loads the repo-root `.env`, and the
DB password must be URL-encoded (a `@` → `%40`) or `drizzle-kit migrate` mis-parses it.

## Consequences

- A full read of the `workers` table (or the Data API) yields ciphertext + a keyed
  hash — useless without the backend secrets. The blast radius of a DB/key leak is
  reduced to "DB **and** app-config compromised together".
- The whole app now depends on `DATABASE_URL` being a `BYPASSRLS` role; if it is ever
  pointed at a least-privilege role, `workers` becomes deny-all (no policy). The e2e
  exercises a real read/write as the regression guard.
- `decrypt()` has no Phase-1 read site (write-only store today); retained for future
  SMS/contact use and key-rotation backfill.

## Follow-ups (tracked)

- **TD20** — extend RLS+REVOKE to the rest of the spine (events/ai_jobs/audit_logs/
  worker_* tables). Mechanical and verified-safe (no Data API consumers); left out only
  to honor the "workers" scope of the request.
- **TD21** — encrypt `full_name` before any write site exists.
- **TD22** — key-rotation runbook + a `kid` in the token; the pepper is effectively
  un-rotatable without a full rehash; document DPDP crypto-shred (drop the key).
- **TD23** — make `verifyOtp` insert idempotent (`on conflict (phone_hash)`).
- Out of scope but adjacent: wide-open CORS (`main.ts` TODO), secrets manager (TD10).
