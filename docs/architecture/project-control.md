# BadaBhai — Project Control

> **This is the authoritative document.** `project-status.md` is the detailed evidence appendix;
> where the two disagree, this file is newer. Every claim here carries a status word with a
> fixed meaning, and no claim advances a level without evidence.

```
BUILT     code exists
DEPLOYED  code is running in production
VERIFIED  production evidence confirms it
USED      real production traffic has exercised it
ACTIVE    production configuration actually routes traffic through it
COMPLETE  all of the above AND acceptance criteria met
```

"Working", "done" and "production-ready" are not used. **Last updated 2026-08-21.**

---

## Roadmap header

| | |
|---|---|
| **CURRENT PHASE** | Phase 9 — taxonomy activation (Track A) |
| **CURRENT MILESTONE** | Stage D — promotion readiness |
| **COMPLETED** | Stage A observe · Stage B backfill (P1-B PASS) · Stage C shadow (offline) · 41 trainer phrases |
| **IN PROGRESS** | Stage D — 5 of 7 promotion gates green at 96/96 |
| **BLOCKED** | Both evidence gates measured and **FAILING on their own terms**: `RESOLVABLE_ABOVE_FLOOR` 62/96, `NO_REGRESSION` 0.9675 < 1.0. Promotion candidates **0**. |
| **NEXT 3 ACTIONS** | 1. **Owner: the 0.75 floor** (`decision-canonicalization-floor-0.75.md`). 2. **Owner: `NO_REGRESSION` semantics** (`decision-no-regression-fixture-architecture.md`). 3. **Owner: D-1 bridge ownership** (`adr-d1-attribute-to-match-skill-bridge.md`). |
| **PRODUCTION-CRITICAL** | **None.** No taxonomy component is on a production request path. |
| **OPTIONAL / HARDENING** | 4 unguarded write runners · `AI_SPEND_REDIS_URL` IPv6 · pooler saturation |
| **REMAINING EFFORT (Track A)** | ~4–6 sessions to Phase 10 complete |
| **REMAINING EFFORT (Track B)** | Large — see §D. Not a Phase 9 blocker. |

### Phase-by-phase remaining roadmap

| phase | what it does | status | remaining |
|---|---|---|---|
| **9-D Parity** | prove Path A ≥ Path B | ⛔ IN PROGRESS | evidence runs + baseline decision + promote 96 |
| **9-E Read switch** | pass `job_domain_id` at the caller | ⛔ | 0.5 session, gated on D |
| **9-F Rollback window** | both paths healthy, A authoritative | ⛔ | observation period |
| **9-G Legacy retirement** | delete the Path B branch | ⛔ | 0.5 session |
| **10 Activation** | promotion → canonicalize ON → domain pilot → rollout | ⛔ | 2–3 sessions |
| **11+ (does not exist)** | — | — | Track B and feed work are **not** numbered phases |

---

## A. Overall architecture

| component | role |
|---|---|
| Worker app (Flutter) | onboarding, AI profiling, feed, apply, resume, voice |
| Employer / job posting | payer-web posting, `job_posting_skill` canonicalization |
| Profiling | LLM extraction of a structured profile from speech |
| AI service (FastAPI) | pseudonymization gateway, extraction, embeddings, canonicalization |
| Taxonomy | `skill` (165) + `job_domain` (4,071), ISCO-08 / NCO-2015 |
| `skill_alias` | 336 rows / 332 embedded — the **skill** search surface |
| `job_domain_alias` | 9,121 rows / 9,121 embedded — the **occupation** search surface |
| `job_domain_skill` | 236 edges / 28 domains — the join that makes Path A possible |
| `worker_skill` | canonical skill ids on a worker (8 rows) |
| `job_posting_skill` | canonical skill ids on a posting (**0 rows**) |
| Matching / reach engine | exact `skill_id` equality, deterministic, no model |
| Relevance scoring | `packages/reach-engine/scoring.ts` |
| Job visibility / feed | `applications.repository.ts` → `findOpenJobs` |
| Voice | record → upload → Supabase Storage → `voice_notes` → transcribe |
| Resume | render + download |
| Consent / DPDP | `CONSENT_PURPOSES`, `@RequireConsentPurpose`, `ConsentGuard` |
| Observability | Langfuse tracing, spend ledger |

