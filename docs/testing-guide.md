# Testing Guide

> How BadaBhai is verified today — the layers that exist, how to run each one
> locally, which CI job gates it, and the **privacy + event-emission assertions**
> every test must carry. This documents the system **as it actually is**; gaps are
> called out as gaps, not papered over.
>
> Companion skill: [`.claude/skills/bb-testing/SKILL.md`](../.claude/skills/bb-testing/SKILL.md)
> (the runnable checklist for _what_ to test and at which layer).
> Operating contract: [`CLAUDE.md`](../CLAUDE.md) §2 (invariants) and §6 (quality gates).

---

## 1. Test layers at a glance

| Layer                                            | Framework                                                | Where it lives                                           | Gated by (CI job)                      |
| ------------------------------------------------ | -------------------------------------------------------- | -------------------------------------------------------- | -------------------------------------- |
| **Unit** (TS)                                    | Vitest                                                   | next to code: `apps/api/src/**/*.test.ts`, `packages/**` | `node` (`pnpm test`)                   |
| **Unit** (Python)                                | pytest                                                   | [`apps/ai-service/tests/`](../apps/ai-service/tests)     | `ai-service` (`pytest`)                |
| **Widget/unit** (Flutter)                        | `flutter test`                                           | [`apps/worker-app/test/`](../apps/worker-app/test)       | `worker-app` (path-filtered, BLOCKING) |
| **E2E** (full Phase-1 flow)                      | Vitest harness vs a live API + Postgres (+ Redis)        | [`tests/e2e/`](../tests/e2e)                             | `e2e` (`RUN_E2E=1`)                    |
| **Contract** (Zod ↔ Pydantic, payload ↔ columns) | — _placeholder_                                          | [`tests/contract/`](../tests/contract)                   | none yet — see gaps                    |
| **Security/privacy** (cross-service)             | — _placeholder_; real coverage lives in unit + e2e today | [`tests/security/`](../tests/security)                   | via `node` / `e2e` / `ai-service`      |

Cross-cutting layout is described in [`tests/README.md`](../tests/README.md). Per-package
unit tests live **next to their code**; only suites that span services live under `tests/`.

---

## 2. How to run each layer locally

### TypeScript unit (Vitest)

```bash
pnpm test                                   # all TS suites (turbo run test)
pnpm --filter @badabhai/api test            # just the API
pnpm --filter @badabhai/api test:watch      # watch mode
```

`pnpm test` runs `turbo run test` over the workspace. The `@badabhai/e2e` package is
_in_ that graph, but every e2e suite is wrapped in `describe.skipIf(!RUN_E2E)` and its
script is `vitest run --passWithNoTests`, so without `RUN_E2E=1` the e2e package is a
no-op — `pnpm test` stays fast and infra-free. See [`tests/e2e/package.json`](../tests/e2e/package.json).

### Python unit (pytest)

```bash
cd apps/ai-service
pip install -r requirements-dev.txt
ruff check .                                # lint (CI gate)
pytest                                      # tests (CI gate)
```

### Flutter (analyze + test)

```bash
cd apps/worker-app
flutter pub get
flutter analyze && flutter test             # both are BLOCKING in CI
```

### E2E (the Phase-1 happy path against a real API + DB)

Opt-in (gated on `RUN_E2E=1`). The FastAPI AI service is **not** required — the API
falls back to safe mocks (`real_call=false`, `model="mock"`), so the flow, its events,
and its persisted metadata still complete offline. Full instructions and the env-var
table are in [`tests/e2e/README.md`](../tests/e2e/README.md).

```bash
pnpm db:up                                  # postgres + redis (Redis is required: extraction runs on BullMQ)
pnpm db:migrate
pnpm --filter @badabhai/api dev             # start the API in another terminal

# bash/zsh
RUN_E2E=1 pnpm --filter @badabhai/e2e test
# PowerShell
$env:RUN_E2E=1; pnpm --filter @badabhai/e2e test
```

Two e2e suites are gated on **separate** flags because they need extra infra and must
never touch shared environments by accident:

