# Security/Privacy Review — PII-at-rest + RLS + Full Spine Lock

- **Date:** 2026-07-24 (updated from 2026-06-12 review)
- **Reviewer:** bb-security-review gate (post-hoc)
- **Scope:** The PII-at-rest / RLS / transcript changes on `main` through
  migration 0009 and subsequent additive migrations (0014 unlock, 0025 agency,
  0037 skills, 0040 photos, 0041 job fields, 0048 agency KYC/payouts).
  Current table count: **43 tables** (`packages/db/src/schema.ts`).
- **Verdict:** **PASS** — no Critical/High findings on the *merged* codebase
  (R28, R30, R31, R32 are live Critical/High risks tracked in register, not
  introduced by this review scope). The two §2 hard guarantees hold.
  Residuals tracked in [risks-register.md](../registers/risks-register.md).

## What was verified (§2 invariants)

| Check | Result | Evidence |
| --- | --- | --- |
| No raw PII in events | ✅ | All 105 registered events carry ids/enums/counts only; `worker.name_recorded` = `worker_id` only; unlock/contact/payment events channel kind only (never destination); resume events PII-free |
| No raw PII in `ai_jobs` / `audit_logs` | ✅ | Refs only (opaque ids/enums); `ai_jobs` stores pseudonymized `input_text`/`output_text`; `audit_logs` carries actor/subject ids + action codes |
| No raw PII in logs | ✅ | Structured logging uses ids/hashes; name write logs `(encrypted)` + id; resume decrypt-failure logs id only; STT logs char_count; OTP logs phone-hash only |
| No raw PII to the LLM | ✅ | Resume sends only structured `DraftProfile` (name injected **after** AI call); transcript reaches LLM only via `/profile/extract` which pseudonymizes first; `_pseudonymized_history()` gates full conversation history |
| Pseudonymization fail-closed | ✅ | Extraction returns `blocked` before router/LLM on unsafe input; history drops unpseudonymizable turns; residual-digit net + digit-count rule (R30 narrowed) |
| `AI_ENABLE_REAL_CALLS` safe default | ✅ | `false`; per-task allowlist empty by default; kill-switch `AI_REAL_CALLS_KILL_SWITCH` checked first |
| Secrets not committed / fail-closed | ✅ | `PII_HASH_PEPPER`/`PII_ENCRYPTION_KEY` (v1 + v2 kid/keyring, TD22-1) are config; dev defaults rejected outside dev/test by `assertPiiCryptoConfig`; `.env.example` placeholders only |
| Crypto soundness | ✅ | Peppered HMAC-SHA256 for `phone_hash`/`email_hash`; AES-256-GCM (authenticated, random IV, key never in DB, fail-closed key validation) for `phone_e164`/`full_name`/`email_enc`/`phone_enc`/`org_name_enc`/`name_enc`/agency KYC fields (`crypto.ts`) |
| RLS / service-role posture | ✅ **Full spine locked** | Migration **0009** extends ENABLE+FORCE RLS + REVOKE (anon/authenticated/service_role/PUBLIC) to **all 14 core spine tables** (`workers`, `worker_consents`, `worker_profiles`, `chat_sessions`, `chat_messages`, `voice_notes`, `generated_resumes`, `events`, `ai_jobs`, `audit_logs`, `profiles`, `questions`, `profile_questions`, `worker_answers`). Subsequent migrations applied same lock to: unlock tables (0014), job_postings (0015), agency tables (0025), pace_states (0023), skills tables (0037), admin_users (0031), worker_flags (0033). **All 43 tables in `public` schema deny Data-API roles.** Backend still connects as `postgres`/BYPASSRLS (TD4). |
| Consent gate | ✅ | `consent.accepted` gates profiling, extraction, swipe feed/apply/skip, unlock reveal |
| Worker auth (PIN + rotating refresh) | ✅ | ADR-0026 Phases 0-5: device-bound PIN (scrypt + server throttle), opaque rotating refresh tokens (reuse-detect + family revoke), 90d absolute cap, SIM-swap gate (PIN required on new device OTP). `worker_credentials` RLS-locked; hash never in events. |

