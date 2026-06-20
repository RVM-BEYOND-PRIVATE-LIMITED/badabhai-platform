# Pre-Merge Security / Privacy Checklist

A consolidated, runnable gate for the BadaBhai invariants. Tick every box that the
diff touches before requesting review; a privacy/AI/auth change also runs the
[`bb-security-review`](../.claude/skills/bb-security-review/SKILL.md) skill (distinct
from the built-in `/security-review`).

This file does **not** restate the rules — it points at the file/skill that
**enforces** each one. Sources of truth:

- Invariants: [`CLAUDE.md` §2](../CLAUDE.md) · Merge gates: [`CLAUDE.md` §6](../CLAUDE.md)
- PR template: [`.github/pull_request_template.md`](../.github/pull_request_template.md)
- Reviews of record: [`docs/ai/phase-1-ai-privacy-review.md`](ai/phase-1-ai-privacy-review.md) ·
  [`docs/security/phase-1-pii-at-rest-rls-review.md`](security/phase-1-pii-at-rest-rls-review.md) ·
  [`docs/security/contact-unlock-threat-model.md`](security/contact-unlock-threat-model.md) ·
  [`docs/security/resume-disclosure-threat-model-addendum.md`](security/resume-disclosure-threat-model-addendum.md)
- Open posture items: [`docs/registers/tech-debt-register.md`](registers/tech-debt-register.md) ·
  [`docs/registers/risks-register.md`](registers/risks-register.md)

> Any box you cannot truthfully tick is a **block**, not a tech-debt note. Do not
> downgrade a Critical finding to a register line (a `bb-security-review` failure
> condition).

---

## 1. PII boundary — no raw PII past the `workers` table

Phone, full name, address, employer names, and ID-doc tokens must **never** appear
in LLM input, event payloads, `ai_jobs`, `audit_logs`, or logs. Raw PII lives only in
`workers` (encrypted: `phone_e164` / `full_name` are AES-256-GCM `v1.` tokens;
`phone_hash` is peppered HMAC-SHA256).

- [ ] No phone/name/address/employer/ID-doc value reaches **LLM input** — verified for
      this diff. Enforced by [`apps/ai-service/app/pseudonymize.py`](../apps/ai-service/app/pseudonymize.py).
- [ ] No raw PII in any **event payload** — events carry ids/enums/counts only. Schema:
      [`packages/event-schema`](../packages/event-schema).
- [ ] No raw PII in **`ai_jobs`** (refs only) or in **`audit_logs`** (refs/enums only).
- [ ] No raw PII in **logs** — log the worker id, not the value; PII writes log
      `"(encrypted)"` + id (see [`docs/security/phase-1-pii-at-rest-rls-review.md`](security/phase-1-pii-at-rest-rls-review.md)).
- [ ] Crypto for any new PII column uses [`apps/api/src/common/pii-crypto.service.ts`](../apps/api/src/common/pii-crypto.service.ts)
      / [`apps/api/src/common/crypto.ts`](../apps/api/src/common/crypto.ts) (never plaintext at rest).
- [ ] Privacy-critical paths have an explicit **no-PII test** (event/`ai_jobs`/log
      assertion), per the `bb-security-review` checklist.

## 2. Pseudonymization runs before every LLM call and fails closed

[`apps/ai-service/app/pseudonymize.py`](../apps/ai-service/app/pseudonymize.py) is the
gate. If it blocks (oversize input, parse error, residual digit run) the LLM is never
called and a safe fallback returns; the original↔token mapping is never persisted or
returned.

- [ ] No new LLM path bypasses the gateway; the gateway runs **before** the
      router/provider call on every external path.
- [ ] The path is **fail-closed** — a block yields a safe fallback /
      `extraction_status="blocked"`, never a raw send (regression precedent: F-1 in
      [`docs/ai/phase-1-ai-privacy-review.md`](ai/phase-1-ai-privacy-review.md)).
- [ ] Conversation **history** (prior turns), not just the current message, is
      pseudonymized before entering `messages`.
- [ ] `ruff check .` + `pytest` green in `apps/ai-service` (CI gate).

## 3. IDOR — never trust a body-supplied user / worker / payer / company id

Derive identity from the **authenticated principal**, never from a request body. A
body that names whose data to act on is an IDOR.

- [ ] No endpoint reads `worker_id` / `user_id` / `payer_id` / `company_id` from the
      body to choose whose data to read or mutate — identity comes from the guard.
- [ ] Ownership is checked server-side (e.g. resume download verifies
      `resume.workerId === worker.id`; see [`apps/api/src/auth/worker-auth.guard.ts`](../apps/api/src/auth/worker-auth.guard.ts)).
- [ ] Known interim gaps acknowledged where relevant: `PayerAuthGuard` is still
      `InternalServiceGuard` (TD33 / [contact-unlock threat model](security/contact-unlock-threat-model.md) T7);
      ops job-postings trust a client `created_by` (TD37). No **client-facing** payer
      surface ships on the shared secret.

