# ADR-0026: Production worker auth — device-bound PIN + engagement-tiered rolling sessions + refresh rotation (on existing primitives)

- Status: Accepted
- Date: 2026-06-27
- Scope: `apps/api` worker-auth surface (`apps/api/src/auth/*`, `apps/api/src/sms/*`),
  `packages/db` (two new durable tables), `packages/event-schema` (new PII-free
  auth events), `packages/config` (new server-only env), and `apps/worker-app`
  (Flutter — persisted session, PIN, device id). A multi-PR **program**, sequenced
  in §Rollout; this ADR is the decision of record and gates the build.
- Relates to: the OTP stack (OTP-1..OTP-7, real-only Fast2SMS), [ADR-0014](0014-phase-1-schema-foundation-stable.md)
  (schema foundation), [ADR-0019](0019-self-serve-payer-portal.md)/[ADR-0022](0022-agency-supply-portal.md)
  (payer sessions share `JWT_SECRET`), [ADR-0023](0023-adopt-go-router-stateful-shell.md)
  (worker-app routing). Invariants engaged: CLAUDE.md §2 (PII), §3 (locked stack),
  §5 (real-call gating), §6 (consent gate), §7 (typed contracts), §8 (back-compat).

## Context

The worker app's auth today is a deliberately minimal single factor: phone → OTP
(real-only Fast2SMS) → a single rolling HS256 JWT + a Redis `session:<sid>` record
with one sliding TTL (`SESSION_TTL_DAYS`, default 30d). There is **no** PIN, no
device binding, no refresh-token rotation, no absolute session cap, no logout-all,
no device list, and the mobile session is **in-memory only** — every cold start
forces a full OTP, which on a real-only SMS path now **costs money per re-login**.

A full production-auth spec was proposed (phone-OTP registration + device-bound
4-digit PIN unlock + engagement-tiered rolling sessions + rotating refresh tokens
with reuse detection + SIM-swap defense). The spec's **default stack** (AWS KMS,
asymmetric ES256/RS256 + JWKS, Argon2id, MSG91/Gupshup/Twilio, Play Integrity) are
each CLAUDE.md §3 locked-stack changes and/or new real-provider integrations.

The product goal is approved: **a returning worker gets in within seconds via a
4-digit PIN, without re-paying for OTP, while the system stays resilient to
SIM-swap, device theft, OTP abuse, PIN brute-force, and token theft.** The
**posture is also approved: build the feature set on the primitives we already
have**, not the spec's new stack.

## Decision

Build the full feature set — **device-bound PIN unlock, engagement-tiered rolling
sessions with a hard absolute cap, opaque rotating refresh tokens with reuse
detection + token families, logout-all, device list, and DPDP account deletion —
on the EXISTING primitives.** The spec's security *principles* (§3 of the spec:
PIN-never-authenticates-from-scratch, server-side throttled PIN, slow-KDF hashing,
rotation + reuse detection, device binding, hard absolute cap, enumeration safety,
fail-closed) are all **kept**; only the spec's *stack choices* are reconciled to
what BadaBhai already runs.

### Reconciliations (explicit deviations from the spec's §1/§3 defaults — decided here per spec §19 "ask before deviating")

| # | Spec default | This repo (decided) | Why |
|---|---|---|---|
| R1 | Asymmetric ES256/RS256 + published JWKS | **HS256** (existing `JWT_SECRET`), alg pinned | No JWKS/KMS dep now. Access JWT becomes short-TTL; the opaque refresh token is the long-lived credential. JWKS is a **future** hardening ADR (also touches payer sessions — shared secret). |
| R2 | AWS KMS for keys + PIN pepper | **Env secrets** via `packages/config` server schema + fail-closed `assert*` guards | KMS is a §3 infra dep; deferred to its own ADR. Mirrors existing `PII_ENCRYPTION_KEY`/`PII_HASH_PEPPER`. |
| R3 | **Argon2id** PIN hash | **Node stdlib `crypto.scrypt`** (memory-hard, OWASP-listed) + per-user random salt + a dedicated server pepper | Delivers the spec §3 *non-negotiable* (slow KDF + per-user salt + server pepper) with **zero new dependency**. Hashing is behind an interface; an Argon2id swap (rehash-on-verify) is a future option. **This is the one §3-wording deviation — flagged in tech-debt.** |
| R4 | MSG91 / Gupshup / Twilio | **Fast2SMS (DLT)** behind the existing `SmsProvider` seam | Already the live, real-only, security-reviewed provider with caps + global spend kill-switch. The spec's "SmsProvider interface" already exists. |
| R5 | Play Integrity device attestation | **Deferred** — `worker_devices` carries an `attestation` placeholder, never gated on | Real attestation = new external provider (§7). Phase-2-of-program at earliest, own ADR. |
| R6 | New Postgres `sessions` / `refresh_tokens` / `otp_challenges` / `auth_audit_log` | **Redis live-state + the `events` table as the durable PII-free audit spine** (existing invariant §1) | Matches the current architecture. A Redis flush forcing re-OTP is already the status quo and is **fail-closed safe**. Durable audit is the events spine, not a parallel table. |
| R7 | New `users` + `consents` identity/consent tables | **Reuse `workers` (identity + `phone_hash` blind-index) and `worker_consents`** | The spec's "phone blind-index + encrypted at rest" is **already implemented** on `workers`. A second PII/identity table would **violate invariant §2** (raw worker PII lives ONLY in `workers`). |