## B. Current production reality

| Component | Built | Deployed | Production verified | Actually used | Flag | Status |
|---|:--:|:--:|:--:|:--:|---|---|
| OTP / auth | ✅ | ✅ | ✅ 382 verified | ✅ 270 workers | — | **ACTIVE** |
| Consent / DPDP | ✅ | ✅ | ✅ 333 accepted | ✅ | — | **ACTIVE** |
| AI profiling | ✅ | ✅ | ✅ 223 extractions | ✅ | on | **ACTIVE** |
| Resume | ✅ | ✅ | ✅ 114 generated / 196 downloads | ✅ | — | **ACTIVE** |
| Job feed | ✅ | ✅ | ✅ 7,616 shows / 25 jobs | ✅ | — | **ACTIVE — basic filters only** |
| Applications | ✅ | ✅ | ✅ 92 across 21 jobs | ✅ | — | **ACTIVE** |
| Interview kit | ✅ | ✅ | ⚠ 16 failed / 12 completed | ✅ | — | **DEGRADED** |
| Voice | ✅ | ✅ | ❌ 0 events | ❌ | consent purpose unissued | **DORMANT** |
| Skill taxonomy corpus | ✅ | ✅ | ✅ counts verified | ❌ | — | **BUILT, not routed** |
| Skill canonicalization | ✅ | ✅ | ❌ | ❌ | `SKILL_CANONICALIZE_ENABLED=false` | **FLAG-OFF** |
| Domain match | ✅ | ✅ | ❌ | ❌ | `DOMAIN_MATCH_ENABLED=false` | **FLAG-OFF** |
| Path A / Path B retrieval | ✅ | ✅ | shadow only | ❌ | gated by canonicalize | **SHADOW** |
| Reach engine / `job_reach` | ✅ | ✅ | ❌ 6 rows | ❌ | — | **NOT CONNECTED** |
| Relevance ranking | ✅ | ✅ | ❌ | ❌ | — | **NOT CONNECTED** |
| Job visibility relevance | ❌ | ❌ | ❌ | ❌ | — | **NOT BUILT** |

## C. "If I create a job today, how does a worker see it?"

| # | arrow | state | evidence |
|---|---|---|---|
| 1 | Job created → `jobs` row | **LIVE** | 25 jobs in production |
| 2 | Job title → `job_domain` (ANN over `job_domain_alias`) | **FLAG-OFF** | `DOMAIN_MATCH_ENABLED=false` |
| 3 | `job_domain` → `job_domain_skill` scope | **NOT REACHED** | step 2 never runs |
| 4 | Skill phrases → canonical ids → `job_posting_skill` | **NOT CONNECTED** | **0 rows, ever** |
| 5 | Worker speech → extracted skill labels | **LIVE** | 223 extractions |
| 6 | Labels → canonical ids → `worker_skill` | **FLAG-OFF** | 8 rows, none recent |
| 7 | worker ∩ job skills → reachability (`job_reach`) | **NOT CONNECTED** | 6 rows; feed does not read it |
| 8 | reachability → relevance score | **NOT CONNECTED** | `scoring.ts` not on the request path |
| 9 | score → feed ordering | **NOT CONNECTED** | feed emits `score: 0` |
| 10 | **feed query → worker** | **LIVE** | `findOpenJobs` |
| 11 | feed → application | **LIVE** | 92 applications |

**The honest summary:** steps 1, 5, 10 and 11 are live. **Steps 2–4 and 6–9 — the entire
relevance chain — are not connected.** A worker sees a job because it is open, in their city,
matches their trade string, and they have not applied. Nothing else.

### What actually influences the feed today

