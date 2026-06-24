# BUG-2 — Staging demand-loop deploy runbook (provision → migrate → seed → verify → rollback)

> **Why this exists:** the employer/unlock demand loop is **built and CI-green but
> un-deployed** — BUG-2 is the gap that no reachable environment has the employer/unlock
> schema, so the loop has never recorded a single event
> ([ops-employer-workflow-runtime-verification.md](../qa/ops-employer-workflow-runtime-verification.md)).
> This runbook is the **deploy-side checklist** that turns "stand up staging and prove the
> loop" into a copy-paste exercise. It does **not** duplicate the click-path / SQL asserts /
> PASS-FAIL report — those live in the cross-linked QA doc; this is provision → secrets →
> migrate → seed → start → verify → rollback + a consolidated failure-triage table.
>
> **Read first:** [CLAUDE.md](../../CLAUDE.md) §7 (escalation) ·
> [ops-employer-workflow-runtime-verification.md](../qa/ops-employer-workflow-runtime-verification.md)
> (the detailed click-path §1.3 / SQL §1.4 / PASS-FAIL report — **the verdict doc**) ·
> [b1-device-capstone-runbook.md](../qa/b1-device-capstone-runbook.md) (the staging-prereq pattern) ·
> [ADR-0010](../decisions/0010-contact-unlock-and-reveal.md) (unlock→reveal spine) ·
> [ADR-0013](../decisions/0013-monetization-and-config-driven-pricing-engine.md) (pricing/credits, mock payments).
>
> **MOCK-only, non-negotiable:** `PAYMENTS_ENABLE_REAL=false`, `AI_ENABLE_REAL_CALLS=false`,
> `MESSAGING_ENABLE_REAL=false`. Flipping any provider is a separate **CLAUDE.md §7** gate and is
> **out of scope** here.

---

## Purpose + scope

| | |
| --- | --- |
| **Goal** | Make the staging demand-loop **proof** a turnkey checklist so a human can clear **BUG-2**. |
| **In scope** | The deploy sequence (provision → secrets → migrate → seed → start → verify → rollback) + failure triage. |
| **Out of scope** | Provisioning the actual Supabase project, **holding any secret**, and **running** the loop — all three are a **human CLAUDE.md §7 action** (touches infra + real PII at reveal). Flipping any provider gate to real. |
| **Target** | A **disposable, non-prod staging DB**. Driving reveal/disclosure decrypts real PII; doing that against a shared/real DB is a §7 escalation — **never** run this against prod. |
| **Done bar** | `db:verify:demand` prints its PASS line (all six events) **and** a human completes the §1.3 click-path in the cross-linked doc. **BUG-2 stays OPEN until a human reports a staging PASS.** |

---

## Prerequisites — the §7 human gate (cannot be automated)

These are **human/devops** preconditions. This runbook (and the companion CD workflow) is
**inert** until they are satisfied.

1. **Provision a Supabase STAGING project** (separate from prod) and capture its connection
   string. Standing up infra + holding its secrets is a **CLAUDE.md §7** action — Claude cannot
   do it.
2. **Hold the staging secrets** (DB URL + PII keys + service token) in a secrets store / the
   filled-in env files below. **No secret value belongs in git** (placeholders only here).
3. **CI is green** on the commit being deployed: `pnpm lint && pnpm typecheck && pnpm test &&
   pnpm build` plus the AI service `ruff check .` + `pytest`. CI-green ≠ works — that is exactly
   why this runbook exists — but a red CI must not be deployed.
4. **Confirm the target is disposable + non-prod.** The seed is synthetic, but the loop
   **decrypts a fixture phone at reveal**; only ever point it at a throwaway staging DB.

---

## Ordered deploy steps

Run from the **repo root** unless noted. Steps **5 vs 6/7/8 scoping matters** — see the
script-scoping note under the env table.

