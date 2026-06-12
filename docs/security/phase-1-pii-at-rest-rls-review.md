# Security/Privacy Review — PII-at-rest + RLS + transcript work

- **Date:** 2026-06-12
- **Reviewer:** bb-security-review gate (post-hoc)
- **Scope:** the PII-at-rest / RLS / transcript changes that landed on `main`
  largely via direct pushes (no PR review): TD20 spine-wide RLS+REVOKE
  (migration `0009`), TD21 `full_name` encryption + name-on-resume (ADR-0004,
  `0003`/`0004`), and the voice transcript path (TD6, PR #9).
- **Verdict:** **PASS** — no Critical/High findings; the two §2 hard guarantees
  hold. Two Medium residuals tracked (R11 confirmed; R12 new). Nothing blocks.

## What was verified (§2 invariants)

| Check | Result | Evidence |
| --- | --- | --- |
| No raw PII in events | ✅ | `worker.name_recorded` carries `worker_id` only ([workers.service.ts:41](../../apps/api/src/workers/workers.service.ts#L41)); transcription events carry length+confidence only |
| No raw PII in `ai_jobs` / `audit_logs` | ✅ | refs only (ids/enums) |
| No raw PII in logs | ✅ | name write logs "(encrypted)" + id only ([workers.service.ts:50](../../apps/api/src/workers/workers.service.ts#L50)); resume decrypt-failure logs id only ([resume.service.ts:50](../../apps/api/src/resume/resume.service.ts#L50)); STT logs char_count only |
| No raw PII to the LLM | ✅ | resume sends only the structured `DraftProfile` (name injected **after** the AI call, [resume.service.ts:36-56](../../apps/api/src/resume/resume.service.ts#L36-L56)); transcript reaches the LLM only via `/profile/extract`, which pseudonymizes first |
| Pseudonymization fail-closed | ✅ | extraction returns `blocked` before the router/LLM on unsafe input (`test_profile_extract_fails_closed_on_unsafe_input`); history gated (R9, closed) |
| `AI_ENABLE_REAL_CALLS` safe default | ✅ | `false`; per-task allowlist empty by default (PR #15) |
| Secrets not committed / fail-closed | ✅ | `PII_HASH_PEPPER`/`PII_ENCRYPTION_KEY` are config; dev defaults rejected outside dev/test by `assertPiiCryptoConfig`; `.env.example` placeholders only |
| Crypto soundness | ✅ | peppered HMAC-SHA256 for `phone_hash`; AES-256-GCM (authenticated, random IV, key never in DB, fail-closed key validation) for `phone_e164`/`full_name` ([crypto.ts](../../apps/api/src/common/crypto.ts)) |
| RLS / service-role posture | ✅ improved | `0009` extends ENABLE+FORCE RLS + REVOKE (anon/authenticated/service_role/PUBLIC) to all 13 remaining spine tables; backend uses a direct `postgres`/BYPASSRLS connection, never the Data API — materially tightens the old R1/TD4 gap |
| Consent gate | ✅ unchanged | `consent.accepted` still gates profiling |

## Findings

### F1 — `voice_notes.transcript_text` is plaintext at rest (Medium → R12, NEW)
The transcript is raw worker free-text that can contain PII (a worker may speak
their phone/name/employer). It is stored unencrypted in `voice_notes`, unlike
`phone_e164`/`full_name` which are now AES-256-GCM.
- **Contained by:** RLS+REVOKE on `voice_notes` (migration `0009`) → not readable
  via the Data API; no app endpoint returns `transcript_text`; it never enters
  events/ai_jobs/logs; it reaches the LLM only through the pseudonymization gate.
- **Residual:** a backend/backup/DB-level read exposes transcript plaintext.
- **Fix (before real voice profiling):** encrypt `transcript_text` at rest with
  `PiiCryptoService` (same pattern as phone/name), or treat the transcript as the
  conversation-bucket trust tier (R10). Logged as **R12**.

### F2 — Unauthenticated name exposure on two routes (Medium → R11, CONFIRMED)
`GET /resume/:id` returns the worker's own name inside the resume body, and
`PUT /workers/:id/name` accepts a name with no caller-identity authz
([resume.controller.ts:39-52](../../apps/api/src/resume/resume.controller.ts#L39-L52),
[workers.controller.ts:61-69](../../apps/api/src/workers/workers.controller.ts#L61-L69)).
Matches the existing **R11** exactly — bounded by unguessable UUIDv4 ids + spine
RLS + no in-repo client consumer; the name never reaches LLM/events/logs.
- **Launch gate:** close caller authz with R1/TD4 before any client-facing use.
- **Renderer note:** the future resume renderer MUST output-encode the
  attacker-controlled `{{full_name}}` (already noted in the resume templates README).

## Required actions

- [x] Log F1 as **R12** in the risks register (done with this review).
- [ ] (Launch gate) Close R11 authz with R1/TD4.
- [ ] (Before real voice profiling) Encrypt `transcript_text` at rest (R12).

No code changes are required to PASS; both residuals are contained and tracked.
