# Workstream Tracker — Production Worker Auth (ADR-0026)

**Owner:** Divyanshu Pant · **Status:** ALL 5 PHASES MERGED 2026-06-29 (code-complete + unit-tested; gated OFF pending staging proof) · **Program rollup ~80%** · **Scope class:** Phase-2 production hardening (NOT an alpha-gate).
**Decision of record:** [ADR-0026](../decisions/0026-production-worker-auth-pin-and-tiered-sessions.md) · **Risk:** [R25](../registers/risks-register.md) · **Deferred-hardening:** [TD55](../registers/tech-debt-register.md).
**Last updated:** 2026-06-29 (control-room).

> ✅ **D7 RESOLVED (2026-06-29):** built on **`crypto.scrypt` + env pepper** per the accepted ADR-0026
> (verified `apps/api/src/auth/pin-hasher.service.ts`, PR #168) — Argon2id + KMS correctly **deferred to
> TD55**, no §3 deviation merged. **Fast-follows before real-SMS / prod:** 4 deferred MEDIUM PIN
> throttle/rate-limit findings (PR #168 — e.g. cycle-0 flush reset, `/pin/reset` OTP-cap bypass);
> `PAYER-PIN-1` (payer PIN unlock) held pending an ADR amendment + security review; account-deletion
> prod endpoint + voice-audio DSAR erase are §7/launch-gate deferred (PR #169).

---

## Program status (5 phases)

| Phase | What | Status | Progress | Evidence |
| ----- | ---- | ------ | -------: | -------- |
| 1 | Session core: access/refresh split, opaque rotating refresh + reuse detection, engagement tiers + 90d absolute cap, `/auth/token/refresh`, `/auth/logout-all`, `/auth/session` | ✅ MERGED (VERIFY) | 80% | #162 `03410ee`; `session.service.ts`, `session-tiers.ts` + tests |
| 2 | **Devices:** `worker_devices` table + registration on OTP verify + `did` claim + `GET`/`DELETE /auth/devices` | ✅ MERGED (VERIFY) | 80% | #167 `ce8f65a`; `worker_devices` in schema (l.161); trusted-device gate |
| 3 | **PIN:** `worker_credentials` + scrypt set/verify/reset + throttle/lockout + SIM-swap PIN gate + weak-PIN denylist | ✅ MERGED (VERIFY) | 78% | #168 `0aff7d5`; `worker_credentials` (l.218), `pin-hasher.service.ts` (scrypt), `pin.controller.ts`; **4 throttle fast-follows open** |
| 4 | Mobile (worker app): persistent auth (phone+OTP+PIN), silent refresh, splash resume, refresh-on-401 + mobile↔backend reconcile | ✅ MERGED (VERIFY) | 75% | #166 `78622e5` + Phase-4 reconcile `d305877`; not handset-proven (B1) |
| 5 | DPDP account deletion (`DELETE /account`, step-up OTP, actor-scoped cascade) | ✅ MERGED (VERIFY) | 78% | #169; migration 0031; voice-audio DSAR erase DORMANT (launch-gate); prod endpoint §7-deferred |

**Workstream rollup: ~80%** (all 5 phases MERGED + unit-tested, Confidence Medium). Cap: security-sensitive auth → **cannot exceed 90% without bb-security-review + staging proof**, and held below that by the **4 open PIN throttle fast-follows** + no-handset-proof. Remaining to 100%: land the fast-follows, B1 handset verification, and the launch-gate items (payer PIN amendment, voice DSAR erase, prod account-deletion endpoint).

---

## Divyanshu's 6 in-progress tasks (Phase 2 + 3)

Each rolls into Phase 2/3 above. Acceptance is the "done bar"; nothing is DONE without it + a [QA_EVIDENCE](QA_EVIDENCE.md) row + bb-security-review.

### T1 — Two new DB tables + migrations (`worker_credentials`, `worker_devices`)
- **Spec (ADR-0026 §"What we do add"):**
  - `worker_credentials`: `worker_id` (FK→workers, **unique**), `pin_hash`, `pin_salt`, `pin_algo` (`'scrypt-v1'` — enables future rehash), `pin_updated_at`, `failed_attempt_cycles` (durable lockout escalation), timestamps.
  - `worker_devices`: `id` (uuid), `worker_id` (FK→workers), `device_hash` (**HMAC of the device id — never the raw fingerprint**), `platform`, `model`, `app_version`, `attestation` (default `'none'`, never gated on — R5 deferred), `trusted_at`, `last_seen_at`, `revoked_at?`.
- **Acceptance:** additive (expand) migration via `pnpm db:generate`, backward-compatible + rollback note; **ENABLE + FORCE RLS + REVOKE** from anon/authenticated/service_role/PUBLIC on BOTH tables (TD20 pattern); schema "table count" doc reconciled; `supabase-checks` drift+sequence green.
- **Status:** IN_PROGRESS · tables not yet in `schema.ts` (verified).

### T2 — PIN hashing
- **Spec (ADR-0026 R3):** **`crypto.scrypt`** (memory-hard, OWASP-listed) + **per-user random salt** + a **dedicated server pepper from env** (`packages/config` server schema, fail-closed `assert*` guard — mirrors `PII_HASH_PEPPER`). Hashing **behind an interface** so a future Argon2id swap is rehash-on-verify. Weak-PIN denylist (`1234`/`1111`/sequences).
- **⚠️ CONFLICT:** reported as **Argon2id + KMS** → see **[D7](DECISION_LOG.md)**. If kept, needs an **ADR-0026 amendment + security sign-off** (Argon2id = new dep/§3; KMS = §3 infra). Otherwise implement scrypt + env pepper.
- **Acceptance:** no PIN or PIN-hash ever in events/`ai_jobs`/`audit_logs`/logs (§2); pepper missing ⇒ boot fails (assertAuthConfig); unit tests for hash/verify + denylist + per-user salt uniqueness.
- **Status:** IN_PROGRESS · no `scrypt`/`argon2` in `src` or deps yet (verified).

### T3 — Server-side lockout / backoff (per worker+device)
- **Spec (ADR-0026):** Redis throttle: failed-attempt cap → timed lockout → exponential backoff → after **K cycles** invalidate the PIN + force OTP + PIN reset. Durable `failed_attempt_cycles` survives a Redis flush. Emits `worker.pin_locked` (PII-free).
- **Acceptance:** tests prove cap→lockout→backoff→K-cycle-invalidate; **fail-closed** (Redis error ⇒ deny, never bypass the throttle); throttle keyed per (worker, device).
- **Status:** IN_PROGRESS.

### T4 — Endpoints: `POST /auth/pin/set`, `POST /auth/pin/verify`, `GET /auth/devices`, `DELETE /auth/devices/:id`
- **Spec:** `WorkerAuthGuard` + `ConsentGuard`; **identity from token, never body**. `pin/verify` validates the **device-bound refresh token FIRST**, then scrypt-verifies the PIN under the throttle — a correct PIN does **nothing** without a valid device-bound refresh token (never authenticates from scratch). Events: `pin_set`, `pin_verified`, `device_registered`, `device_revoked` (PII-free, versioned in `@badabhai/event-schema`).
- **Acceptance:** controller handler tests + `guard-contract` test (guard order incl. consent); typed Zod DTOs; no body-trusted `worker_id` (IDOR); each route emits its validated event.
- **Status:** IN_PROGRESS · no pin/device routes in `apps/api/src/auth` yet (verified).

### T5 — Forgot-PIN (`POST /auth/pin/reset/request` + `/confirm`) + device binding into `create()` / `refreshByToken()`
- **Spec:** PIN reset via **OTP step-up** (emits `worker.pin_reset`). Device binding: OTP verify registers the device + carries `did`; **new device ⇒ no trusted token ⇒ force OTP**; after OTP on an **existing** account ⇒ **still require the account PIN** (SIM-swap gate). Wire `device_hash`/`did` into the existing `SessionService.create()` + `refreshByToken()` (Phase-1, already present).
- **Acceptance:** tests for new-device→OTP, the SIM-swap post-OTP-PIN gate, and the reset flow; forgot-PIN cannot become an OTP-bypass.
- **Status:** IN_PROGRESS.

### T6 — Tests for all of the above
- **Acceptance:** `pnpm lint && typecheck && test` green; event-emission assertions (PII-free) for every new event; no-PII-in-logs assertions (no PIN/hash/token/raw-device-id); throttle/lockout + SIM-swap + reset covered; **mandatory `bb-security-review` for this phase** before merge.
- **Status:** IN_PROGRESS.

---

## Security gates (mandatory — do not merge without)
- **bb-security-review / `/security-review` per phase** (PII/auth change — invariant trigger).
- **§2 no-PII:** no PIN, PIN-hash, raw device fingerprint, or token value in events/`ai_jobs`/`audit_logs`/logs. `device_hash` = HMAC, never raw.
- **Fail-closed everywhere:** Redis down ⇒ deny; missing pepper ⇒ boot fail.
- **RLS:** ENABLE+FORCE+REVOKE on both new tables (TD20 pattern).
- **§8 back-compat:** additive tables (reversible), new **versioned** events only (no payload mutation).
- **Event-first:** every important action emits a validated event.

## Dependencies & sequencing
- Phase 1 (session core) **DONE** (`03410ee`) — provides `create()`/`refreshByToken()` + rotation to wire into.
- **expand→migrate→contract:** land T1 (tables + migration) **before** the endpoints (T4/T5).
- Phase 4 (worker-app mobile PIN screens) depends on T4/T5 endpoints. *(Note: this is the WORKER app; Rishi's payer/agency mobile app is a separate surface — see the [payer/agency API reference](../api/payer-agency-api-reference.md) once generated.)*

## Risks (see [R25](../registers/risks-register.md))
- 4-digit PIN = 10⁴ space → leans entirely on slow-KDF + server throttle + device binding (why T2/T3 are non-negotiable).
- SIM-swap mitigated (post-OTP PIN gate) but not eliminated (Play Integrity deferred, R5/TD55).
- Refresh-token theft mitigated by rotation + reuse detection; a single in-grace replay is possible by design.

---
_Update the phase/task % only with a [QA_EVIDENCE](QA_EVIDENCE.md) row. Resolve [D7](DECISION_LOG.md) before T2 lands._