```bash
# (1) PROVISION — human §7. Stand up a disposable, non-prod Supabase staging project and
#     capture its session-pooler connection string as DATABASE_URL (sslmode=require).
#     Nothing to run here; this is the human infra step.

# (2) SET SECRETS — fill the canonical env templates (do NOT commit them). See the env table
#     below for every required var. The fill-in files already exist on main:
#       apps/api/.env.staging.example          -> apps/api/.env.staging        (or your secret store)
#       apps/ai-service/.env.staging.example   -> apps/ai-service/.env.staging (mock gates stay false)
#     The PII_ENCRYPTION_KEY / PII_HASH_PEPPER you set here MUST be reused verbatim in steps 6 & 7.

# (3) INSTALL + BUILD (Turbo dependency order builds @badabhai/* first).
pnpm install
pnpm build

# (4) MIGRATE to head — apply the full chain to the staging DB. §7 human-credentialed.
DATABASE_URL=<staging-db> pnpm db:migrate

# (5) SEED THE SWIPE JOBS (ADR-0009 `jobs` table) — package-scoped script.
#     The /reach applicant feed ranks against this table, so feed.shown needs it.
DATABASE_URL=<staging-db> pnpm --filter @badabhai/db db:seed:jobs

# (6) SEED THE DEMAND FIXTURE — synthetic faceless worker + profile + employer_sharing
#     consent + one OPEN job_posting + a credited payer (25 credits). Idempotent +
#     prod-guarded (refuses NODE_ENV=production). The PII keys MUST be byte-identical to
#     the ones the API uses in step 7 (any valid values — they just must match).
#     This is "Mode A" (NODE_ENV=development) — see the two run modes below.
DATABASE_URL=<staging-db> \
PII_ENCRYPTION_KEY=<key> \
PII_HASH_PEPPER=<pepper> \
NODE_ENV=development \
pnpm db:seed:demand

# (7) START THE API against the same DB. The reach feed binds JobsTableJobSource
#     UNCONDITIONALLY (apps/api/src/reach/reach.module.ts), so NODE_ENV does NOT gate
#     feed.shown — NODE_ENV only controls the SECRETS posture. For a pure demand-loop
#     proof use NODE_ENV=development (Mode A): it boots mock-only with no JWT_SECRET /
#     SMS provider. The PII keys MUST be byte-identical to step 6, or reveal's decrypt
#     fails closed (see the #1 failure mode in the triage table).
NODE_ENV=development \
DATABASE_URL=<staging-db> \
PII_ENCRYPTION_KEY=<key> \
PII_HASH_PEPPER=<pepper> \
INTERNAL_SERVICE_TOKEN=<token> \
PAYMENTS_ENABLE_REAL=false \
AI_ENABLE_REAL_CALLS=false \
MESSAGING_ENABLE_REAL=false \
pnpm --filter @badabhai/api start
# Wait for: GET <staging-api>/health -> 200 {"status":"ok"}

# (8) VERIFY — drive plan → applicants → unlock → reveal through the real HTTP API and
#     assert the events spine. INTERNAL_SERVICE_TOKEN must be the SAME as step 7; set
#     API_BASE_URL to the running API (see the port gotcha in the env table).
API_BASE_URL=<staging-api> \
INTERNAL_SERVICE_TOKEN=<token> \
DATABASE_URL=<staging-db> \
pnpm db:verify:demand
```

> **Script-scoping note:** `db:migrate`, `db:seed:demand`, `db:verify:demand` are **root**
> scripts (run from root). `db:seed:jobs` is **package-scoped** → it must be run as
> `pnpm --filter @badabhai/db db:seed:jobs` (or from `packages/db`).

> **NODE_ENV does NOT gate the feed.** `apps/api/src/reach/reach.module.ts` binds
> `JOB_SOURCE` to `JobsTableJobSource` **unconditionally** (the old dev-only `StubJobSource` +
> its `isDevEnv` gate were removed), so the real `jobs` feed serves `feed.shown` in
> `NODE_ENV=development` too. `NODE_ENV` here controls only the **secrets posture** (the boot
> asserts in `packages/config/src/server.ts`), not the feed. The seed (step 6) only needs
> `NODE_ENV` to be **anything but `production`** (its prod guard).

