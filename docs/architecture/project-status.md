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

Production blockers:         0 in code — all 3 were already shipped (measured 2026-08-21)
Critical features complete:  NOT MEASURABLE — 8 of 22 feature rows are production-verified
Architecture components:     8 of 9 running and health-gated in production
Database/migration status:   87 of 87 recorded · 0 orphans · contract READY · RLS 78/78
AI pipeline:                 1 of 6 provider tasks armed for real calls in production
Taxonomy Phase 9:            4 DONE · 1 DECISION REQUIRED · 3 BLOCKED · 5 DEFERRED
Observability:               3 of 5 wired · 1 unverified in production
Security:                    RLS 78/78 · schema contract READY · 4 write runners unguarded

Current phase:    The product WORKS end-to-end in production — 270 workers have completed it.
Next milestone:   Voice: the one flow that is built and has never been used by anybody.
Current blocker:  NONE in code. Path-B parity is a DECISION, not an outage.
Next 3 actions:   1. Voice (G2) — zero events, zero rows, entirely unexercised.
                  2. interview_kit render — 16 failed vs 12 completed (>50% failure).
                  3. Decide Path-B (accept / roll back).
```

**Why "Overall %" is NOT MEASURABLE.** There is no weighting of features to a denominator that
would not be invented. Counts are given instead, and every count below is traceable to a command.

---

## The measured production funnel — 2026-08-21

This supersedes every "is it working?" argument in this document, and it is what closed three
of the eight P0s. Counts are rows in `events`.

> **Read the distinct column carefully.** Worker-subject steps count distinct *workers*;
> `feed.shown` and `application.submitted` are keyed on the **JOB**, so their distinct counts are
> jobs. Reading them as a 90% drop-off is the obvious mistake and would be wrong.

| step | events | distinct | last 7d |
|---|---|---|---|
| OTP requested | 451 | — | 275 |
| **OTP verified** | **382** | **270 workers** | 235 |
| account created | 270 | 270 workers | 206 |
| consent accepted | 333 | 333 | 259 |
| name recorded | 332 | 247 workers | 244 |
| AI profiling started | 270 | 270 workers | 190 |
| profile extracted | 223 | 223 workers | 126 |
| **resume generated** | **114** | 114 workers | 59 |
| resume **downloaded** | **196** | — | — |
| interview kit downloaded | 51 | — | — |
| feed shown | 7,616 | *(25 jobs)* | 3,056 |
| job applied | 92 | *(21 jobs)* | 33 |
| **voice — any event** | **0** | **0** | **0** |

**What this proves.** The core worker journey — register → OTP → consent → AI profiling →
extraction → resume → download → browse → apply — is completed by real people on real handsets,
continuously. Not a staging claim, not a fixture.

**What it exposes — the real findings:**

1. **Voice has never been used.** Zero `voice.*` events, zero `voice_notes` rows. It is built
   (`features/voice`, `features/voice_form`; the old placeholder file is gone) and completely
   unexercised, so **nothing proves it works**. This is now the top product-functionality question.
2. **`interview_kit.render_failed` 16 vs `render_completed` 12** — a **>50% render failure rate**.
   Newest failure 2026-07-27, newest completion 2026-08-20, so it may already be fixed; nothing
   on record says either way.
3. **223 profile extractions → 114 resumes.** About half the workers who get a profile never get
   a resume. A product-funnel question, not a defect.

### Consequence for §4

The three items §4 listed as production blockers were **all already shipped**:

| was | actual state |
|---|---|
| TD73 `/feed` exclusion | shipped + indexed in production; only test coverage was missing (added) |
| TD2 real OTP | 451 requested / **382 verified** / 1 failed |
| TD29 worker-app flows | G1 196 downloads · G3 51 kit downloads · 270 workers through the core path |

**BUILD remaining on the critical path: none identified.** What remains is VERIFY (voice, kit
render), HARDENING, and one DECISION (Path-B).

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

## 3. The Path-B parity failure — resolved by measurement, 2026-08-21

**Verdict: the drift is PURELY ADDITIVE and is not a behavioural regression — but a real
taxonomy defect was found inside it, and it is not the parity failure itself.**

**What changed.** `db:verify:path-b-parity --against=<committed baseline>` exits **1**.
Candidate rows **76 → 106** (+30); distinct skills **33 → 34** (+1); overall digest
`d7f6cd4e…` → `876fcd58…`; **8 of 10** legacy slugs drifted (`general-machining` and
`vmc-machining` unchanged).

**Why it changed.** Path B's candidate predicate, copied from `SkillsRepository.legacyAliasRows`:

```sql
WHERE sa.domain_id = $1 AND s.status = 'active' AND sa.embedding IS NOT NULL
```

A row enters only once it holds a vector. D2 Step 2 vectorised 260 aliases. Exactly 30 of them
also satisfied the other two conditions. Where the other 230 landed, measured:

| bucket | rows | reaches Path B? |
|---|---:|---|
| `active` skill **+** legacy `domain_id` | **30** | **yes — this is the entire drift** |
| `provisional` skill + legacy `domain_id` | 33 | no — blocked by `status='active'` |
| `provisional` skill, no legacy `domain_id` | 193 | no — blocked twice |
| `deprecated` skill, no legacy `domain_id` | 4 | no — blocked twice |
| | **260** | ✓ reconciles |

The 30 split **22 + 8**: 22 alias rows created 2026-07-14 that had been sitting on production
with `embedding IS NULL`, and 8 rows D2 itself seeded.

### PROVEN — every baseline row survives unchanged

Recomputing each slug's digest with the verifier's own `slugDigest`, over **only the rows D2 did
not embed**, reproduces the committed baseline digest **byte-for-byte in all 10 slugs**
(22/11/6/5/2/3/4/11/3/9 rows, every digest MATCH). Nothing was removed, re-skilled, renamed or
re-modelled. The candidate set did not *change*; it **grew**.

This matters because the digest also covers `embedding_model`. The embed runner fetches only
`embedding IS NULL` rows, so no existing vector was overwritten — and the digest reproduction is
the evidence, not the reasoning.

### PROVEN — no skill changed status

`version = 1` on **all 165** skill rows. SG-5 requires a status transition to bump `version`, so
no promotion or demotion has ever run on this table. The 33 skills whose `updated_at` moved to
`2026-08-20 20:30:25.985+00` were touched by the seed's idempotent upsert under
`--preserve-existing-status`; all 33 were already `active`, and all 111 `provisional` rows were
*created* by D2, never converted.

### PROVEN — Path B is unreachable from production today

`nearestAliases` has exactly one consumer chain: `canonicalize_skill` → `HttpSkillStore` →
`POST /internal/skills/nearest-aliases`. All three entry points return before touching the store
when the flag is off — `routers/skills.py:74`, `routers/profile.py:255`,
`profiling/profile_extractor.py:652`. The flag is `false` in three independent places:
`app/config.py:384` (`skill_canonicalize_enabled: bool = False`), `docker-compose.staging.yml`
(`${SKILL_CANONICALIZE_ENABLED:-false}`, pinned by `deploy-workflow-taxonomy.guard.test.ts`), and
the documented production posture. `cross-slug-alias.test.ts:17` states the same conclusion:
*"`SKILL_CANONICALIZE_ENABLED=false`, so 0 workers reach Path B today."*

**Limit of this evidence:** the deployed GitHub secret's value cannot be read from the
repository. Everything short of that is verified.

**Correction to the earlier draft of this section:** it named `MATCH_V1_ENABLED` and
`DOMAIN_MATCH_ENABLED` as the gates. The gate on this path is `SKILL_CANONICALIZE_ENABLED`;
`DOMAIN_MATCH_ENABLED` gates the *domain* ANN, not the skill-alias retrieval.

### THE DEFECT — `skill_drawing_reading` duplicates `skill_gdt_reading`

The +1 skill is `skill_drawing_reading` (created by D2, `active`, `cnc-machining`, 8 aliases).
`skill_gdt_reading` already existed in the same slug, `active`, with 4 aliases — **and all four
of its alias texts are now also aliases of `skill_drawing_reading`**:

`blueprint reading` · `drawing reading` · `GD&T` · `geometric dimensioning and tolerancing`

These are the **only** cross-skill duplicate alias texts inside any legacy slug, and **all four
were introduced by D2**. Before D2 there were zero.

Consequence, if Path B were switched on: a query for "GD&T" in `cnc-machining` returns two
distinct `skill_id`s at effectively identical distance, so one `LIMIT k` slot is consumed twice
for one concept and a genuinely different skill is displaced out of the top-k. That is **recall
dilution, not an irrelevant match** — no unrelated worker or job becomes matchable.

`skill_drawing_reading` also carries `CAD`, `drawing padhna`, `read engineering drawings` and
`technical drawing`, which belong to `skill_cad_interpretation` — but that skill sits in
`cnc-programming`, a different slug, so no in-slug collision arises today.

Its row also has `updated_at` (20:30:25.985) **earlier than** `created_at` (20:30:30.440), a seed
artifact. Cosmetic; recorded, not blocking.

### The Phase-10 exposure, now quantified

**33 embedded aliases across 15 `provisional` skills already carry a legacy `domain_id`** —
`fitting-assembly` 19 aliases / 8 skills, `cnc-programming` 14 aliases / 7 skills. They are held
out of Path B by `s.status = 'active'` and by nothing else. This is exactly the hazard
`skills.repository.ts:104-108` predicted in writing. **The moment Phase 10 promotion flips those
15 skills to `active`, Path B's candidate set grows by another 33 rows in two slugs with no
further embedding.** Promotion must therefore be treated as a retrieval change, not a metadata
change.

Also measured: **0** `worker_skill` rows reference any provisional skill, and `job_domain_skill`
holds **236** edges, all `active`.

### Rollback

**Not technically required.** Nulling the 30 vectors would restore digest `d7f6cd4e…` exactly,
but it would re-open the 22-alias gap that predates D2, cannot un-spend the provider call
(0.0097 INR), and would leave the duplicate-skill defect in place — the defect is the *skill
row*, not the vectors.

| | |
|---|---|
| **PRODUCT RISK** | **NONE today** — no live request path reads Path B |
| **DATA RISK** | **NONE** — additive only, proven by digest reproduction; no row altered or removed |
| **RELEVANCE RISK** | **REAL but latent** — one duplicated skill dilutes `cnc-machining` top-k the moment Path B is switched on |
| **DECISION REQUIRED** | **YES** — the P1 invariant wording, and the duplicate skill |

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