| signal | influences? | mechanism |
|---|:--:|---|
| city | ✅ | exact-match `WHERE` |
| trade (`trade_key`) | ✅ | exact-match `WHERE` |
| already applied | ✅ | `NOT EXISTS` anti-join |
| recency | ✅ | `ORDER BY created_at ASC, id ASC` |
| worker skills | ❌ | — |
| job skills | ❌ | `job_posting_skill` is empty |
| job domain | ❌ | flag off |
| experience | ❌ | — |
| salary | ❌ | — |
| relevance score | ❌ | emits `score: 0` |

**`score: 0` is not a ranking.** It is an honest placeholder, and the code says so.

## D. The 4,071 domains / 9,121 aliases question — settled

`job_domain_alias` and `skill_alias` name **different entities** and are not meant to be 1:1.
Occupations and skills are joined many-to-many by `job_domain_skill`.

| metric | count | % |
|---|---:|---:|
| Active job domains | 4,071 | 100% |
| Non-selectable hierarchy aggregates | 186 | 4.6% |
| Selectable | 3,885 | 95.4% |
| With ≥1 alias | 3,885 | **100% of selectable** |
| With ≥1 active skill edge | 28 | 0.69% |
| **Usable by Path A today** | **19** | **0.47%** |
| Usable after promoting all provisional | 28 | 0.69% |

**Alias coverage is not the problem — it is complete.** The scaling gap is
**`job_domain` → `skill` edge coverage**, concentrated in ISCO 7/8/9 (1,799 domains).
Estimated ~15,300 edges at the observed 8.4/domain. **Tracked as Track B. Not a Phase 9
blocker** — minimum viable coverage is already met, because production has ever shown 25 jobs.

## E. Manual verification

```bash
# Promotion gates — every criterion, read-only, no provider call
pnpm --filter @badabhai/db exec tsx src/audit-promotion-gates.ts \
  --batch data/taxonomy/batches/batch_2026-08-16T14-30-41Z-remediation-phase9d \
  --fixture=data/taxonomy/eval/retrieval-v3.jsonl
# expect: 5 gates 96/96, 2 pending evidence

# Stage B closed under P1-B
pnpm --filter @badabhai/db exec tsx src/verify-stage-b-parity.ts \
  --against=data/taxonomy/replay/phase-9-path-b-parity-BASELINE-PRE-S3.json \
  --delta=data/taxonomy/replay/phase-9-stage-b-delta.json

# The de-collision cannot be silently undone
pnpm --filter @badabhai/db exec tsx src/embed-skill-aliases.ts --plan
# expect: 4 excluded, 0 pending
```

```sql
-- The feed does no ranking. This IS the relevance story today.
SELECT id, title, city, created_at FROM jobs WHERE status='open'
ORDER BY created_at ASC LIMIT 10;

-- Nothing has ever been promoted
SELECT status, version, count(*) FROM skill GROUP BY 1,2;   -- version=1 everywhere

-- The coverage gap, in one query
SELECT count(*) FILTER (WHERE selectable) AS selectable,
       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM job_domain_skill j
         WHERE j.job_domain_id=d.job_domain_id AND j.status='active')) AS with_edges
FROM job_domain d WHERE d.status='active';   -- 3885 / 28

-- The relevance chain is empty on the demand side
SELECT (SELECT count(*) FROM job_posting_skill) AS posting_skills,   -- 0
       (SELECT count(*) FROM worker_skill)      AS worker_skills,    -- 8
       (SELECT count(*) FROM job_reach)         AS reach_rows;       -- 6
```

**UI:** worker app → register → OTP → consent → AI profiling → resume → feed. The feed you see
is recency-ordered; post two jobs in the same city and trade, and the older one appears first
regardless of skill match.

## F. Intended → built → deployed → used → remaining

| | |
|---|---|
| **We intended** | a relevance system: worker skills ∩ job skills, domain-scoped, deterministically ranked |
| **We built** | the full taxonomy foundation — corpus, both retrieval paths, reach engine, canonicalization, promotion gates, parity verifiers, offline shadow |
| **Is deployed** | all of it ships in the production image |
| **Is actually used** | **none of it.** Two flags are off and `job_posting_skill` is empty |
| **Remains** | Phase 9 D–G, Phase 10, then connect reach → score → feed |
| **Verify it** | §E above |
