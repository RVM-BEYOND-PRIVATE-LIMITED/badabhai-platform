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

---

## Phase 3 addendum (as-built) — device-unlock PIN

> Records the device-bound PIN **as actually built** (Rollout step 3). It does **not**
> rewrite the decision body above; it documents two reconciliations against the original
> Phase-3 text and the lockout state machine that landed. Code of record:
> [`pin.service.ts`](../../apps/api/src/auth/pin.service.ts),
> [`pin-hasher.service.ts`](../../apps/api/src/auth/pin-hasher.service.ts),
> [`pin.repository.ts`](../../apps/api/src/auth/pin.repository.ts),
> [`crypto.ts`](../../packages/db/src/crypto.ts) (`hashPin`/`verifyPin`),
> `worker_credentials` in [`schema.ts`](../../packages/db/src/schema.ts), migration **0030**.
> **Status: security-signed-off.** Two independent reviews returned **PASS-WITH-FINDINGS**
> (no Critical/High); all findings are addressed below (Findings 1 + 3 carry forward as a
> resolved fix + a documented, accepted residual respectively).

### Two reconciliations vs the original Phase-3 text

**(a) PIN hash storage + throttle durability.** The original text named `worker_credentials`
columns `pin_salt` + `pin_algo` (`'scrypt-v1'`) and a "server-side **Redis** throttle".
**As built:**

- The PIN hash is a **self-encoded scrypt token** `scrypt-v1.<salt_b64>.<derived_b64>`
  — the per-PIN random salt is **embedded in the token**, so there is **no `pin_salt`
  column** and the version prefix replaces a separate `pin_algo` column. A
  **`pepper_version`** integer column (default 1) carries pepper-rotation/rehash intent.
  The server pepper (`PIN_PEPPER`) is mixed into the KDF input and never stored.