- **`resume-signed-url.e2e.test.ts`** — `RESUME_STORAGE_E2E=1` + staging Supabase creds
  (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`). Point at **staging, never production**;
  it writes under a `resumes/_e2e/...` prefix and deletes the object in `afterAll`.
- Ops/unlock routes require `INTERNAL_SERVICE_TOKEN` set **identically** on the API
  process and the test (it gates `InternalServiceGuard` and fails closed when unset).

---

## 3. What CI runs (and what gates a merge)

Source of truth: [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) and
[`.github/workflows/worker-app.yml`](../.github/workflows/worker-app.yml). Quality-gate
checklist: [`CLAUDE.md`](../CLAUDE.md) §6.

| CI job                               | Runs                                                                                                                                                                                                  | Notes                                                                                                                                                                        |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`node`**                           | `pnpm lint` → `pnpm typecheck` → `pnpm test` → `pnpm build`                                                                                                                                           | Node 22, pnpm from `packageManager`. E2E suites skip here (no `RUN_E2E`).                                                                                                    |
| **`ai-service`**                     | `ruff check .` + `pytest` (Python 3.12)                                                                                                                                                               | Runs unconditionally.                                                                                                                                                        |
| **`e2e`**                            | Real `pgvector/pgvector:pg16` + `redis:7`; creates `anon`/`authenticated`/`service_role` roles; `db:migrate`; `db:seed:jobs`; boots the API; runs `pnpm --filter @badabhai/e2e test` with `RUN_E2E=1` | **Blocking.** AI service is intentionally NOT started (API uses safe mocks). `OTP_MAX_SENDS_PER_HOUR` is raised for the shared CI IP; `INTERNAL_SERVICE_TOKEN` is job-level. |
| **`worker-app`** (separate workflow) | `flutter analyze` + `flutter test` (Flutter 3.27.4)                                                                                                                                                   | **Blocking**, but **path-filtered** to `apps/worker-app/**` — unrelated PRs don't run it.                                                                                    |

The `e2e` job uses `pgvector/pgvector:pg16` (not plain `postgres:16`) because migration
`0001` runs `CREATE EXTENSION vector`. It pre-creates the Supabase-compatible roles so
the REVOKE migrations (`0003`/`0004`/`0009`/`0012`) apply and the RLS regression suite
can exercise `SET ROLE` denials.

---

## 4. The two assertions every BadaBhai test must carry

These are not optional extras — they lock the invariants in [`CLAUDE.md`](../CLAUDE.md)
§2. The [`bb-testing`](../.claude/skills/bb-testing/SKILL.md) skill requires both.

### (a) No raw PII leaves the `workers` table

Phone, full name, address, employer names, and ID-doc tokens must never appear in LLM
input, **event payloads**, `ai_jobs`, `audit_logs`, or logs. Tests prove this by
serializing the surface and asserting the raw value is absent. Established patterns:

- **E2E** — capture the raw phone/name for the run and assert it never appears:
  ```ts
  const eventsJson = JSON.stringify(mine);
  expect(eventsJson).not.toContain(PHONE); // E.164 form
  expect(eventsJson).not.toContain(NATIONAL); // national digits-only form
  ```
  The `workers` row holds only ciphertext + a keyed HMAC, asserted directly:
  `phoneE164.startsWith("v1.")` (AES-256-GCM token) and `phoneHash` matches
  `/^[0-9a-f]{64}$/`. See
  [`tests/e2e/phase1-onboarding.e2e.test.ts`](../tests/e2e/phase1-onboarding.e2e.test.ts)
  and [`tests/e2e/phase1-flow.e2e.test.ts`](../tests/e2e/phase1-flow.e2e.test.ts).
- **PII-key shape checks** — for projection/ops surfaces, assert no PII-shaped _key_
  exists (`full_name`, `name`, `phone`, `employer`, `address`, …), e.g.
  [`tests/e2e/swipe-to-apply.e2e.test.ts`](../tests/e2e/swipe-to-apply.e2e.test.ts) and
  [`tests/e2e/contact-unlock.e2e.test.ts`](../tests/e2e/contact-unlock.e2e.test.ts).
- **Unit** — controllers assert the payload is PII-free and that secrets (e.g. a signed
  URL token) never ride an event, e.g.
  [`apps/api/src/resume/resume.controller.test.ts`](../apps/api/src/resume/resume.controller.test.ts)
  (`expect(JSON.stringify(call.payload)).not.toContain("token=abc")`).
- **Pseudonymization fail-closed** — the gateway masks PII _and_ blocks (LLM never
  called) on oversize input / residual digit runs, asserted in
  [`apps/ai-service/tests/test_pseudonymize.py`](../apps/ai-service/tests/test_pseudonymize.py).

### (b) Important endpoints emit the correct, validated event

Every important state change emits an event built with `createEvent` and validated
against [`@badabhai/event-schema`](../packages/event-schema). Tests assert **exact event
names and per-stage counts**, and that an **invalid payload throws and does NOT persist**:

- **E2E** — count events by name for the run and assert spine integrity (`eventVersion`,
  `correlationId`, `occurredAt`), e.g. `phase1-onboarding.e2e.test.ts` asserts one each
  of `worker.created`, `consent.accepted`, `profile.extraction_completed`,
  `resume.generated`, plus `chat.message_sent`/`received` per turn.
- **Unit** — `EventsService` builds+validates+persists, and **rejects** an invalid
  payload without inserting:
  [`apps/api/src/events/events.service.test.ts`](../apps/api/src/events/events.service.test.ts).
- **Idempotency** — keyed re-emits dedup at the DB (`ON CONFLICT DO NOTHING`); unkeyed
  events always insert:
  [`tests/e2e/events-idempotency.e2e.test.ts`](../tests/e2e/events-idempotency.e2e.test.ts).

---

## 5. Critical-flow test matrix (Phase 1)

Maps each locked Phase-1 flow to the test(s) that cover it. "Covered" means an
assertion exists today; gaps are stated honestly.

| Flow / invariant                                                                                                                                               | Covered by                                                                                                                                                                                                                                                                                                          | Layer              | Gaps / notes                                                                                                                                |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **Auth / mock OTP login** (`/auth/otp/request` → `/auth/otp/verify`, new-worker path, `worker.created`/`otp_verified`)                                         | [`auth.service.test.ts`](../apps/api/src/auth/auth.service.test.ts), [`otp.service.test.ts`](../apps/api/src/auth/otp.service.test.ts), [`session.service.test.ts`](../apps/api/src/auth/session.service.test.ts); e2e `phase1-onboarding`, `phase1-flow`                                                           | unit + e2e         | OTP is mock (TD2). Per-IP OTP cap raised in CI for the shared IP.                                                                           |
| **Consent gate** (no AI before `consent.accepted`; non-consented → 403)                                                                                        | [`consent.guard.test.ts`](../apps/api/src/auth/consent.guard.test.ts); e2e `swipe-to-apply` (`/feed` → 403 without consent)                                                                                                                                                                                         | unit + e2e         | 403-on-feed is the explicit gate proof; an explicit "chat/extract blocked before consent" e2e assertion is **not** present — TODO(verify).  |
| **Chat profiling** (multi-turn interview, state persists, never re-asks Q1, no raw text in `conversation_state`)                                               | [`chat.service.test.ts`](../apps/api/src/chat/chat.service.test.ts), [`mock-interview.test.ts`](../apps/api/src/ai/mock-interview.test.ts); e2e `phase1-onboarding`, `phase1-flow`                                                                                                                                  | unit + e2e         | e2e asserts persisted state holds topic ids/counts only — never the raw message text.                                                       |
| **Extraction idempotency** (one profile per `ai_job_id` under retry/redelivery, TD14)                                                                          | [`profile-extraction.processor.test.ts`](../apps/api/src/profiles/profile-extraction.processor.test.ts); e2e [`profile-idempotency.e2e.test.ts`](../tests/e2e/profile-idempotency.e2e.test.ts)                                                                                                                      | unit + e2e         | DB-level guarantee exercised against real Postgres.                                                                                         |
| **Event idempotency** (keyed dedup, unkeyed always inserts, TD18)                                                                                              | [`events.service.test.ts`](../apps/api/src/events/events.service.test.ts); e2e [`events-idempotency.e2e.test.ts`](../tests/e2e/events-idempotency.e2e.test.ts)                                                                                                                                                      | unit + e2e         | —                                                                                                                                           |
| **Profile confirm** (`extracted` → `confirmed`, `profile.confirmed`)                                                                                           | e2e `phase1-onboarding` (status transition + event count), `phase1-flow`                                                                                                                                                                                                                                            | e2e                | No dedicated profile-confirm **unit** test located — TODO(verify).                                                                          |
| **Resume render + generate** (version 1, real output, name injected post-AI / TD21)                                                                            | [`resume.service.test.ts`](../apps/api/src/resume/resume.service.test.ts), [`resume-render.processor.test.ts`](../apps/api/src/resume/resume-render.processor.test.ts), [`resume-renderer.service.test.ts`](../apps/api/src/resume/resume-renderer.service.test.ts); e2e `phase1-onboarding`                        | unit + e2e         | e2e asserts the worker's real name appears on **their own** resume but in **no** event and **no** `ai_job`.                                 |
| **Resume download authz / IDOR** (worker-authed + ownership, non-owner → 404 no oracle, per-IP cap first, signed-URL token never in event)                     | [`resume.controller.test.ts`](../apps/api/src/resume/resume.controller.test.ts)                                                                                                                                                                                                                                     | unit               | Strong unit coverage (TD5/TD29). An **e2e** download-as-owner-vs-non-owner round trip against a live API is **not** present — TODO(verify). |
| **Resume signed-URL storage security** (private bucket, anon denied, short-TTL expiry)                                                                         | e2e [`resume-signed-url.e2e.test.ts`](../tests/e2e/resume-signed-url.e2e.test.ts)                                                                                                                                                                                                                                   | e2e (staging only) | Opt-in via `RESUME_STORAGE_E2E=1` + staging creds; **does not run in CI** (no creds).                                                       |
| **RLS spine** (every table denies `anon`/`authenticated`/`service_role`; REVOKE ALL, not just SELECT; no-drift vs live schema)                                 | e2e [`rls-spine.e2e.test.ts`](../tests/e2e/rls-spine.e2e.test.ts); plus the `workers`-only RLS case in `phase1-onboarding`                                                                                                                                                                                          | e2e                | Self-policing: a new pgTable shipped without a lock fails the no-drift test. Backend still connects as postgres/BYPASSRLS (TD4).            |
| **Swipe-to-apply** (PII-free coarse feed, `feed.shown` per item, idempotent apply/skip, validated `application.submitted`/`skipped`, ops projections PII-free) | [`applications.service.test.ts`](../apps/api/src/applications/applications.service.test.ts), [`reach.*.test.ts`](../apps/api/src/reach); e2e [`swipe-to-apply.e2e.test.ts`](../tests/e2e/swipe-to-apply.e2e.test.ts)                                                                                                | unit + e2e         | Alpha ADR-0009. Seeded via `db:seed:jobs`.                                                                                                  |
| **Contact unlock + reveal** (fail-closed neutral body, no consent oracle, debit-once under retry/concurrency, sentinel phone absent everywhere, ops PII-free)  | [`unlocks.service.test.ts`](../apps/api/src/unlocks/unlocks.service.test.ts), [`unlocks.schema.test.ts`](../apps/api/src/unlocks/unlocks.schema.test.ts), [`pricing.service.test.ts`](../apps/api/src/pricing/pricing.service.test.ts); e2e [`contact-unlock.e2e.test.ts`](../tests/e2e/contact-unlock.e2e.test.ts) | unit + e2e         | ADR-0010 Stream A. `PayerAuthGuard` is interim `InternalServiceGuard` (TD33). Phase-2 surface, not part of the locked Phase-1 happy path.   |
| **AI cost/usage metadata** (model/tokens/cost on `ai_job`, `ai.cost_recorded`, `real_call=false` on mock path)                                                 | e2e `phase1-flow`; AI service [`test_spend_cap.py`](../apps/ai-service/tests/test_spend_cap.py), [`test_ai_router.py`](../apps/ai-service/tests/test_ai_router.py)                                                                                                                                                  | e2e + pytest       | —                                                                                                                                           |
| **Pseudonymization fail-closed** (mask PII; block → LLM never called)                                                                                          | [`test_pseudonymize.py`](../apps/ai-service/tests/test_pseudonymize.py)                                                                                                                                                                                                                                             | pytest             | Heuristic/regex, not NER (TD3).                                                                                                             |
| **Worker app (Flutter)** (feed API client, swipe screen, scaffold widget)                                                                                      | [`api_client_feed_test.dart`](../apps/worker-app/test/api_client_feed_test.dart), [`swipe_jobs_screen_test.dart`](../apps/worker-app/test/swipe_jobs_screen_test.dart), [`widget_test.dart`](../apps/worker-app/test/widget_test.dart)                                                                              | flutter test       | No on-device / staging integration run in CI — that is the **B1 device-verify** capstone (TD29), a manual ops/QA gate, not automated.       |

### Known cross-cutting gaps (stated honestly)

- **`tests/contract/`** is a **placeholder** ([README](../tests/contract/README.md)):
  no automated checker yet keeps `@badabhai/ai-contracts` (Zod) ↔
  `apps/ai-service/app/contracts.py` (Pydantic), or event payloads ↔ `events` columns,
  in sync. Parity is enforced by review + the rule in
  [`CLAUDE.md`](../CLAUDE.md) §2.7 today.
- **`tests/security/`** is a **placeholder** ([README](../tests/security/README.md)):
  the real privacy assertions live inside the unit + e2e suites above, not as a
  dedicated cross-service suite.
- **AI service is not started in CI e2e** — the live API↔AI integration path is only
  exercised manually / in staging; CI proves the flow against safe mocks.
- **B1 device-verify** (real Android handset → staging) is a **manual** alpha blocker,
  not covered by any automated suite. See
  [`docs/qa/b1-device-capstone-runbook.md`](qa/b1-device-capstone-runbook.md) and
  [`docs/qa/phase-1-alpha-device-capstone.md`](qa/phase-1-alpha-device-capstone.md).

---

## 6. Smoke test

A fast "is the API alive and is the front of the happy path wired?" check. CI already
does the `/health` poll before the e2e suite (see the `e2e` job in
[`ci.yml`](../.github/workflows/ci.yml)).

A committed, zero-dependency Node script reproduces it against any running API:

```bash
# Local — start the API first (pnpm --filter @badabhai/api dev); defaults to :3001
node scripts/smoke.mjs

# Against a deployed env (e.g. staging) — pass the base URL or set SMOKE_API_URL
node scripts/smoke.mjs https://<staging-api>
```

[`scripts/smoke.mjs`](../scripts/smoke.mjs) runs `GET /health` → `POST /auth/otp/request`
→ (when the **console** SMS provider echoes `dev_otp`) `POST /auth/otp/verify` →
`POST /consent/accept`. It **writes a throwaway worker + consent** (unique phone per run),
so point it at **local or staging only — never production** (no prod target is wired). On a
real-SMS env there is no `dev_otp`, so it stops after `/auth/otp/request` and reports
`SMOKE PARTIAL` (set `SMOKE_REQUIRE_FLOW=1` to make a skipped flow a failure). Exit code is
non-zero on any failure.

By hand (curl), the same front-of-flow:

```bash
curl -sf http://localhost:3001/health && echo "  <- API healthy"
OTP_JSON=$(curl -s -X POST http://localhost:3001/auth/otp/request \
  -H 'content-type: application/json' -d '{"phone":"+919400000001"}')
echo "$OTP_JSON"   # -> { success, channel:"sms", dev_otp:"####" }  (console provider, dev/test only)
# verify -> { worker_id, is_new_worker, status:"active" }; then
# POST /consent/accept { worker_id, consent_version:"2026-06-01", purposes:[...] } -> { consent_id }
```

For a full, **asserted** run (status codes, events, persisted outputs, no-PII), prefer
`RUN_E2E=1 pnpm --filter @badabhai/e2e test` — the smoke script only checks liveness and
that the front of the flow is wired.

---

## 7. Conventions for new tests

- **Pick the layer** the [`bb-testing`](../.claude/skills/bb-testing/SKILL.md) skill
  prescribes: unit for logic, contract for boundaries, e2e for the worker-profiling
  happy path.
- **New behavior ⇒ a new test.** Privacy/event paths get **explicit** assertions
  (§4 above) — never implied.
- **Deterministic + fast.** No real network/time/randomness in unit tests. E2E uses a
  unique phone per run (`+9194${Date.now()...}`) so each run exercises the new-worker
  path in isolation, and reads `events` filtered by `payload.worker_id`.
- **Cover failure/edge cases**, not just the happy path (404 no-oracle, 403 consent
  gate, 401 missing token, idempotent retry).
- **State the gaps honestly** in the PR — coverage is reported, never overclaimed.