## 4. Secret handling

No secret values in the repo, diff, logs, or context — env var **names** + purpose are
fine, values never.

- [ ] No `.env` or secret file committed; only `.env.example` placeholders changed.
      Enforced by the harness guard [`.claude/settings.json`](../.claude/settings.json) + [`.claude/hooks/guard-secrets.mjs`](../.claude/hooks/guard-secrets.mjs)
      (blocks reading/editing/writing/printing `.env*` and key/credential files;
      `.env.example`/`.sample`/`.template`/`.dist` are allowed templates).
- [ ] New secrets are **backend-only** — added to the server schema
      ([`packages/config/src/server.ts`](../packages/config/src/server.ts)), never the
      public/client split.
- [ ] Real-capability gates stay **default-false** and **staging-first** with human
      sign-off ([`CLAUDE.md` §7](../CLAUDE.md)): `AI_ENABLE_REAL_CALLS`,
      `RESUME_RENDER_ENABLED`, `PAYMENTS_ENABLE_REAL` all default false; a flag-without-key
      **fails closed at boot** (`realAiCallsBlockedReason` / `assertPiiCryptoConfig` /
      `assertAuthConfig` / `assertPaymentsConfig` in `server.ts`).
- [ ] `SMS_PROVIDER=console` (logs OTP) is **dev-only** — not enabled in a shared env
      (`assertAuthConfig` forbids it outside development/test).

## 5. AuthN / AuthZ guards in use

- [ ] Worker-authenticated routes use [`apps/api/src/auth/worker-auth.guard.ts`](../apps/api/src/auth/worker-auth.guard.ts).
- [ ] Profiling/AI processing is behind the consent gate
      [`apps/api/src/auth/consent.guard.ts`](../apps/api/src/auth/consent.guard.ts) (see §9).
- [ ] Ops / backend-internal routes are behind
      [`apps/api/src/common/guards/internal-service.guard.ts`](../apps/api/src/common/guards/internal-service.guard.ts)
      (fail-closed when `INTERNAL_SERVICE_TOKEN` is unset).

## 6. RLS posture (TD4 — backend still BYPASSRLS)

The spine has ENABLE + FORCE RLS + REVOKE from anon/authenticated/service_role/PUBLIC
(migration 0009, [TD20]), but the **backend still connects as `postgres`/BYPASSRLS**,
not a least-privilege app role — that is **TD4**, open.

- [ ] No new direct **client→DB** access or multi-tenant exposure is introduced while
      TD4 is open ([`docs/registers/tech-debt-register.md`](registers/tech-debt-register.md) TD4;
      [`infra/supabase/rls-plan.md`](../infra/supabase/rls-plan.md)).
- [ ] Any new table is locked the same way (ENABLE + FORCE RLS + REVOKE) in its
      migration — do not ship a table with default Supabase grants (TD20 precedent;
      TD37 notes a table that shipped without the lock and was reconciled in 0015).
- [ ] Authz that "closes with TD4" is named as a **launch gate**, not silently relied
      on (e.g. R11 / `GET /ai-jobs/:id` TD15).

## 7. CORS (TD30 — open, deferred)

[`apps/api/src/main.ts`](../apps/api/src/main.ts) calls `app.enableCors()` with no
allow-list, so every origin is permitted in every environment. Acceptable in Phase 1
only because the ops console is internal (no cross-origin browser client).

- [ ] This change does **not** serve a new browser client cross-origin (if it does:
      lock `enableCors()` to an env-driven allow-list routed through
      [`isDevEnv()`](../packages/config/src/shared.ts), fail-closed — TD30 payback).
- [ ] TD30 status unchanged/updated as relevant ([`docs/registers/tech-debt-register.md`](registers/tech-debt-register.md) TD30).

## 8. Rate limiting

- [ ] Abuse-prone routes are covered by the IP rate limiter
      [`apps/api/src/common/rate-limit/ip-rate-limit.service.ts`](../apps/api/src/common/rate-limit/ip-rate-limit.service.ts)
      (HMAC-hashed IP, fail-closed). Note `req.ip` is the egress/proxy IP until
      Express `trust proxy` is set (TD25) — sizing is a coarse backstop.

## 9. DPDP consent gate

No profiling/AI processing of a worker before `consent.accepted` is captured.

- [ ] Any new profiling/AI path is gated by
      [`apps/api/src/auth/consent.guard.ts`](../apps/api/src/auth/consent.guard.ts);
      consent capture emits a validated event.

---

## When to escalate (stop and ask)

Per [`CLAUDE.md` §7](../CLAUDE.md): an §2 invariant must change; the stack must change;
a migration is destructive/irreversible; real LLM/OTP/STT/payment keys or spend are
involved; or anything touches production data. Surface the conflict — do not paper over
a contradiction between code, ADRs, and intent.
