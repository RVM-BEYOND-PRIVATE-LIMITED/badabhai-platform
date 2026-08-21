# BadaBhai Architecture Status

> **What this document is.** The architecture that exists on `main` **today**, measured from the
> repository, from CI run history, and from read-only queries against the production database. It
> is not the intended architecture and not a plan.
>
> **Compiled:** 2026-08-21 · `main` @ `2cf0aa05` · production DB cluster `7642734024280108049`
> **Method:** every number below came from a command. Where something was NOT verified, it says so.
> **Nothing in this document mutated anything.**

---

## Scoreboard

```
BadaBhai Architecture Status

Overall:                     NOT MEASURABLE  (see note)

Production blockers:         3  (see "Production blockers" below)
Critical features complete:  NOT MEASURABLE — 8 of 22 feature rows are production-verified
Architecture components:     8 of 9 running and health-gated in production
Database/migration status:   87 of 87 recorded · 0 orphans · contract READY · RLS 78/78
AI pipeline:                 1 of 6 provider tasks armed for real calls in production
Taxonomy Phase 9:            4 DONE · 1 DECISION REQUIRED · 3 BLOCKED · 5 DEFERRED
Observability:               3 of 5 wired · 1 unverified in production
Security:                    RLS 78/78 · schema contract READY · 4 write runners unguarded

Current phase:    Post-deploy stabilisation. Production is live and serving traffic.
Next milestone:   Close the 3 production blockers; leave taxonomy where it stands.
Current blocker:  D2 Path-B parity is failing (DECISION REQUIRED, not a product outage).
Next 3 actions:   1. Decide Path-B (accept / roll back) — unblocks nothing else, but it is open.
                  2. TD2 — Fast2SMS live-send proof. Real workers cannot receive OTP without it.
                  3. TD73 — GET /feed must exclude decided jobs server-side.
```

**Why "Overall %" is NOT MEASURABLE.** There is no weighting of features to a denominator that
would not be invented. Counts are given instead, and every count below is traceable to a command.

---

## Work classification

