# Release Checklist

> The pre-ship gate for any BadaBhai release/cut. Run this **after** CI is green and
> **before** you deploy. It is the release-level companion to the per-PR
> [pull request template](../.github/pull_request_template.md), the
> [quality gates](engineering-org/quality-gates.md), and the
> [`bb-deployment`](../.claude/skills/bb-deployment/SKILL.md) skill — it does not
> replace them, it confirms they held across everything in the cut.
>
> Rollback mechanics live in **[rollback-guide.md](rollback-guide.md)** — link the
> relevant rollback path here; do not duplicate it.

Use it like the PR template: tick every applicable box, write **N/A** deliberately
(never skip). A red box blocks the cut. Anything in CLAUDE.md §2 (invariants) or §7
(escalation triggers) is **not** a checklist item you can self-clear — stop and
escalate to the human maintainer.

---

## 1. CI is green — all gates, not just the ones you touched

Enforced by [`ci.yml`](../.github/workflows/ci.yml) +
[`worker-app.yml`](../.github/workflows/worker-app.yml). Confirm the **merge commit**
(not a stale run) is green on `main`:

- [ ] **`node` job** — `pnpm lint` · `pnpm typecheck` · `pnpm test` · `pnpm build`
      all green (Node 22, `--frozen-lockfile`).
- [ ] **`ai-service` job** (if `apps/ai-service/**` touched) — `ruff check .` +
      `pytest` green (Python 3.12).
- [ ] **`worker-app` job** (only runs / only required if `apps/worker-app/**` or the
      workflow changed) — `flutter analyze` + `flutter test` green. **Blocking** since
      2026-06-15; a red check here means do not merge.
- [ ] **`e2e` job** — the Phase-1 onboarding flow (login → consent → multi-turn
      interview → AUTO extraction → `extraction_completed` → no-raw-phone → confirm →
      resume) is green against real Postgres (`pgvector/pgvector:pg16`) + Redis. This
      also re-runs the **full migration chain from scratch** on every PR, so a green
      `e2e` is your migration smoke test.

> No "I only changed docs" exception — the cut ships the whole tree. If `e2e` or any
> job is red or skipped unexpectedly, the cut is not ready.

---

## 2. Migrations — ordered, backward-compatible, rollback noted