### Two run modes (pick one)

| | **Mode A — disposable demand-loop proof** (RECOMMENDED) | **Mode B — full staging-service posture** |
| --- | --- | --- |
| **`NODE_ENV`** | `development` | `staging` |
| **Used by** | the proof itself, the CI workflow (`staging-demand-verify.yml`), and a local run | a real staging service stand-up |
| **Boot secrets** | mock-only: no `JWT_SECRET`, no SMS provider needed (`SMS_PROVIDER=console` allowed) | **fails closed unless** you also set a real `JWT_SECRET`, a non-`console` `SMS_PROVIDER` (`fast2sms` + `FAST2SMS_API_KEY` / `FAST2SMS_SENDER_ID` / `FAST2SMS_DLT_TEMPLATE_ID`), AND real (non-default) PII keys — per the full `apps/api/.env.staging.example` |
| **PII keys** | any valid values, but the **same** for `db:seed:demand` and the API (so reveal decrypts) | real, non-default keys (also required by the boot assert), still the **same** seed ↔ API |
| **Mock gates** | `PAYMENTS_ENABLE_REAL` / `AI_ENABLE_REAL_CALLS` / `MESSAGING_ENABLE_REAL` = `false` | same — `false` |
| **`feed.shown`** | works (feed binds unconditionally) | works |

> **Why Mode A for the proof:** the demand loop does **not** exercise OTP, but in Mode B the
> boot assert (`assertAuthConfig` / `assertPayerAuthConfig`) still **requires a real SMS provider
> + `JWT_SECRET`** just to boot — none of which the loop uses. So for a pure demand-loop proof,
> prefer **Mode A**; reserve Mode B for standing up the full staging service. Either way the PII
> keys for `db:seed:demand` and the API must match.

---

## Env vars — the `.env.staging.example` substitute (placeholders only)

These are the variables a human fills into the **canonical templates** — do not paste real
values here or anywhere in git. Canonical fill-in files (already on main):
`apps/api/.env.staging.example` and `apps/ai-service/.env.staging.example`.

The **Mode** column tags when each var is required: **both** = core 5, needed in either run
mode; **Mode B** = only when running the full staging-service posture (`NODE_ENV=staging`).