### What we *do* add (durable, additive, reversible)

Only two new Postgres tables — where a Redis flush must **not** lock workers out or
lose security-critical state:

- **`worker_credentials`** — `worker_id` (FK→workers, unique), `pin_hash` (scrypt),
  `pin_salt`, `pin_algo` (`'scrypt-v1'`, for future rehash), `pin_updated_at`,
  `failed_attempt_cycles` (durable lockout-escalation counter), timestamps. The PIN
  hash must survive a Redis flush (else every worker is locked out). **No PIN/PIN-hash
  ever enters events, `ai_jobs`, `audit_logs`, or logs (§2).**
- **`worker_devices`** — `id` (uuid), `worker_id` (FK→workers), `device_hash`
  (HMAC of the client device id — never the raw fingerprint), `platform`, `model`,
  `app_version`, `attestation` (placeholder, default `'none'`), `trusted_at`,
  `last_seen_at`, `revoked_at?`. Durable so device-list + binding survive a flush.

Everything else is **Redis live-state + events**:

- **Engagement-tiered rolling session** — the Redis `session:<sid>` record is
  extended with `created_via_otp_at`, `absolute_expiry` (= `created_via_otp_at` +
  `ABSOLUTE_MAX`, default **90d**), `active_days` (distinct IST dates within the
  trailing `TIER_WINDOW`, default 60d), `tier`, `device_hash`. On every
  refresh/pin-unlock (one Lua/transactional step): prune `active_days`, add today,
  `tier = tier_for(count)`, `idle_ttl = TIER_IDLE_TTL[tier]`, set session TTL =
  `min(now + idle_ttl, absolute_expiry)`; **reject (force OTP) once past
  `absolute_expiry`** — only OTP resets that clock. The access JWT carries `tier`
  and `did`. Tiers (config-tunable): `0:<3d→7d`, `1:3–9d→14d`, `2:10–29d→30d`,
  `3:≥30d→60d`.
- **Opaque rotating refresh token** — 256-bit random; stored only as
  `refresh:<sha256>` → `{sid, family_id, did, used, supersededBy, expiresAt}` in
  Redis (token value never persisted/logged — like the OTP HMAC). Each
  refresh/unlock **rotates** (mints a new token, marks the old `used`, links
  `supersededBy`). Presenting an **already-used** token ⇒ **reuse detected** ⇒
  revoke the whole `family_id` ⇒ emit `worker.refresh_reuse_detected` (PII-free) ⇒
  force full OTP. An **`Idempotency-Key`** + short grace window returns the same
  rotated token for an honest double-refresh (flaky-network retry) instead of
  nuking the family.
- **PIN unlock** — `POST /auth/pin/verify {device_id, refresh_token, pin}`:
  validate the device-bound refresh token first, then scrypt-verify the PIN with a
  **server-side Redis throttle** (per worker+device: failed-attempt cap → timed
  lockout → exponential backoff; after K cycles invalidate the PIN and force OTP +
  PIN reset). A correct PIN does **nothing** without a valid device-bound refresh
  token — it never authenticates from scratch. New device ⇒ no trusted token ⇒ OTP;
  after OTP on an **existing** account, **still require the account PIN** before
  granting access (SIM-swap defense).

### New endpoints (worker-scoped, reuse `WorkerAuthGuard`/`ConsentGuard`; identity from token, never body)

`POST /auth/token/refresh` (silent, `Idempotency-Key`), `POST /auth/pin/set`,
`POST /auth/pin/verify`, `POST /auth/pin/reset/request`, `POST /auth/pin/reset/confirm`,
`POST /auth/logout-all`, `GET /auth/devices`, `DELETE /auth/devices/:id`,
`GET /auth/session` (tier/expiry introspection), `DELETE /account` (DPDP erasure,
step-up OTP). Existing `/auth/otp/request`, `/auth/otp/verify`, `/auth/refresh`
(kept working during cutover), `/auth/logout`, and `POST /consent/accept` are
reused; OTP verify additionally registers the device and may return
`requires_pin`/`registration_token`.