Drizzle is the schema source of truth ([`packages/db/src/schema.ts`](../packages/db/src/schema.ts));
migrations live in [`packages/db/migrations/`](../packages/db/migrations/) (latest on
`main`: **0017** — re-confirm against the directory; team-memory's "next number"
counter [lags](../.claude/team-memory.md#migration-sequencing-critical--avoid-collision)).
See [`safe-db-migration`](../.claude/skills/bb-database-design/SKILL.md) and
[ADR-0004](decisions/0004-pii-at-rest-and-rls.md).

- [ ] **Migration ships BEFORE the code that needs it.** Deploy order is
      migrate-then-deploy; never the reverse (`bb-deployment` failure condition #1).
- [ ] **Backward-compatible.** No dropped/renamed in-use column, no mutated shipped
      type. Risky changes follow **expand → migrate → contract** across releases, not
      in one cut (CLAUDE.md §2.8).
- [ ] **No concurrent migration numbers.** Two PRs must not both author the same
      `00NN_` file — check the directory before `pnpm db:generate`
      ([coordination rule 1](../.claude/team-memory.md#coordination-rules)).
- [ ] **PII stays in `workers` only.** A new PII column lives in `workers`, never in
      `events` / `ai_jobs` / `audit_logs` / any AI-reachable table (CLAUDE.md §2.2).
- [ ] **Rollback noted** for every migration in the cut (see
      [rollback-guide.md](rollback-guide.md)). A destructive/irreversible migration is
      an **escalation**, not a checkbox (CLAUDE.md §7).
- [ ] Migrations apply cleanly from scratch — confirmed green via the `e2e` job's
      `pnpm --filter @badabhai/db db:migrate` step.

---

## 3. Env gates — default-safe, flips human-signed + staging-first

The fail-closed gates default **false** via `booleanFromString`
([`packages/config/src/shared.ts`](../packages/config/src/shared.ts)); boot guards in
[`packages/config/src/server.ts`](../packages/config/src/server.ts) refuse to start a
half-configured real path. Never flip one on shared infra without human sign-off
([team-memory env gates](../.claude/team-memory.md#environment-gates-never-flip-without-human-sign-off)).

- [ ] **`AI_ENABLE_REAL_CALLS`** is **false** for this cut — OR the flip is
      human-signed, staging-first, and recorded in
      [real-llm-flip-go-no-go.md](ai/real-llm-flip-go-no-go.md) with the model pinned
      (Finding 4: validation-model must equal flip-model). Runbook:
      [enable-real-llm-extraction.md](ai/enable-real-llm-extraction.md).
- [ ] **`RESUME_RENDER_ENABLED`** is **false** — OR on (staging-first) **with**
      WeasyPrint installed and the `worker-resumes` bucket PRIVATE
      ([storage-buckets.md](../infra/supabase/storage-buckets.md)).
- [ ] **`PAYMENTS_ENABLE_REAL`** is **false** (alpha has no real money movement; real
      Razorpay is not wired — TD34). `server.ts` refuses to boot it `true` without
      `PAYMENTS_PROVIDER_KEY`.
- [ ] **`AI_REAL_CALLS_KILL_SWITCH`** path verified: `true` hard-stops all real calls
      independently of the master flag; `GET /health` reflects
      `real_calls_enabled:false`. This is the instant, no-deploy AI rollback.
- [ ] **`OTP_BYPASS_ENABLED`** is **never** true in staging/prod (dev/test only).
- [ ] **Server/public env split intact** — no secret-bearing var imported into
      `apps/web` / `apps/worker-app`; client reads only `@badabhai/config/public`.
- [ ] Any **new** env var is in [`.env.example`](../.env.example) (NAME + purpose,
      placeholder only) and in the relevant schema.

> Enabling a real LLM/OTP/STT/payment provider key, or any spend, in a shared
> environment is an **escalation** (CLAUDE.md §7) — the maintainer performs the flip;
> this checklist only confirms it was authorized and staging-first.

---

## 4. Contracts — events versioned, AI contracts mirrored

- [ ] **Event payloads versioned, not mutated.** Any change to a shipped event is a
      new field (additive) or a new `event_name` — never an in-place shape change
      ([`packages/event-schema`](../packages/event-schema), CLAUDE.md §2.8,
      [`event-schema-change`](../.claude/skills/bb-api-design/SKILL.md)).
- [ ] **Every important new endpoint emits a validated event** built with
      `createEvent` (CLAUDE.md §2.1) — the `events` table is the audit spine.
- [ ] **AI contracts mirrored Zod ↔ Pydantic.** Any
      [`packages/ai-contracts`](../packages/ai-contracts) change has its matching
      [`apps/ai-service/app/contracts.py`](../apps/ai-service/app/contracts.py) change
      in the **same** PR (CLAUDE.md §2.7,
      [coordination rule 3](../.claude/team-memory.md#coordination-rules)).

---

## 5. Security / privacy — secrets, PII, review

- [ ] **No secrets / `.env` committed.** Scan the diff; only real `.env.example`
      placeholders are allowed. (Harness backstop: `.claude/hooks/guard-secrets.mjs`.)
- [ ] **No raw PII** in LLM input, event payloads, `ai_jobs`, `audit_logs`, or logs —
      hashes/opaque UUIDs only (CLAUDE.md §2.2). Pseudonymization
      ([`apps/ai-service/app/pseudonymize.py`](../apps/ai-service/app/pseudonymize.py))
      stays fail-closed; no LLM path bypasses it (§2.3).
- [ ] **Identity is derived from the authenticated principal**, never a body-supplied
      `user`/`worker`/`payer`/`company` id (auth rule).
- [ ] **DPDP consent gate** precedes any profiling/AI processing (`consent.accepted`
      captured first — CLAUDE.md §2.6).
- [ ] **Security/privacy review done** for any change touching PII, AI, auth, RLS, or
      secrets — `/security-review` (or [`bb-security-review`](../.claude/skills/bb-security-review/SKILL.md))
      run and findings resolved (quality-gate 2). A Critical finding **blocks the
      cut**; it is never deferred to tech-debt.

---

## 6. Docs & registers updated in the same cut

- [ ] ADR added/updated for any heavyweight decision (new table, event-version bump,
      new provider, auth/RLS, AI boundary) — [`docs/decisions/`](decisions/).
- [ ] Registers touched where the change moved them — [`docs/registers/`](registers/)
      (risks, tech-debt, decisions, open-questions).
- [ ] [`project-memory.md`](../.claude/project-memory.md) /
      [`team-memory.md`](../.claude/team-memory.md) updated when a domain/table/module
      was added, an ADR/tech-debt status changed, or workstream ownership moved
      (CLAUDE.md §9, same-PR rule).

---

## 7. Deploy + post-deploy verification

Per [`bb-deployment`](../.claude/skills/bb-deployment/SKILL.md):

- [ ] Deploy order respected: **migrate → deploy code** (never code-before-migration).
- [ ] **Rollback path is written and at hand** for this cut — see
      [rollback-guide.md](rollback-guide.md). "Deployed" is not declared until the
      rollback is known.
- [ ] Post-deploy: `GET /health` healthy; events flowing; the change visible in the
      ops console (read-only workers / events / ai-jobs).
- [ ] Logs watched for the first window after deploy (structured logs carry
      `request_id` / `correlation_id` —
      [`infra/monitoring/README.md`](../infra/monitoring/README.md)).

---

## 8. Alpha capstone note — B1 gates the 2026-06-25 cut

The alpha cut (target **2026-06-25**) has **one** blocker: **B1 — a real Android
handset run of the core flow against staging.** This checklist does **not** clear B1;
CI green and an emulator/CI run **do not count**.

- [ ] **B1 satisfied** before the alpha cut: a real handset, pointed at **deployed
      staging**, completes login → consent → chat (≥3 turns) → profile-confirm →
      resume-text, producing the 3 evidence artifacts. Runbook:
      [b1-device-capstone-runbook.md](qa/b1-device-capstone-runbook.md); plan:
      [phase-1-alpha-device-capstone.md](qa/phase-1-alpha-device-capstone.md); status:
      [alpha-capstone-fixlist.md](registers/alpha-capstone-fixlist.md).
- [ ] **Staging prerequisite for B1:** DevOps has stood up the staging API + Supabase +
      Redis and provided a concrete HTTPS URL (`GET <staging-api>/health` → `200`).
      Until this exists, B1 stays NO-GO regardless of the other boxes.

> Per the runbook, B1 is the **sole** alpha blocker — everything else (G1c in-app PDF,
> G2 voice, G3 interview kit) is post-cut. Do not flip the alpha verdict on prep alone.