| Var | Mode | Purpose | Where used | Placeholder |
| --- | --- | --- | --- | --- |
| `DATABASE_URL` | both | Connection string to the **disposable non-prod** staging Postgres (Supabase session pooler, `sslmode=require`). | migrate, both seeds, API, verify (read-only event assert) | `postgresql://USER:PASS@HOST:5432/postgres?sslmode=require` |
| `PII_ENCRYPTION_KEY` | both | AES-256-GCM key the seed encrypts the synthetic phone with — **must be byte-identical** between seed (step 6) and API (step 7) or reveal fails closed. (Mode B additionally requires a **real, non-default** key.) | seed-demand, API | `<32-byte-base64-key>` |
| `PII_HASH_PEPPER` | both | HMAC pepper for the peppered phone hash — **must match** seed ↔ API alongside the key. (Mode B additionally requires a **real, non-default** pepper.) | seed-demand, API | `<random-pepper>` |
| `INTERNAL_SERVICE_TOKEN` | both | Shared secret for `InternalServiceGuard` on `/unlocks*`; the verifier sends it as `x-internal-service-token`. **Same value** in API (step 7) and verify (step 8). | API, verify | `<shared-internal-token>` |
| `API_BASE_URL` | both | Base URL the verifier hits. Defaults to `http://localhost:3000`, **but the API's own default port is `3001`** (`packages/config` `API_PORT`). For a local run you **must** set `http://localhost:3001` (or start the API on 3000). | verify | `https://STAGING-API` (local: `http://localhost:3001`) |
| `NODE_ENV` | both | `development` for the demand-loop proof (Mode A — boots mock-only). The reach feed binds `JobsTableJobSource` **unconditionally** (`reach.module.ts`), so this controls only the **secrets posture**, not the feed. `staging` selects Mode B (boot asserts demand JWT + a real SMS provider + real PII keys). | API, seed | `development` (Mode A) / `staging` (Mode B) |
| `PAYMENTS_ENABLE_REAL` | both | MOCK-only gate. **Must stay `false`** — real payments are a §7 gate, out of scope. | API | `false` |
| `MESSAGING_ENABLE_REAL` | both | MOCK-only gate. **Must stay `false`** — real telephony/relay is a §7 gate. | API / ai-service | `false` |
| `AI_ENABLE_REAL_CALLS` | both | MOCK-only gate. **Must stay `false`** — real LLM calls are a §7 gate. | ai-service | `false` |
| `JWT_SECRET` | Mode B | Worker/payer session signing secret. Dev default is allowed in Mode A; in Mode B (`NODE_ENV=staging`) `assertAuthConfig` / `assertPayerAuthConfig` **fail closed** unless it is overridden. The demand loop does not use sessions, so it is needed in Mode B only to BOOT. | API | `<random-32+char-secret>` |
| `SMS_PROVIDER` | Mode B | OTP delivery channel. `console` is allowed in Mode A; in Mode B `assertAuthConfig` **rejects `console`** (it logs codes) and requires `fast2sms` plus `FAST2SMS_API_KEY` / `FAST2SMS_SENDER_ID` / `FAST2SMS_DLT_TEMPLATE_ID`. The demand loop does not send OTPs — this is a Mode-B boot requirement only. | API | `console` (Mode A) / `fast2sms` (Mode B) |

---

## PASS / evidence criteria

The verifier (`packages/db/src/verify-demand.ts`) PASSES only when the `events` spine recorded
**all six required events** since the run started:

```
feed.shown · job_posting.purchased · payment.authorized · payment.captured · unlock.granted · contact.revealed
```

The exact PASS line to look for in stdout:

```
[verify:demand] PASS — all demand-loop events recorded: feed.shown, job_posting.purchased, payment.authorized, payment.captured, unlock.granted, contact.revealed
```

**Evidence to capture (attach to the BUG-2 close-out):**

- [ ] **stdout of all four runnable steps** — `db:migrate` (step 4), `db:seed:jobs` (step 5),
      `db:seed:demand` (step 6, prints the `5eeded00-…` ids), `db:verify:demand` (step 8, the
      PASS line above).
- [ ] **The `events` rows** for the six required events (the read-only query the verifier runs;
      mirror it from the cross-linked doc §1.4 if you want the per-event payloads).
- [ ] Confirmation the target was a **disposable non-prod** DB.

> **Verify scope (do NOT over-claim):** `db:verify:demand` asserts the **six** events above
> only. It does **NOT** assert `job_posting.created` (it purchases a plan on the seed's
> already-`open` posting; it never POSTs a new draft), nor `resume.disclosed` (a separate
> `/resume-disclosures` call), nor `capacity.purchased` / `coupon.redeemed`. Those belong to
> the **human §1.3 click-path** in
> [ops-employer-workflow-runtime-verification.md](../qa/ops-employer-workflow-runtime-verification.md) —
> a green verifier is the **backend** proof; the click-path is the **UI/PII** proof. Both are
> required to close BUG-2.

---

## Rollback

Staging here is **disposable, non-prod**, and the seed is **synthetic + idempotent +
prod-guarded** (`NODE_ENV !== "production"`) — so re-runs are safe and no production data is
ever touched at any point in this runbook.