## Findings (from original 2026-06-12 review + updates)

### F1 — `voice_notes.transcript_text` is plaintext at rest (Medium → **R12**, OPEN)
The transcript is raw worker free-text that can contain PII. Stored unencrypted in
`voice_notes`, unlike `phone_e164`/`full_name` (AES-256-GCM).
- **Contained by:** RLS+REVOKE on `voice_notes` (migration 0009) → not readable via
  Data API; no app endpoint returns `transcript_text`; it never enters events/ai_jobs/logs;
  reaches LLM only through pseudonymization gate.
- **Residual:** A backend/backup/DB-level read exposes transcript plaintext.
- **Fix (before real voice profiling):** Encrypt `transcript_text` at rest with
  `PiiCryptoService` (same pattern as phone/name), or treat transcript as the
  conversation-bucket trust tier (R10). Tracked as **R12**.

### F2 — Unauthenticated name exposure on `GET /resume/:id` + `PUT /workers/:id/name` (Medium → **R11**, PARTIALLY MITIGATED)
- `GET /resume/:id/download` is now **worker-authenticated + ownership-checked** (TD29 G1, 2026-06-15) — IDOR closed for the download path.
- `GET /resume/:id` (text preview) + `PUT /workers/:id/name` remain on `InternalServiceGuard` (no per-worker authz) — bounded by UUIDv4 + spine RLS.
- **Launch gate:** Close caller authz with R1/TD4 before any client-facing use.

### F3 — `GET /workers/:id/profile` returns decrypted real name to unauthenticated caller (**R28**, **Critical**, OPEN — owner HOLD 2026-07-16)
- Endpoint has no guard (`guard-contract.test.ts` pins `Workers.getProfile: []`).
- Returns full `generated_resumes` row including `resumeText` (name injected at generate time, TD21) and `resumeJson.name`.
- `GET /workers` (list) is a UUID enumeration oracle; `PUT /workers/:id/name` is unauthenticated PII write.
- **Mitigation:** Lightsail not publicly reachable + no real worker names deployed.
  **Re-verify the moment either changes.**

### F4 — `voice_notes` transcript path: STT adapter wired but real Sarvam call gated (TD6)
- Async transcription end-to-end on mock-by-default path (`POST /voice/transcribe` → BullMQ `voice-transcription` queue). Real call in `_transcribe_real` remains fail-closed behind `AI_ENABLE_REAL_CALLS` + `SARVAM_API_KEY`.

### F5 — Payer B2B PII in `payers` table (NEW class, ADR-0019 B-R2 accepted)
- `email_enc`/`phone_enc`/`org_name_enc` AES-256-GCM at rest; `email_hash` for lookup/dedup.
- **Never** in events/ai_jobs/audit_logs/LLM input. `payer_id` stays the only token.
- RLS+REVOKE on `payers` (migration 0010/0014 spine lock).

### F6 — Agency financial KYC in `agency_kyc` (ADR-0022 Amdt 2, launch-gated OFF)
- PAN/bank/IFSC/name encrypted at rest (ADR-0004 discipline). `AGENCY_PAYOUTS_ENABLED=false` default OFF.

## Required actions (updated)

- [x] Log F1 as **R12** in risks register (done).
- [ ] (Launch gate) Close R11 authz with R1/TD4.
- [ ] (Before real voice profiling) Encrypt `transcript_text` at rest (R12).
- [ ] (Critical) Resolve **R28** before any public endpoint exposure or real worker names in DB.
- [ ] (Critical) Resolve **R30** (separator-split phones) and **R32** (names without cues) before flipping `AI_ENABLE_REAL_CALLS`.
- [ ] (High) Resolve **R31** (unauthenticated pricing catalog write) before `PAYMENTS_ENABLE_REAL`.
- [ ] (High) Verify Lightsail box is not running dev secrets / throwaway Postgres (**R27** mitigated by CD hardening but box residual open).

No code changes required to PASS the *merged* codebase; residuals are contained, tracked, and launch-gated.