Every item in this document carries one of these. The user's question — *how much actual BUILD
remains* — is answered in [§4](#4-minimum-production-ready-path).

| tag | meaning |
|---|---|
| **BUILD** | create or fix functionality |
| **VERIFY** | prove existing functionality |
| **DECISION** | requires a product/business decision |
| **HARDENING** | safety / security / reliability |
| **EXPERIMENT** | optional research or evaluation |
| **DEFERRED** | intentionally postponed |

**Honest summary of the last stretch of work:** overwhelmingly VERIFY and HARDENING. The
taxonomy work (Phase 9, D2, #1110, the ops-guard migration) produced **zero new end-user
functionality**. That is the concern the owner raised and the measurements support it.

---

## A. System architecture

### What is actually running in production

Production is a single AWS Lightsail box, deployed by `ci.yml`'s `deploy-lightsail` job under the
`production` GitHub environment (required reviewers: kpdagrt22, divyuuu). Last successful deploy
**2026-08-21 05:49 UTC**, commit `a152973`, all four images pulled and health-gated.

> ⚠ **The compose file is named `docker-compose.staging.yml` but IS the production overlay.**
> Deliberate, documented in `ci.yml`. Do not read the filename as the environment.

```
  Worker Android App (Flutter)  ─┐
  Payer Android App  (Flutter)  ─┤
  payer-web  (Next.js)          ─┼──►  API (NestJS)  ──►  Postgres  = SUPABASE (ap-south-1)
  admin-web  (Next.js)          ─┘        │                          NOT the box's local pg
                                          ├──►  Redis (box-local, sessions/OTP/BullMQ)
                                          │
                                          └──►  AI Service (FastAPI, 127.0.0.1:8000)
                                                    ├──►  Gemini   (gemini-embedding-001, flash)
                                                    ├──►  Anthropic
                                                    └──►  Langfuse (tracing)
```

| component | state | evidence |
|---|---|---|
| API (NestJS) | ✅ | `api healthy after attempt 3`, deploy 2026-08-21 05:49 UTC |
| AI Service (FastAPI) | ✅ | `ai-service healthy after attempt 3`, `Up (healthy)` on 127.0.0.1:8000 |
| payer-web | ✅ | `payer-web healthy after attempt 2` |
| admin-web | ✅ | `admin-web healthy after attempt 2` |
| Redis (box-local) | ✅ | `badabhai-redis … Up 46 hours (healthy)` |
| Postgres — **Supabase** | ✅ | serving live traffic: newest event **3 min old**, 1,714 events/24h |
| Postgres — box-local `pgvector/pg16` | 🟡 | `Up 5 weeks (healthy)` but **not the DB the app serves**; role unverified |
| Worker Android App | 🟡 | builds + releases APK in CI; alpha flows incomplete (TD29, P0) |
| Payer Android App | 🟡 | builds + releases APK in CI; not production-verified |
| Staging environment | 🔴 | staging CD **has never run** (TD123, P0); staging is a manual deploy |

**The box-local postgres is a live ambiguity.** It has been up 5 weeks and is healthy, but the
application's `DATABASE_URL` (a `production`-scoped GitHub secret) demonstrably points at
Supabase — production traffic lands there. Whether the local container is vestigial, a
leftover from the pre-Supabase era, or serving something else **was not determined** and is worth
one hour of someone's time. It is not currently breaking anything.

### Correction to the tech-debt register

Two P0 rows are **stale for production** and should be re-scoped to staging:

- **TD81** *"ai-service is not deployed"* — **false for production.** The ai-service is deployed,
  health-gated, and was recreated on today's deploy. TD81 is accurate only for the *staging*
  pipeline, which by construction deploys no ai-service.
- **TD52** *"Staging runs `NODE_ENV=development`"* — the **production** overlay pins
  `NODE_ENV: production` explicitly. Accurate for staging only.

---

## B. Feature status

Legend: **PV** = production-verified (evidence from the production database or a production run).

| feature | implemented | production verified | known blocker | owner |
|---|---|---|---|---|
| Onboarding | ✅ full | ✅ **PV** — 114 workers | — | Backend + Mobile |
| OTP / authentication | ✅ full | 🟡 test-login path proven in E2E; **real Fast2SMS send never proven** | **TD2 (P0)** | Backend |
| Worker profile | ✅ full | ✅ **PV** — 42 worker_profiles | — | Backend |
| AI profiling / chat | ✅ full | ✅ **PV** — 107 chat_sessions, 133 ai_call_traces | — | AI + Backend |
| Voice notes | ✅ implemented | 🔴 **never used in production — `voice_notes` = 0 rows** | STT not armed | Mobile + AI |
| Resume generation | ✅ full | ✅ **PV** — 29 generated_resumes | runs on **mock** provider | AI |
| Skill extraction | ✅ full | 🟡 runs on **mock** (`profile_extraction` not armed) | flag scope | AI |
| Skill canonicalization | ✅ built | ⏸️ **disabled** — `SKILL_CANONICALIZE_ENABLED=false` | intentional | AI + Backend |
| Taxonomy | ✅ built | 🟡 seeded today; not serving | Phase 9 gates | Backend |
| Embeddings | ✅ full | ✅ **PV** — 336/336 skill aliases, 9,121 domain aliases | — | Backend + AI |
| Matching | ✅ built | ⏸️ **disabled** — `MATCH_V1_ENABLED=false` | intentional | Backend |
| Job / domain matching | ✅ built | ⏸️ **disabled** — `DOMAIN_MATCH_ENABLED=false` | intentional | Backend |
| Employer / job posting | ✅ full | ✅ **PV** — 8 job_postings, 19 jobs, 13 payers | — | Backend + Frontend |
| Applications | ✅ full | ✅ **PV** — 23 applications | **TD73 (P0)** feed leak | Backend |
| Notifications / push | ✅ full | 🟡 wired; delivery not verified | — | Backend + Mobile |
| Payments / payouts | ✅ built | 🟡 Razorpay webhook + credits; real-money not proven | Razorpay creds | Backend + Frontend |
| KYC | ✅ built | 🟡 agency KYC tables + ops controller | — | Backend |
| Admin | ✅ full | 🟡 13 admin controllers; admin-web deployed | — | Backend + Frontend |
| Feedback | ✅ full | 🟡 `worker_feedback` shipped (0080/0081) | — | Backend |
| Crashlytics | ✅ wired | 🟡 `crash_reporter.dart` + route observer | not verified live | Mobile |
| Langfuse / tracing | ✅ wired | 🟡 keys bridged in deploy; traces not verified | not verified live | AI |
| CI/CD | ✅ full | ✅ **PV** — deploy succeeded today | **TD131** SAST flaky | DevOps |
| Production deployment | ✅ full | ✅ **PV** — 4 services health-gated | **TD123** staging never ran | DevOps |

**Counts:** 22 rows · **8 production-verified** · 4 intentionally disabled · 1 with zero
production usage (voice notes) · 2 P0-blocked.

---

## C. Database / migrations

### Production facts (measured read-only, 2026-08-21)

| fact | value | command |
|---|---|---|
| cluster | `7642734024280108049`, PostgreSQL 17.6 aarch64 | `pg_control_system()` |
| journal | **87 recorded / 87 files, 0 orphans** | `adopt-migrations.ts --doctor` |
| pending DDL | **none** — `db:migrate` applies nothing | `db:migrate` |
| schema contract | **READY** | `db:audit:schema-contract` |
| RLS | **78 tables, 78 fully locked, 0 deviating** | `db:audit:rls` |
| undeclared routines | 3 (`ensure_rls`, `rls_auto_enable`, `is_active_payer_member`) | `db:audit:undeclared-routines --strict` → exit 0 |
| `events` | 19,975 total · 1,714 in 24h · newest 3 min old | probe |
| `workers` / `worker_profiles` | 114 / 42 | probe |
| `chat_sessions` / `generated_resumes` | 107 / 29 | probe |
| `voice_notes` | **0** | probe |
| `audit_logs` | **0** | probe |
| `jobs` / `job_postings` / `applications` / `payers` | 19 / 8 / 23 / 13 | probe |
| `unresolved_phrase` | 36 | probe |
| `ai_call_traces` | 133 | probe |
| `skill` | **165** (52 active · 111 provisional · 2 deprecated) | probe |
| `skill_alias` | **336**, all embedded, one model | probe |
| `job_domain_skill` | **236 edges across 28 domains** | probe |
| `job_domain` | 4,071 | probe |
| `_delete_forensics` | 147 rows, 0 over the 90-day window | `db:audit:undeclared-routines` |

> **`audit_logs` = 0 is worth noting.** It is the DPDP erasure-proof table. Zero rows means no
> erasure has ever executed in production — the mechanism is untested against real data.

### Repository facts

| fact | value |
|---|---|
| migration files | 87 `.sql` |
| journal entries | 87 |
| `packages/db` tests | 69 files |
| API tests | 343 files |
| ai-service tests | 65 files |
| E2E tests | 12 files |
| API controllers | 67 |

### Sub-areas

- **Unresolved phrase architecture** — `unresolved_phrase` with `job_domain_id` (0078), scope
  uniqueness index, one-domain CHECK. 36 rows in production. Write path proven (#1028).
- **Skill / domain taxonomy** — seeded by D2 today: 51 → 165 skills, 98 → 336 aliases, 0 → 236
  edges. **Not serving traffic**: both matching flags are `false`.
- **Embeddings** — `gemini-embedding-001`, 768-dim, L2-normalised. `skill_alias` 336/336;
  `job_domain_alias` 9,121/9,121. `PROVEN MOCK (recompute) = 0` on both.
- **Indexes** — `_delete_forensics_at_idx` (0086), `unresolved_phrase_scope_uq` (0078), journey
  read indexes (0079), keyset index on `worker_feedback` (0080). Not exhaustively audited.

---

## D. AI architecture

### The actual pipeline

```
worker input (app)
   │
   ├─ text ──────────────────────────────────────────────┐
   └─ audio ──► [STT / stt_transcription] ⏸️ NOT ARMED ───┤
                                                          ▼
                                          API (NestJS) — orchestration
                                                          │  AI_SERVICE_URL=http://ai-service:8000
                                                          ▼
                          AI Service — SG-2 pseudonymization (fail-closed) on EVERY text
                                                          │
        ┌──────────────┬────────────────┬─────────────────┼──────────────────┐
        ▼              ▼                ▼                 ▼                  ▼
  profiling_chat_turn  profile_extraction  resume_generation  skill_embedding  tts_synthesis
     ✅ REAL             ⏸️ MOCK             ⏸️ MOCK            ⏸️ MOCK*         ⏸️ MOCK
     (Gemini flash)                                          (*real locally only)
                                                          │
                                                          ▼
                                    canonicalize ⏸️ (SKILL_CANONICALIZE_ENABLED=false)
                                                          │
                                                          ▼
                                    unresolved_phrase  ──► 36 rows in production
                                                          │
                                                          ▼
                                    embeddings ──► skill_alias.embedding (pgvector, 768)
                                                          │
                                                          ▼
                                    retrieval / matching ⏸️ (MATCH_V1_ENABLED=false,
                                                             DOMAIN_MATCH_ENABLED=false)
                                                          │
                                                          ▼
                                                    worker profile
```

### Where each thing happens

| concern | location | state |
|---|---|---|
| Real Gemini calls | ai-service, `profiling_chat_turn` **only** | ✅ armed in production |
| Mocks | every other task (`MOCK_MODEL = "mock-embedding"` etc.) | ⏸️ by allowlist |
| PII boundary | `embed_texts` / SG-2 pseudonymization, fail-closed → `blocked=True` | ✅ |
| Langfuse traces | `app/ai/langfuse_tracing.py`; keys bridged by deploy | 🟡 not verified live |
| Spend tracking | TD68 SpendLedger, `cost_tracker.py` | 🟡 see below |
| Redis required | API: sessions, OTP HMAC, rate limits, BullMQ (**mandatory**) · ai-service: spend ledger (**optional**) | ✅ / 🟡 |
| Embeddings stored | `skill_alias.embedding`, `job_domain_alias.embedding` (pgvector 768) | ✅ |
| Taxonomy used | `job_domain_skill` (Path A) and legacy slug aliases (Path B) | ⏸️ gated off |

> **Production spend ledger is in-process, not Redis.** `AI_SPEND_REDIS_URL: ${AI_SPEND_REDIS_URL:-}`
> — empty by default in the production overlay, which selects the **in-process** backend. Caps are
> then enforced *per Uvicorn worker*, not globally. Whether the box exports a value **was not
> verified** (it is a box-side env, not in the repo).

### Feature flags and production values

Values below are the **production overlay defaults** (`docker-compose.staging.yml`) plus the
`production` GitHub environment. A box-side `export` overrides both and **was not inspected**.

| flag | production value | effect |
|---|---|---|
| `AI_ENABLE_REAL_CALLS` | **`true`** | master gate open (owner, 2026-08-18) |
| `AI_REAL_CALL_TASKS` | **`profiling_chat_turn`** | the only task that may go real |
| `SKILL_CANONICALIZE_ENABLED` | **`false`** | `/skills/canonicalize` returns disabled |
| `MATCH_V1_ENABLED` | **`false`** | matching v1 off |
| `DOMAIN_MATCH_ENABLED` | **`false`** | ANN domain fallback off |
| `NODE_ENV` | `production` | fail-closed boot asserts on |
| `AI_SPEND_REDIS_URL` | *(empty)* | in-process spend ledger |
| `RESUME_RENDER_ENABLED`, `TEST_LOGIN_ENABLED`, `PAYER_TEST_LOGIN_ENABLED`, `CAPACITY_ENFORCEMENT_ENABLED`, `PACE_ENABLED`, `PACE_ADJACENCY_ENABLED`, `AGENCY_PAYOUTS_ENABLED`, `CHAT_LLM_INTERVIEW_ENABLED`, `CHAT_ONE_SHOT_OPENER_ENABLED`, `ADMIN_PII_REVEAL_ENABLED`, `ADMIN_AI_TRACE_READ_ENABLED`, `AUTH_ROLLING_TIERS_ENABLED`, `AI_JOBS_RETENTION_DELETE_ENABLED` | **not verified** | declared in `packages/config/src/server.ts`; live values not read |

---

## E. Taxonomy / Phase 9 — status only

| gate | status | one line |
|---|---|---|
| **S3-A** (seed wedge) | **DONE** | executed 2026-08-21: +16 skills, +41 aliases, 4 statuses held |
| **S3-B** (seed growth) | **DONE** | executed 2026-08-21: +98 skills, +197 aliases, +236 edges (531 rows) |
| **S3-C** (dual-read shadow) | **DEFERRED** | never built; the request shape *is* the switch |
| **S3-D** (activation) | **BLOCKED** | no rollback procedure; 4 of 5 abort thresholds have no instrument |
| **P1** (Path-B parity) | **DECISION REQUIRED** | FAIL, exit 1, 8/10 slugs drifted — see §3 |
| **TD-01** (explicit term model) | **DEFERRED** | superseded; ratified shape is a full merge |
| **TD-07** (generic welding parent) | **BLOCKED** | evidence never supplied; denial claim corrected #1030 |
| **OIE / O1** | **BLOCKED** | designed and measured (29.17% vs O2's 0.00%); switch **OFF**, not activated |
| **CNC programming** | **DONE** | quantified and decided (`phase-9-cnc-programming-decision.md`) |
| **EVAL_COVERED** | **BLOCKED** | 6 skills need one reviewed trainer phrase each; pack deliberately empty |
| **Embedding coverage** | **DONE** | 336/336 aliases, 147 skills fully embedded, 111 provisional embedded |
| **Promotion** | **BLOCKED** | gated behind EVAL_COVERED + the P1 decision; not run |

**Counts: 4 DONE · 1 DECISION REQUIRED · 4 BLOCKED · 3 DEFERRED.**

### Stale register rows found while compiling this

- *"`--preserve-existing-status` does not exist in `seed-skills.ts`"* — **it exists and was used
  today.** Row is closed.
- *"`db:retag:skills` guards on `NODE_ENV`"* — **it is on `opsGuard`.** Row is closed.

---

## 3. The Path-B parity failure — objective explanation

**No recommendation is made here.**

**What changed.** `db:verify:path-b-parity --against=<committed baseline>` now exits **1**.
Candidate rows **76 → 106**; overall digest `d7f6cd4e…` → `876fcd58…`; **8 of 10 legacy slugs
drifted** (`general-machining` and `vmc-machining` unchanged).

**Why it changed.** Path B's candidate predicate, copied from `SkillsRepository.legacyAliasRows`:

```sql
WHERE sa.domain_id = $1 AND s.status = 'active' AND sa.embedding IS NOT NULL
```

Rows only enter when they have a **vector**. D2 Step 2 gave vectors to 260 aliases. 30 of those
satisfied the other two conditions and entered the candidate set.

**Does it break current production behaviour?** **No — because the paths that consume it are off.**
`MATCH_V1_ENABLED=false` and `DOMAIN_MATCH_ENABLED=false`. The candidate set changed; no
production request currently reads it through those flags. This was **not** separately proven by
a live request trace — it is inferred from the flag values, which is a weaker form of evidence and
is stated as such.

**Is it expected from embedding previously-unembedded aliases?** **Yes, for the majority.** The
runbook flagged 22 unembedded aliases as *"a pre-existing gap, not something D2 creates"*, and
predicted Step 2 would pick them up. It did not carry that prediction forward to its consequence
for Path B.

**The 22 pre-existing aliases.** Alias rows created **before** D2 (before 2026-08-20 20:00 UTC),
already attached to skills that were already `active`, sitting on production with
`embedding IS NULL`. Step 2 embedded them. **These would have moved Path B with or without D2's
seed** — running Step 2 alone on the old corpus produces the same 22.

**The 8 D2 aliases.** Of the 238 aliases D2 seeded: **197** carry no `domain_id` (growth corpus —
they feed Path A edges), **33** carry a `domain_id` but sit on `provisional` skills (excluded by
`status='active'`), and **8** carry a `domain_id` on an already-`active` skill. Only those 8
could ever reach Path B. **22 + 8 = 30.** ✓

**Would production matching return different results today?** **Not through the gated paths** —
they are off. If a flag were switched on, yes: 8 slugs would retrieve from a larger candidate
pool (e.g. `cnc-machining` 22 → 37 candidates, 10 → 11 skills). More candidates for
substantially the same skills; only one slug gained a skill.

**What rolling back vectors would accomplish.** Setting the 30 aliases' `embedding` to NULL would
restore digest `d7f6cd4e…` exactly. It would also **re-open the 22-alias pre-existing gap** that
predates D2, and re-break `partially_embedded` from 0 back to 16. It cannot un-spend the provider
call (0.0097 INR). It would preserve the baseline as a true statement about production.

**What accepting / re-baselining would accomplish.** It records that the candidate set legitimately
grew, and makes future parity runs measure drift from the new reality. It **permanently destroys
the ability to detect that this specific change happened** — which is precisely what the tool's
own warning guards against: *"a failure here is evidence the STAGE is wrong, not that the
assertion is too strict. Do not re-baseline to make it pass."*

| | |
|---|---|
| **PRODUCT RISK** | **LOW** — both consuming flags are `false`; no live request path reads it |
| **ARCHITECTURAL RISK** | **MEDIUM** — the P1 safety property is now failing, so the one instrument that would detect a *real* Path-B regression is red and would mask the next one |
| **DECISION REQUIRED** | **YES** |

---

## 4. Minimum Production-Ready Path

**Only items that block correct, safe operation.** Taxonomy optimisation, S3-D, O1, promotion,
trainer data and the drift-gate CI wiring are **excluded by design** — they are listed as
DEFERRED in §E and none of them block the product.

### Production blockers (3)

| # | task | class | status | blocker | files / components | owner | effort | verification command | manual verification |
|---|---|---|---|---|---|---|---|---|---|
| **1** | **TD2 — real OTP send** | BUILD | Not started | Fast2SMS production credentials absent | `apps/api/src/sms/`, `auth/otp.service.ts` | Backend + owner (creds) | **S** once creds exist | `gh workflow run staging-cd.yml` (real-only OTP smoke) | Register a real phone in the worker app; confirm the SMS arrives and the code works |
| **2** | **TD73 — `/feed` must exclude decided jobs** | BUILD | Not started | owner-ruled mandatory before real job volume | `apps/api/src/jobs/`, feed query | Backend | **S–M** | `pnpm --filter @badabhai/api test -- feed` | Apply/skip a job in the app, pull-to-refresh; the decided job must not reappear |
| **3** | **TD29 — worker-app alpha flows** | BUILD | Partially implemented | alpha device capstone returned NO-GO | `apps/worker-app/lib/features/**` | Mobile | **L** | `cd apps/worker-app && flutter test` | Run the APK on a real device end-to-end: register → consent → profile → chat → apply |

### Required before real money / real volume (4)

| # | task | class | status | blocker | owner | effort | verification |
|---|---|---|---|---|---|---|---|
| 4 | **TD123** — staging CD has never run | HARDENING | Not started | staging env secrets unwired | DevOps | M | `gh run list --workflow=staging-cd.yml` returns a green run |
| 5 | **TD129** — E2E cannot run worker flows | VERIFY | Not started | e2e job lacks worker fixtures | QA | M | the E2E job exercises a worker journey |
| 6 | **TD131** — SAST gate nondeterministic | HARDENING | Not started | time-dependent rule | DevOps | S | 5 consecutive green SAST runs |
| 7 | **Payments real-money proof** | VERIFY | Built, unproven | Razorpay production creds | Backend + owner | M | one real ₹1 capture end-to-end, refunded |

### Correctness gaps found today (2) — not blockers

| # | task | class | detail | owner | effort |
|---|---|---|---|---|---|
| 8 | 4 write runners bypass `opsGuard` | HARDENING | `embed-job-domain-aliases`, `growth-cluster`, `growth-occupation`, `reencrypt-pii-backfill` are not on the standardised authorization model | Backend | S |
| 9 | `AI_SPEND_REDIS_URL` uses `localhost` | HARDENING | on Windows `localhost` → `::1` hangs 2.016s against a 2.0s bound, silently disabling the spend ledger for **every** real AI call; surfaces misleadingly as `budgetStopped=true` | Backend/DevOps | **XS** (one-character host change + a startup reachability assertion) |

### Explicitly DEFERRED — do not work on these

S3-C shadow · S3-D activation · O1/OIE activation · skill promotion · trainer phrase pack ·
EVAL_COVERED unblocking · live-drift CI gate wiring (#1155) · pooler tuning · the three remaining
undeclared routines · the box-local postgres question (1h investigation, no impact).

**Answer to "how much BUILD remains":** **3 BUILD items block production** (items 1–3), of which
one is large (worker-app alpha). Everything else outstanding is VERIFY, HARDENING, DECISION or
DEFERRED.

---

## 5. Manual verification checklist

How to verify each subsystem **without trusting an agent's report**. Run these yourself.

| # | subsystem | how you verify it |
|---|---|---|
| 1 | **API health** | On the box: `docker ps` → `badabhai-api … (healthy)`; `curl -fsS http://localhost:3000/health` |
| 2 | **AI service health** | On the box: `curl -fsS http://127.0.0.1:8000/health` → 200 |
| 3 | **Which DB production uses** | `SELECT system_identifier FROM pg_control_system();` — must be `7642734024280108049` (Supabase), not the box's local pg |
| 4 | **Live traffic is landing** | `SELECT max(created_at), count(*) FILTER (WHERE created_at > now() - interval '1 hour') FROM events;` |
| 5 | **Worker registration** | Register in the app, then `SELECT count(*) FROM workers;` before/after — must increment |
| 6 | **Login / OTP** | Request an OTP on a real handset. **This is TD2 — expect it to fail today.** Test-login path: `TEST_LOGIN_ENABLED` |
| 7 | **AI profiling** | Complete a chat turn, then `SELECT count(*) FROM chat_sessions;` and `SELECT count(*) FROM ai_call_traces;` |
| 8 | **A REAL AI call happened** | `SELECT task_type, count(*) FROM ai_call_traces GROUP BY 1;` — `profiling_chat_turn` is the only task that may be real. Cross-check the Langfuse trace |
| 9 | **Embedding creation** | `pnpm --filter @badabhai/db db:audit:embeddings` — expect 336/336, `PROVEN MOCK (recompute) = 0`, one model |
| 10 | **Skill matching** | Both flags are `false`, so **the honest verification is that it does nothing**: `POST /skills/canonicalize` must return disabled |
| 11 | **Unresolved phrase recording** | `pnpm --filter @badabhai/db db:verify:unresolved-write`; `SELECT count(*) FROM unresolved_phrase;` (36 today) |
| 12 | **Resume generation** | Generate one in the app; `SELECT count(*) FROM generated_resumes;` (29 today). Note it runs on the **mock** provider |
| 13 | **Voice upload** | Record a voice note; `SELECT count(*) FROM voice_notes;` — **0 today**, so any increment is new information |
| 14 | **Supabase storage** | Upload media, then confirm the object exists in the Supabase storage bucket console |
| 15 | **Redis / BullMQ** | On the box: `docker exec badabhai-redis redis-cli PING` → `PONG`; `redis-cli KEYS 'bull:*' \| head` |
| 16 | **Langfuse trace** | Complete a profiling turn, then open the Langfuse project and confirm a trace with a matching correlation id |
| 17 | **Crashlytics** | Force a test crash in a debug build; confirm it lands in the Firebase console |
| 18 | **Database migrations** | `npx tsx packages/db/adopt-migrations.ts --doctor` → **87/87, 0 orphans**; `db:migrate` → applies nothing |
| 19 | **RLS** | `pnpm --filter @badabhai/db db:audit:rls` → **78/78 locked, 0 deviating** |
| 20 | **Schema contract** | `pnpm --filter @badabhai/db db:audit:schema-contract` → **READY** |
| 21 | **Path-B parity** | `pnpm --filter @badabhai/db db:verify:path-b-parity -- --against=data/taxonomy/replay/phase-9-path-b-parity-BASELINE-PRE-S3.json` → **currently exits 1** |
| 22 | **Deploy actually happened** | `gh run list --workflow=ci.yml --branch=main --limit 3`, then confirm the `Deploy to AWS Lightsail` job succeeded and read its health-gate lines |
| 23 | **Full application flow** | On a real device: register → consent → profile → AI chat → resume → browse jobs → apply. Then confirm one row appeared in each of `workers`, `worker_profiles`, `chat_sessions`, `generated_resumes`, `applications` |

---

## Appendix — commands used to compile this document

```bash
# production, read-only
npx tsx packages/db/adopt-migrations.ts --doctor
pnpm --filter @badabhai/db db:audit:schema-contract
pnpm --filter @badabhai/db db:audit:rls
pnpm --filter @badabhai/db db:audit:embeddings
pnpm --filter @badabhai/db db:audit:undeclared-routines -- --strict
pnpm --filter @badabhai/db db:verify:path-b-parity -- --against=<baseline>

# repository
ls packages/db/migrations/*.sql | wc -l
find apps/api/src -name "*.test.ts" | wc -l
grep -n "AI_REAL_CALL_TASKS\|AI_ENABLE_REAL_CALLS" docker-compose.staging.yml

# CI / deploy history
gh run list --workflow=ci.yml --branch=main --limit 6
gh run view <id> --json jobs
```

**Not verified, and stated as such:** the box's actual exported environment (only overlay defaults
and the CI secret-bridge were read); Langfuse traces arriving; Crashlytics reporting; push
delivery; the role of the box-local postgres container; live values of the 13 flags in the last
row of §D.