| Situation | Rollback action |
| --- | --- |
| Bad seed / dirty fixture state | Re-run `db:seed:demand` — it is idempotent (stable `5eeded00-…` ids + `ON CONFLICT`; payer credits are re-topped to 25). No teardown needed. |
| Bad migration / corrupt staging DB | **Tear down / reset the staging DB** and re-run steps 4→8. Because it is disposable non-prod, a full reset is the cheapest rollback. **Never** run a destructive op against prod. |
| Bad code shipped to staging | **Revert the PR**; redeploy the prior build. Code rollback is independent of the data steps. |
| Provider gate accidentally flipped | Stop the API; restart with `PAYMENTS_ENABLE_REAL=false` / `AI_ENABLE_REAL_CALLS=false` / `MESSAGING_ENABLE_REAL=false`. (These default safe; an explicit `true` is a §7 violation here.) |

No step in this runbook touches production data. The highest-risk operation — a reveal that
decrypts a phone — only ever decrypts the **synthetic fixture** phone on the disposable DB.

---

## Failure-mode triage

The four failure modes, mapped Symptom → Root cause → Fix. Rows **(a)–(c)** are the messages the
verifier itself surfaces (Symptom = **verbatim** `verify-demand.ts`); row **(d)** is the API
boot-assert that stops the run before the verifier can connect (Symptom = **verbatim**
`packages/config/src/server.ts`).

| # | Symptom (verbatim) | Root cause | Fix |
| - | --- | --- | --- |
| **(a)** PII key mismatch — the **#1 failure mode** | `[verify:demand] unlock returned the neutral body — check consent/credits/seed, INTERNAL_SERVICE_TOKEN, and that the seed used the API's PII keys.` | The API (step 7) ran with a **different** `PII_ENCRYPTION_KEY` / `PII_HASH_PEPPER` than the seed (step 6) used. Reveal's `decrypt` of the synthetic phone fails closed → unlock returns the neutral body → no `unlock_id` → no `contact.revealed`. | **Restart the API with the seed's exact `PII_ENCRYPTION_KEY` + `PII_HASH_PEPPER`** (or re-run `db:seed:demand` with the API's keys). The two **must** be byte-identical. |
| **(b)** Missing service token | `[verify:demand] INTERNAL_SERVICE_TOKEN is not set (required for /unlocks).` | The verifier has no `INTERNAL_SERVICE_TOKEN`, so the `/unlocks*` `InternalServiceGuard` rejects the request. | **Export the same `INTERNAL_SERVICE_TOKEN` the API was started with** (step 7) into the verify invocation (step 8). |
| **(c)** Missing migrations / seed | `[verify:demand] DATABASE_URL is not set` **or** `[verify:demand] FAIL — missing events: <names>` (tables/rows absent → events never fire) | Either no `DATABASE_URL`, or the DB was not migrated / seeded — the demand tables or fixture rows are absent, so steps in the loop emit nothing. | **Run `db:migrate` + `db:seed:jobs` + `db:seed:demand` against the SAME DB first** (steps 4→6), confirm `DATABASE_URL` is set, then re-verify. |
| **(d)** API refuses to boot (Mode-B posture without the secrets) | `Insecure PII secret(s) outside an explicit development/test environment: …` **OR** `Insecure/incomplete auth config outside an explicit development/test environment: …` | The API was started with `NODE_ENV=staging` (Mode B) but with **dev-default PII keys** / `SMS_PROVIDER=console` / an **unset (dev-default) `JWT_SECRET`** — the fail-closed boot asserts (`assertPiiCryptoConfig` / `assertAuthConfig` / `assertPayerAuthConfig`) reject it. The verifier then can't connect. | **Provide the full Mode-B staging secrets** (real PII keys + `JWT_SECRET` + `SMS_PROVIDER=fast2sms` + its keys), **or** run the proof in **Mode A** (`NODE_ENV=development`), which boots mock-only since the demand loop uses none of them. |