### New events (registered + versioned in `@badabhai/event-schema`, PII-free)

`worker.pin_set`, `worker.pin_verified`, `worker.pin_locked`, `worker.pin_reset`,
`worker.device_registered`, `worker.device_revoked`, `worker.session_refreshed`,
`worker.refresh_reuse_detected`, `worker.logged_out_all`, `worker.account_deleted`.
Payloads carry `worker_id` + opaque ids/hashes (`device_hash`, `session id`,
`family_id`) **only** — never phone, PIN, device fingerprint, or token value.

## Rollout (each phase = its own gated, backward-compatible PR; expand→migrate→contract)

0. **This ADR + registers** — no behavior change.
1. **Session core** — access/refresh split (short access JWT + opaque rotating
   refresh in Redis) + reuse detection + idempotency grace; tiered rolling session
   + 90d absolute cap; `POST /auth/token/refresh`, `POST /auth/logout-all`,
   `GET /auth/session`; new events. `/auth/refresh` stays valid (compat).
   **Gate-flip note:** when `AUTH_ROLLING_TIERS_ENABLED` is flipped ON over sessions
   created before the flip (records with no `created_via_otp_at_ms`), the 90d absolute
   cap anchors from the **first post-flip touch**, not the original OTP time — a
   deliberately lenient migration (those records previously had no cap at all; it can
   only grant, never shorten, and never revive a *deliberately-revoked* session, which
   has no record to default). New (post-flip) sessions anchor at real OTP time. The OTP
   anchor is persisted on the **refresh-token** record so an idle-lapsed-then-refreshed
   session inherits the original clock (the hard cap is not resettable without OTP);
   a deliberate logout/logout-all deletes the refresh lineage so its tokens cannot
   resurrect the session.
2. **Devices** — `worker_devices` table + registration on OTP verify; `did` claim;
   `GET`/`DELETE /auth/devices`.
3. **PIN** — `worker_credentials` + scrypt set/verify/reset + throttle/lockout +
   SIM-swap PIN gate; weak-PIN denylist (`1234`/`1111`/sequences).
4. **Mobile** — `flutter_secure_storage` (refresh token + device id), PIN set/unlock
   screens, splash session-resume, refresh-on-401, logout/logout-all UI. *(On-device
   secret storage = security-review trigger; new dep.)*
5. **DPDP account deletion** (`DELETE /account`, step-up OTP, actor-scoped cascade)
   + OpenAPI 3.1 spec + security/threat-model + runbook doc.

## Consequences

- **Backward-compatible:** the two new tables are pure additions (reversible); the
  Redis session record gains fields (old records default safely); existing HS256
  JWTs + `/auth/refresh` keep validating through cutover. No column drop, no event
  payload mutated (new versioned events only) — §8 satisfied.
- **Cost:** PIN unlock + persisted device sessions eliminate the per-cold-start OTP
  spend that real-only Fast2SMS now incurs — the main motivation.
- **PII boundary intact (§2):** identity stays in `workers`; PIN material stays in
  `worker_credentials`; device records key off an HMAC, not the raw fingerprint; all
  new events are PII-free. Pseudonymization/LLM path (§3 of CLAUDE.md) is untouched —
  auth never calls an LLM.
- **Deferred (own ADRs + tech-debt):** AWS KMS (R2), asymmetric JWT + JWKS (R1),
  Argon2id upgrade (R3), Play Integrity attestation (R5). None block this program.
- **Residual risks (risks register):** a 4-digit PIN's 10k space leans entirely on
  the scrypt cost + server throttle + device binding; SIM-swap is mitigated (post-OTP
  PIN gate) but not eliminated; refresh-token theft is mitigated by rotation + reuse
  detection but a single in-grace replay is possible by design.

## Alternatives rejected

- **Adopt the spec's stack as-is (KMS/JWKS/Argon2/Play-Integrity/Twilio)** — rejected
  for now: four simultaneous §3 locked-stack changes + real-provider escalations for
  a Phase-2 feature; the security *properties* are achievable on existing primitives.
- **A parallel `users`/`consents`/`auth_audit_log` schema (spec §10 verbatim)** —
  rejected: forks identity into a second PII location (§2 violation) and duplicates
  the `worker_consents` + `events` spine already in use.
- **Keep single-factor OTP-only** — rejected: re-OTP on every cold start now costs
  real money and gives poor UX for low-literacy returning workers.