- The throttle is **DB-durable + Redis-transient**, not Redis-only. `worker_credentials`
  carries durable `failed_attempts`, `locked_until`, `lockout_cycles`, **`otp_cycle_count`**;
  the *fast path* lives in a per-`(worker,device)` **transient** Redis key
  `pin_throttle:<workerId>:<deviceId>` `{ failed, lockedUntil, cycle }`. Chosen because the
  durable DB mirror **survives a Redis flush** — strictly stronger than a Redis-only throttle
  (a flush cannot reset the lockout ladder or revive a force-OTP'd PIN; see Finding 1).

**(b) SIM-swap PIN gate.** The original text described a post-OTP "PIN gate" / short-lived
`registration_token` / pin-challenge token. **As built**, the SIM-swap defense is a
**trusted-device requirement on `POST /auth/pin/verify`**: identity for verify is derived
from the **device-bound refresh token** the client already holds, resolved server-side
(`SessionService.resolveRefreshToken`) — there is deliberately **no `worker_id` field** on
the verify DTO. A new/unknown device has no trusted refresh token, so it **cannot PIN-unlock
and must OTP** (the existing login path is **byte-for-byte unchanged**). No separate challenge
token is minted. (The unused `PIN_CHALLENGE_TTL_SECONDS` knob remains for a future
challenge-token variant but is not on this path.)

### Lockout / force-OTP state machine (the core)

Per-`(worker,device)` transient `pin_throttle:<worker>:<device>` `{ failed, lockedUntil, cycle }`
in Redis, durably mirrored in `worker_credentials`:

1. **Wrong PIN** → `failed++`.
2. At **`PIN_MAX_ATTEMPTS`** (default 5) → arm an **exponential lockout**
   `PIN_LOCKOUT_BASE_SECONDS * 2^cycle` (default base 60s), `cycle++`, reset `failed`,
   and **durably mirror `lockout_cycles`**. Emits `worker.pin_locked{force_otp:false}`.
3. At **`cycle == PIN_MAX_LOCKOUT_CYCLES`** (default K=5, the *final* cycle) → atomically
   **bump durable `otp_cycle_count`** + mirror `lockout_cycles=K`, emit
   `worker.pin_locked{force_otp:true}` → the PIN is **invalidated until an OTP-gated reset**.
4. **Only a set/reset** zeroes `otp_cycle_count` (the `upsertPin` clears the whole throttle +
   force-OTP state; a *successful verify* clears the throttle but **leaves `otp_cycle_count`**,
   so a lucky correct PIN can never un-invalidate a force-OTP'd account).

The verify **force-OTP gate reads the DURABLE columns** —
`otp_cycle_count >= 1 || lockout_cycles >= PIN_MAX_LOCKOUT_CYCLES` — so force-OTP **survives a
Redis flush**. (We check `otp_cycle_count >= 1`, not `>= K`: that counter starts at 0 and reaches
1 on the first exhaustion.)

**Finding 1 fix (Redis-flush rehydration).** On a Redis miss/eviction/read-error for a worker
whose durable `lockout_cycles > 0` (mid-ladder, below K — the final cycle is already caught by
the durable force-OTP gate above), the transient is **rehydrated from `lockout_cycles`**: the
cycle is **preserved** and the current cycle's backoff window is **re-imposed**, then persisted.
A flush therefore costs the attacker a lockout — it can **never** reset the ladder to cycle 0
with a fresh, zero-wait attempt budget.

### scrypt vs Argon2id (R3 / TD55)

scrypt (Node stdlib, `N=2^15, r=8, p=1` ≈ 32MB) is the **as-built KDF** — memory-hard,
OWASP-listed, **zero new dependency**. The version-prefixed token (`scrypt-v1.…`) **plus** the
`pepper_version` column make an **Argon2id swap a non-breaking rehash-on-verify**: `PinHasher.verify`
branches on the stored version and fails closed on an unknown one, so a future v2 row is never
coerced to "verified", and a successful v1 verify can rehash to v2 transparently. **Argon2id stays
deferred in [TD55](../registers/tech-debt-register.md)** (with R1 JWKS / R2 KMS / R5 Play Integrity);
nothing here builds it.

### Neutral no-oracle + residual timing note (Finding 3)

Every negative path — **wrong PIN, locked, untrusted/revoked device, no-PIN-set, force-OTP** —
returns the **identical neutral 401** (`"Could not verify PIN"`, no body/status/field oracle).
Ops still gets distinct **PII-free** events/logs (the failure *reason* is a static log code,
never placed in an event payload, which stays the two-uuid shape).

- **Residual (accepted, Finding 3):** the **untrusted-device**, **locked**, and **force-OTP**
  paths return **before** the scrypt verify, so a latency probe can distinguish device-trust /
  lockout **STATE** from a wrong PIN. This is **not a PIN-value oracle** — it leaks only state the
  refresh-token holder already controls and that is independently observable (an untrusted device
  must OTP regardless; a lockout is the intended UX signal). Padding `locked`/`untrusted` with a
  throwaway 32MB-scrypt would hand an attacker a **CPU/memory amplification lever**, so it is
  **deliberately not padded**. The no-PIN-set and wrong-PIN paths *do* run an equivalent-cost
  scrypt to keep their timing uniform.

### Endpoints + events as built

- `POST /auth/pin/set` — `WorkerAuthGuard`; worker id from the token (never a body field);
  format + denylist (`pin-hasher.service.ts`: all-same-digit, ±1 runs, small explicit list) →
  scrypt hash → `upsertPin` (clears throttle) → `worker.pin_set`. 204.
- `POST /auth/pin/verify` — **no guard**; the device-bound **refresh token IS the credential**;
  identity + trusted device resolved server-side. Login-shape session on success
  (`SessionService.create`), neutral 401 otherwise.
- `POST /auth/pin/reset/request` + `POST /auth/pin/reset/confirm` — **reuse the existing OTP
  channel** (`AuthService.requestOtp` / `OtpService.verify`); worker resolved by **phone hash**
  after OTP verify, never a body id; new PIN set + `worker.pin_reset`.

Events (all **v1**, registered in [`@badabhai/event-schema`](../../packages/event-schema/src/registry.ts)):
`worker.pin_set`, `worker.pin_verified`, `worker.pin_verify_failed`, `worker.pin_locked`,
`worker.pin_reset` — **PII-free by construction**: opaque `worker_id` / `device_id` (the
`worker_devices.id` row uuid) + bounded ints/bools (`lockout_cycle`, `force_otp`) only; never the
PIN, `pin_hash`, raw device fingerprint, or phone (`.strict()` payload backstops).

### §2 boundary

`pin_hash` (scrypt), the raw PIN, the pepper, and the raw device fingerprint **never** enter
events, `ai_jobs`, `audit_logs`, logs, or LLM input. `worker_credentials` stays **RLS-FORCED**
(service role bypasses RLS today per [rls-plan.md](../../infra/supabase/rls-plan.md); every repo
method is `worker_id`-scoped). Migration **0030** (adds `otp_cycle_count` + `pepper_version`) is
**additive / reversible** — no column drop, no event-payload mutation (§8). Auth never calls an
LLM, so the pseudonymization gate (CLAUDE.md §3) is untouched.

## Phase 5 addendum (as-built design) — DPDP worker-initiated account deletion

- Addendum status: **Design accepted; build gated** (the destructive endpoint + any
  `onDelete` migration are §7 escalations — see decision 7). Date: 2026-06-29.
- Scope: `apps/api/src/auth/*` (new endpoints on the existing `AuthController`),
  `packages/event-schema` (one new PII-free event), `packages/db` (one `onDelete`
  posture change on two billing tables — **flagged, see decision 3**), and
  `apps/api/src/storage` (one new prefix-scoped erasure method). No PIN/session
  primitive changes — Phase 5 **reuses** the OTP + session-revoke + cascade primitives
  built in Phases 1–3.

This is Rollout step 5. It realizes the `DELETE /account` line of the main Decision as a
two-step, step-up-OTP, actor-scoped erasure. The seven decisions below are the design of
record; nothing here relaxes the §2/§5/§6 invariants.

### D1 — Endpoint shape (two-step, step-up OTP, identity from the guard)

Two endpoints on the existing `@Controller("auth")`, both `WorkerAuthGuard`-protected
(identity from the token's `worker.id`, **never** the body):

- `POST /auth/account/delete/request` — `WorkerAuthGuard`. Decrypts the worker's phone
  (`WorkersRepository` + `PiiCryptoService`), calls the **existing**
  `OtpService.issueAndSend(phoneE164)` (real Fast2SMS, throttled, global daily cap),
  returns `{ resend_in_seconds }`. No body. Idempotent under the OTP cooldown.
- `POST /auth/account/delete/confirm` — `WorkerAuthGuard` + `{ otp }` in the body.
  Re-derives the phone from the **token-bound** worker, calls the **existing**
  `OtpService.verify(phoneE164, otp)` (constant-time, single-use, throws on bad), then
  executes the erasure orchestration (D4) and returns `204`.

Rationale: deletion is **irreversible**, so it gets the strongest gate we have —
re-proving possession of the SIM (step-up OTP) on top of an already-authenticated
session. Two steps mirror `pin/reset/request`+`confirm`. We deliberately do **not** add a
`DELETE /account` verb; the two `POST` actions read clearer for a destructive workflow and
keep the body-carries-OTP shape. The confirm's identity is the guard's `worker.id`; the
body carries **only** the OTP code — a worker can never delete another worker by id.

### D2 — Hard-delete + a minimal PII-free tombstone

**Hard-delete the `workers` row** (DPDP right-to-erasure — raw PII GONE; the cascade in D3
erases every PII-bearing child). We do **not** soft-delete (a `status='deleted'` row would
retain encrypted phone + name and fail the erasure intent).

**Retain one PII-free tombstone row** in a new `worker_deletions` table (or, if a row is
preferred over a table, reuse the events spine alone — see trade-off):
`id`, `phone_hash` (the keyed HMAC blind index — **not reversible to a phone**, already the
only phone derivative allowed outside `workers` per §2), `deleted_at`, optional
`cooldown_until`. Purpose: (a) block immediate re-registration abuse / OTP-spend churn via a
short cool-down keyed on `phone_hash`; (b) give OTP-request a deterministic "this number was
deleted" branch without resurrecting identity. `phone_hash` is **PII-free by the same rule
that lets it appear in `worker.created`** — it is a non-brute-forceable HMAC, never the
number. Nothing else is retained: no ciphertext phone, no name, no device hash.

Trade-off (decided): a dedicated `worker_deletions` table is cleaner than overloading the
events spine for the cool-down read (events is append-only audit, not a lookup index). If
the team prefers zero new tables, the cool-down can instead live as a Redis key
`deleted_phone:<phone_hash>` with a TTL — **recommended fallback**, since the cool-down is
inherently time-bounded and a Redis flush losing it only re-opens normal registration (fail-
open is acceptable for an anti-abuse cool-down, never for auth). **Recommendation: Redis-TTL
cool-down keyed on `phone_hash`; no new table.** The durable record of the deletion is the
PII-free `worker.account_deleted` event (D5).

> **AS-BUILT:** the **Redis-TTL tombstone** was chosen — `AccountDeletionService` sets
> `deleted_phone:<phone_hash>` with `ACCOUNT_DELETION_COOLDOWN_SECONDS` TTL (default 7d),
> **no `worker_deletions` table**. The set is **fail-open** (a Redis error logs + continues —
> it never aborts the completed erasure). `phone_hash` is the keyed-HMAC blind index (the only
> §2-permitted retained phone derivative); the raw phone is never stored.

### D3 — Per-table fate map (every FK into `workers.id`)

CASCADE-erase = PII-bearing child, erased by the existing `onDelete: "cascade"`. The
schema today cascades **all** of these:

| Table | Line | Current `onDelete` | Fate | Note |
|---|---|---|---|---|
| `worker_consents` | 133 | cascade | **CASCADE-erase** | consent records are worker-scoped PII context |
| `worker_devices` | 167 | cascade | **CASCADE-erase** | device hash + push token |
| `worker_credentials` | 224 | cascade | **CASCADE-erase** | PIN hash/salt |
| `worker_profiles` | 251 | cascade | **CASCADE-erase** | extracted profile |
| `chat_sessions` | 296 | cascade | **CASCADE-erase** | conversation state |
| `voice_notes` | 327 | cascade | **CASCADE-erase** (row) + ⚠ **audio-blob LAUNCH GATE** | the row (incl. `storage_path` + transcripts) cascade-erases, but the AUDIO BLOB at `storage_path` must also be erased from object storage. Today voice upload is a Phase-1 placeholder (client-supplied path, **no backend audio bucket**), so there is nothing to erase. D4 wires a **dormant erase seam** (`listVoiceStorageKeys` → erase via `VOICE_NOTES_BUCKET`, unset today → no-op). **Launch gate (security Finding 1 / R25):** before any real audio bucket ships, audio MUST live in `VOICE_NOTES_BUCKET` (or under `conversationWorkerPrefix`) so deletion covers it — else raw voice PII survives a DSAR. |
| `chat_messages` | 364 | cascade | **CASCADE-erase** | message bodies |
| `generated_resumes` | 387 | cascade | **CASCADE-erase** | resume rows (PDFs handled in D4) |
| `worker_answers` | 590 | cascade | **CASCADE-erase** | questionnaire answers |
| `applications` | 848 | cascade | **CASCADE-erase** | swipe decisions (worker-owned, not billing) |
| `worker_flags` | ~1505 | cascade | **CASCADE-erase** | flags are PII-free codes but worker-scoped; erasing with the worker is acceptable (no billing/legal value) |
| `invites.inviterWorkerId` | 1256 | **cascade** | **⚠ FLAG → RETAIN (SET NULL)** | inviter is an *intent/attribution* row; cascading destroys referral history. See flag below. |
| `invites.invitedWorkerId` | 1258 | set null | **RETAIN (SET NULL)** | already correct — attribution handle nulls out |
| `agency_invites.invitedWorkerId` | 1326 | set null | **RETAIN (SET NULL)** | already correct (schema comment: "keep INTENT history intact") |
| **`unlocks.workerId`** | **936** | **cascade** | **⚠ FLAG → RETAIN (SET NULL)** | a **paid** contact-unlock grant. Cascading **destroys billing history**. See flag. |
| **`resume_disclosures.workerId`** | **1173** | **cascade** | **⚠ FLAG → RETAIN (SET NULL)** | a PII-disclosure grant on the consent+caps spine. Cascading destroys disclosure history. See flag. |

> **DESIGN QUESTION (do not resolve silently — §7).** Three tables currently
> `onDelete: "cascade"` from `workers.id` that arguably should **survive** a DSAR
> hard-delete as PII-free billing/intent history: **`unlocks`** (a paid grant),
> **`resume_disclosures`** (a logged PII disclosure), and **`invites.inviter_worker_id`**
> (referral attribution). These rows are **already PII-free by construction** (opaque
> ids only — confirmed in schema headers: `unlocks` line 922, `resume_disclosures` line
> 1162). DPDP erasure requires removing the worker's **PII**, not necessarily an
> anonymous record that they were once unlocked/disclosed/referred — and the platform has
> a legitimate financial-record interest in retaining the *fact* of a paid unlock.
>
> **Recommendation:** change these three FKs from `cascade` to **`set null`** (make
> `unlocks.worker_id` / `resume_disclosures.worker_id` / `invites.inviter_worker_id`
> nullable) so the **money/intent row survives with its identity join nulled** — fully
> PII-free, billing intact. This is a **schema migration** and therefore a §7 escalation
> (decision 7); it is **flagged for human sign-off**, not silently changed. Until signed
> off, the build must either (a) ship D4 with these three still cascading and a tech-debt
> note, or (b) block on the migration. **Recommended: block D4 launch on the migration**
> so we never destroy a billing row in production.

`events.actorId` (schema.ts:440, **no FK**) and `audit_logs` carry only opaque,
PII-free ids and are **RETAINED** — DPDP permits a PII-free audit/legal trail. They are
untouched by the cascade by construction (no FK to follow).

### D4 — Orchestration, ordering, failure semantics

`AccountDeletionService.execute(workerId)` runs **best-effort-complete and idempotent**, in
this fixed order:

1. **Revoke all sessions + refresh families** — `SessionService.revokeAll(workerId)`
   (existing). First, so a deleted-in-progress worker can never be re-authenticated. This
   also emits `worker.logged_out_all` (existing) — harmless and accurate.
2. **Erase storage** — delete every resume PDF for the worker and every archived
   conversation object. Conversations are prefix-scoped via
   `conversationWorkerPrefix(workerId)` (validators). Resume PDFs are keyed by opaque
   resume UUIDs, so **read the worker's `generated_resumes` rows BEFORE the DB delete**
   (step 3) to learn their object keys — i.e. storage erasure consumes a key list captured
   pre-cascade. This requires a **new** `StorageService.deleteByPrefix(prefix, bucket)` +
   `StorageService.deletePdf(objectKey, bucket)` (the service today has only
   upload/exists/sign — see `storage.service.ts`). Storage is **inline** (synchronous within
   the request) for Phase 5 — BullMQ wiring is deferred (§8) and inline keeps the operation
   atomic-enough and re-runnable; if a single object delete fails, record the failure count
   and continue (do not abort the whole erasure — a leftover orphan object keyed by an
   opaque UUID is non-PII-linkable and re-runnable).
3. **DB cascade delete** — delete the `workers` row in a transaction; Postgres cascades all
   D3 CASCADE children atomically. (If the D3 migration lands, the three flagged FKs
   `SET NULL` here instead.)
4. **Tombstone + event** — set the Redis cool-down key on `phone_hash` (D2) and emit
   `worker.account_deleted` (D5) with the counts captured in steps 1–3.

**Failure semantics.** The operation is **idempotent and re-runnable**: re-invoking on an
already-deleted worker is a no-op (the `workers` row is gone; `SessionService.revokeAll`
on a non-existent worker revokes nothing; storage deletes are upsert-style idempotent). A
**partial failure never half-auths** a deleted worker because step 1 (revoke) precedes
everything and step 3 (DB delete) is the atomic identity removal — if step 2 partially
fails we still proceed to 3 (PII identity gone) and surface a non-zero
`storage_objects_failed` count in the event for ops to re-run a storage sweep. The only
ordering that would be unsafe — deleting the DB row before capturing resume object keys —
is explicitly avoided (keys captured in step 2 pre-cascade).

### D5 — `worker.account_deleted` v1 event (strict, PII-free)

New registry entry (`worker` domain, v1), payload mirroring the established
`workerAuthEvent` shape — opaque `worker_id` + **counts/flags only**:

```ts
export const WorkerAccountDeletedPayload = z.object({
  worker_id: uuidSchema,            // opaque id of the now-erased worker
  sessions_revoked: z.number().int().nonnegative(),
  devices_revoked: z.number().int().nonnegative(),
  storage_objects_deleted: z.number().int().nonnegative(),
  storage_objects_failed: z.number().int().nonnegative(),  // 0 on a clean run
  had_pin: z.boolean(),             // whether worker_credentials existed
}).strict();
```

No phone, no `phone_hash`, no name, no device hash, no resume key, no OTP code — exactly
the "record the fact + counts, never the value" rule the Phase-1/2 auth events follow. The
event is the **durable** record of the deletion (the worker row is gone). Registered as
`version: 1` in `registry.ts`; the global event-count test +1.

### D6 — §2 / invariant conformance

- **§2 (no raw PII leaves boundary):** the OTP code, phone, and name never enter the event,
  `ai_jobs`, `audit_logs`, or logs. The only retained derivative is `phone_hash` (HMAC, the
  established §2-permitted blind index), used solely for the cool-down. `workers` remains the
  only raw-PII location right up until it is erased.
- **§5 (real-call gating):** Phase 5 calls **no LLM** — auth never does. The OTP send rides
  the existing gated Fast2SMS path unchanged (no new provider, no fork of `OtpService`).
- **§6 (consent gate):** N/A in the deletion direction (erasure is consent-revoking, not
  processing); no AI processing is triggered.
- **Fail-closed:** if OTP verify throws, the worker is **not** deleted (no erasure on an
  unverified confirm). If Redis is down, `OtpService.verify` already fails closed (503) and
  no deletion runs.
- **Reuse, don't fork:** `issueAndSend` / `verify` / `SessionService.revokeAll` /
  `conversationWorkerPrefix` are all reused verbatim; only `StorageService` gains delete
  methods and `event-schema` gains one event.

### D7 — Escalation (§7)

Per CLAUDE.md §7, **hard-deleting production worker rows is an escalation**. Two items
require human sign-off before any production run:

1. **The destructive endpoint + orchestration** — `POST /auth/account/delete/confirm`
   performs an irreversible cascade delete of production PII. Build behind review; **remote
   /prod execution against real worker data is a human-gated step**, not automated by this
   ADR.
2. **The D3 `onDelete` migration** (changing `unlocks` / `resume_disclosures` /
   `invites.inviter_worker_id` from `cascade` → `set null` + making those columns nullable)
   is a schema change that protects billing/intent history from silent destruction. It is
   **flagged in D3 as a design question** and routed to `database-architect` + human
   sign-off (Prakash/Akshit) — it is **not** silently chosen here. Recommended posture:
   land the migration first, then ship D4 so production never destroys a paid-unlock row.

Rollback story: the **endpoint** is reversible (feature-gated / revertable PR). The
**deletion it performs is not** — there is no undo for an executed cascade. That asymmetry
is exactly why the gate (step-up OTP + two-step + human-gated prod run) is this strong.

---

## Amendment A5 — consent-on-resume (defense-in-depth on the refresh path)

- Status: Accepted · Date: 2026-07-01 · Scope: `apps/api/src/auth/*` (no schema, no new event).

**Problem.** The §6 consent gate (`ConsentGuard`) is enforced per-request on the profiling
routes (chat / profile / voice / applications feed), reading the worker's latest consent from
the DB and failing closed — so a resumed/persistent session **cannot profile** without current
consent. That boundary already holds. What was missing: the **session-resume/refresh** surface
did not consider consent at all. `POST /auth/refresh` carried only `WorkerAuthGuard`, and
`POST /auth/token/refresh` is guard-less by design (the refresh token in the body is the
credential — the access JWT may be expired). So a worker who had **withdrawn** consent could
keep silently extending a live session via the refresh path. This is the gate that must be green
before the Flutter `kPersistentAuth` flip.

**Decision.** Enforce a **narrower** rule on the resume path than `ConsentGuard`: deny a resume
only when consent has been **REVOKED**; **allow a NEVER-consented worker**. The asymmetry is
deliberate — the onboarding order is `login → consent → chat`, so a worker holds a session
*before* consenting, and refreshing during that pre-consent window must keep working. A
never-consented worker still cannot reach any profiling route (those keep `ConsentGuard`, which
denies until acceptance), so §6 is never relaxed on the processing path.

**Mechanism.**
- New `ConsentNotRevokedGuard` (`apps/api/src/auth/consent.guard.ts`): denies iff the latest
  `worker_consents` row exists **and** `revokedAt` is set (403, PII-free). Applied to
  `POST /auth/refresh` after `WorkerAuthGuard` → guard set `[ConsentNotRevokedGuard, WorkerAuthGuard]`
  in the authz contract (`guard-contract.test.ts`).
- `POST /auth/token/refresh` stays **guard-less** but enforces the **same** rule in-controller:
  it resolves the worker from the refresh token via the existing `SessionService.resolveRefreshToken`
  (which does **not** mint/rotate/consume the token), then 403s on a revoked consent **before**
  rotating. An **unresolvable** token skips the check and falls through to the existing neutral
  401 — no consent oracle for a token we cannot tie to a worker. Fail-closed is preserved
  (a Redis error resolves to "unresolved" → the neutral 401 path).

**Invariants.** No schema change, no new event, no new PII at rest. Reuses `ConsentRepository.findLatestByWorker`
and `SessionService.resolveRefreshToken`. §6 profiling boundary unchanged (still `ConsentGuard`
per-request). Consent **revocation** has no live endpoint in Phase 1 (only `consent.accept`
exists), so today "revoked" arises via account deletion (which already revokes sessions) — this
amendment is **future-proofing** for when a revoke endpoint / withdrawal flow ships, and closes
the silent-resume gap ahead of `kPersistentAuth`.

**Coverage note.** A sweep of the worker-facing profiling/feed routes confirms `ConsentGuard`
is present on every one (chat, profiles, voice, and the ApplicationsController `feed` / `apply` /
`skip` / `myApplications`). `ReachController` (`/reach/*`, incl. `workers/:workerId/feed`) is a
**faceless ops** read over the deterministic RANK core (no PII, documented alpha-ops surface),
not a worker profiling route — its open posture is a separate matter (candidate for an
`InternalServiceGuard` hardening like the posting-plans/A2 change), **not** a §6 consent gap.