> The `FAIL — missing events: <names>` form names exactly which of the six did not land — use it
> to localize: missing `feed.shown` ⇒ `db:seed:jobs` not run (the feed binds unconditionally, so
> `NODE_ENV` is **not** the cause); missing `contact.revealed` only ⇒ almost always failure mode
> **(a)** (PII key mismatch). If the verifier never even connects, suspect failure mode **(d)** (the
> API failed its boot asserts). **If `/unlocks` returns `401`**, the R16/LC-1 payer-auth retrofit
> has landed on the ops routes — see *Forward-port trigger* below (the verifier needs porting).

---

## Forward-port trigger — when R16/LC-1 (payer auth) lands

> **Status today (current `main`):** `verify-demand` drives the loop over the **ops** surface —
> `POST /job-postings/:id/plan` (unguarded) + `GET /reach/jobs/:jobId/applicants` (unguarded) +
> `POST /unlocks` / `POST /unlocks/:id/reveal` (`InternalServiceGuard` + body `payer_id`). This is
> correct and **PASSes as-is** — **no forward-port is needed now.**

The R16/LC-1 PayerAuthGuard retrofit (branch `feat/r16-lc1-payer-auth-close`, **unmerged**) puts
`PayerAuthGuard` on `POST /unlocks*`. **When that branch merges, `verify-demand` will return `401`
on the unlock + reveal steps** and must be forward-ported:

1. **Log in as the demand payer** (payer email-OTP → `Bearer`) and call the **payer-authed** unlock
   surface — `POST /payer/unlocks` + `POST /payer/unlocks/:unlockId/reveal`
   ([`apps/api/src/payer-portal/payer-unlocks.controller.ts`](../../apps/api/src/payer-portal/payer-unlocks.controller.ts)) —
   dropping the body `payer_id` (the session carries it, XB-A).
2. **Seed a `payers` ACCOUNT row** for `PAYER_ID` in
   [`seed-demand.ts`](../../packages/db/src/seed-demand.ts) (today it seeds only `payer_credits`),
   so the login resolves — `email_enc` / `org_name_enc` / `role='employer'`.
3. **KEEP `job_posting.purchased` on the unguarded `POST /job-postings/:id/plan`.** There is **no
   PayerAuth route that emits `job_posting.purchased`** (`PayerCapacityController` emits
   `capacity.purchased`, not it), so the plan-purchase step stays on the ops route until a
   payer-authed plan endpoint exists — the ported loop is a **hybrid**, not pure-payer.
4. `feed.shown` may optionally move to the payer-authed `GET /payer/reach/jobs/:jobId/applicants`.

Tracked as **TD50** (cross-link **TD33** — the `PayerAuthGuard` build). **Do not** forward-port
before R16 merges: it would break the verifier against current `main` **and** still cannot be a
pure-payer loop (step 3).

---

## Real-LLM extraction flip — OPTIONAL, separate §7 gate (AFTER the demand-loop PASS)

> **This is NOT part of the demand-loop proof above.** Everything before this section runs
> **MOCK-AI** (`AI_ENABLE_REAL_CALLS=false`) and **stays that way** — the demand-loop PASS is a
> mock-AI proof and does not depend on, nor unlock, real LLM extraction. Flipping the AI service
> to real Gemini extraction is its **own, later CLAUDE.md §7 human gate**: it happens **after** a
> staging demand-loop PASS, it is **optional**, and **provisioning + running it stay a human
> action** (a funded provider key + spend are involved). This section is the **deploy-side
> pointer** only — the AI-service rollout, the full flip env, the eval methodology, and the
> GO/NO-GO verdict live in the two cross-linked `docs/ai/*` docs below; **do not duplicate them
> here.**

### Ordered flip steps (deploy-side)

> **(PRECONDITION — keys, go-no-go Finding 3) Rotate the dev-box Gemini + Anthropic keys and remove
> them from any dev laptop BEFORE the flip.** Real keys live ONLY in the staging/prod secret store —
> provision the funded `GEMINI_FLASH_API_KEY` (and the OPTIONAL `ANTHROPIC_API_KEY`) there, never on
> a dev box, never in git. A dev box that ever held a real key with `AI_ENABLE_REAL_CALLS=true` must
> have that key rotated **and** removed before the flip.

1. **(PRECONDITION) Provision Redis + set `REDIS_URL` BEFORE the flip — the spend ledger fails
   CLOSED (TD27 / go-no-go Finding 5).** With `REDIS_URL` **unset**, the spend caps are enforced
   **per Uvicorn worker**, so total spend can reach **N × cap** across N workers — never flip with
   it unset. With `REDIS_URL` **set but Redis unreachable**, real calls are **blocked → mock**
   (fail-closed; never unbounded). Confirm `GET /health` reports `spend_store: redis` (not
   `in_process`) before proceeding.
2. **Deploy / run the AI service against staging.** It is **host-run today** (no AI-service
   container in compose) and reaches the compose Redis at `redis://localhost:6379/0` per go-no-go
   Finding 5 — so on a host-run AI service, `REDIS_URL` points at the compose Redis on
   `localhost:6379`. Full rollout steps: `docs/ai/enable-real-llm-extraction.md`.
3. **Run the pre-flip validation gate on a FUNDED staging key — MUST PASS.** From
   `apps/ai-service`:
   ```bash
   python -m app.profiling.eval_canonicalization --flip-gate --base-url <STAGING_URL>
   ```
   PASS iff **role accuracy ≥ 90%** AND **every per-field ≥ 90%** AND **zero mock-fallback**; it
   prints a p95 latency and **exits non-zero (STOP) on any miss**. **If < 90% on
   `gemini-2.5-flash`, STOP — do not ship the flip.** This must run against a **funded** key (a
   mock/unfunded run cannot prove the gate).
4. **Apply the flip env diff** (table below) to the AI-service staging env, then restart the
   service. The authoritative, authorized diff is in
   `docs/ai/real-llm-flip-go-no-go.md` ("When the flip IS authorized").
5. **Verify `GET /health`** now reports `real_calls_enabled: true` **and** `spend_store: redis`.
   If `spend_store` is `in_process`, **roll back immediately** (step 6) — `REDIS_URL` is not
   wired and caps are per-worker.
6. **Rollback** — instant, no deploy (see the Rollback note below).

### FLIP env vars (placeholders only — NO secrets)

These are the **AI-service** flip vars. Fill them into the AI-service staging env; **never** paste
real values into git.

| Var | Purpose | Placeholder | Notes |
| --- | --- | --- | --- |
| `REDIS_URL` | Backs the **shared** spend ledger so caps are global, not per-worker. **PRECONDITION — set FIRST, before the flip.** Fail-closed: unset ⇒ per-worker caps (N × cap); set-but-unreachable ⇒ real calls blocked → mock. | `redis://localhost:6379/0` (host-run AI service → compose Redis) | Confirm via `GET /health` → `spend_store: redis`. |
| `AI_ENABLE_REAL_CALLS` | Master flip — turns real extraction ON. | `true` (flip) / `false` (default + rollback) | Default + every committed example **stays `false`**. |
| `AI_REAL_CALL_TASKS` | Allow-list of tasks that may use real calls. | `profile_extraction` | Clearing it is an instant rollback. |
| `GEMINI_FLASH_API_KEY` | Funded staging Gemini key for `gemini-2.5-flash`. | `<funded-staging-gemini-key>` | §7 secret — human-held; never in git. |
| `DEFAULT_CAPABLE_MODEL` | Selects the extraction model. | `gemini-2.5-flash` | The model the `--flip-gate` must PASS on. |
| `AI_REAL_CALLS_KILL_SWITCH` | Emergency global off-switch; `true` forces mock regardless of the flags above. | `false` (keep) | Set `true` for instant rollback. |
| `AI_MAX_DAILY_COST_INR` | Rolling per-UTC-day spend cap (INR), enforced via the Redis ledger. | `200` (default) | Keep **at policy**; do not raise to flip. |
| `AI_MAX_TOTAL_COST_INR` | Process-lifetime cumulative spend cap (INR). | `1000` (default) | Keep at policy. |
| `AI_MAX_USER_DAILY_COST_INR` | Per-user (opaque `worker_ref`) per-UTC-day cap (INR) — the user-facing budget. | `6` (default) | Keep at policy. |
| `AI_MAX_CALL_COST_INR` | Hard per-call worst-case ceiling (INR); a pricier call falls back to mock. | `10` (default) | Keep at policy. |
| `ANTHROPIC_API_KEY` | **OPTIONAL** — adds the Claude Haiku fallback transport. | `<staging-anthropic-key>` (optional) | Now **also requires the `anthropic` SDK installed**: the router self-disables a key-set-but-SDK-absent fallback (see the `fallback_transport_available` gate / `test_ai_router.py`). Omit it to run Gemini-only. |

> **`.env.staging.example` guard limit + `REDIS_URL` gap (action for the human maintainer):** the
> PreToolUse guard **blocks automated reads/writes of any `.env.*` file**, so this runbook **cannot
> edit** `apps/ai-service/.env.staging.example` (or `apps/api/.env.staging.example`) — the table
> above is the placeholder substitute. Critically, `apps/ai-service/.env.staging.example`
> **predates the Redis spend ledger**, so it likely **does NOT carry `REDIS_URL`**. The **human
> maintainer must ensure that template carries `REDIS_URL` plus the flip vars above** before
> flipping — otherwise the ledger silently runs per-worker (N × cap).

### Rollback (instant — no deploy)

Any **one** of these returns extraction to mock with **no redeploy** (just restart / hot-reload
the env):

- `AI_ENABLE_REAL_CALLS=false`, **or**
- clear `AI_REAL_CALL_TASKS` (empty), **or**
- `AI_REAL_CALLS_KILL_SWITCH=true`.

After rollback, confirm `GET /health` → `real_calls_enabled: false`. The full rollback narrative
+ the authorized diff are in `docs/ai/real-llm-flip-go-no-go.md`.

### Flip cross-links (detail lives there — do not duplicate)

- [enable-real-llm-extraction.md](../ai/enable-real-llm-extraction.md) — the **AI-service
  rollout**, the full flip env, and rollback mechanics.
- [real-llm-flip-go-no-go.md](../ai/real-llm-flip-go-no-go.md) — the **GO verdict + Findings**,
  the **authorized flip env diff**, and the rollback of record (incl. Finding 5 = the Redis
  fail-closed precondition).

---

## Cross-links

- [ops-employer-workflow-runtime-verification.md](../qa/ops-employer-workflow-runtime-verification.md)
  — the detailed **click-path (§1.3)**, **SQL asserts (§1.4)**, and the **PASS/FAIL report**.
  This runbook is the deploy side; that doc is the verdict side. Do not duplicate it.
- [b1-device-capstone-runbook.md](../qa/b1-device-capstone-runbook.md) — the staging-prereq
  pattern (no HTTPS staging URL exists yet; devops must provide one).
- [ADR-0010](../decisions/0010-contact-unlock-and-reveal.md) — contact unlock + reveal spine.
- [ADR-0013](../decisions/0013-monetization-and-config-driven-pricing-engine.md) — pricing /
  credits, mock payments.
- [enable-real-llm-extraction.md](../ai/enable-real-llm-extraction.md) /
  [real-llm-flip-go-no-go.md](../ai/real-llm-flip-go-no-go.md) — the **separate, later** real-LLM
  extraction flip (see the dedicated flip section above). MOCK-AI stays the default here.
- Registers: alpha blockers / fixlist + tech-debt (TD27 Redis spend ledger, TD33 payer auth,
  TD34 real payments, **TD50 verify-demand R16 forward-port trigger**) track the deferred
  real-money / real-provider / per-payer-auth portions.

> **BUG-2 stays OPEN until a human reports a staging PASS** — a green `db:verify:demand` **and**
> the human §1.3 click-path, both against a disposable non-prod target.
