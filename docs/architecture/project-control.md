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

"Working", "done" and "production-ready" are not used. **Last updated 2026-08-26.**

> **Every count in this file carries a measurement date, and they are not all the same date.**
> On 2026-08-21 at 10:36 UTC, 119 `workers` and 45 `worker_profiles` rows were deleted manually
> through the Supabase dashboard (`worker-data-discrepancy-resolved.md`). Counts taken before
> that moment are pre-deletion snapshots — accurate when taken, and not current. Rows below are
> marked **[08-26]** where re-measured on 2026-08-26 (`live-population-2026-08-26.md`),
> **[08-24]** where last measured then, and **[08-21 pre]** where not.
>
> **Two 08-24 figures do not reproduce and are NOT silently corrected below.** The recorded
> "1 worker" cannot be reconciled — 31 workers already existed before 2026-08-24 and nothing was
> deleted after 08-21; five candidate predicates were probed and none yields 1. And `jobs`
> 25 → 19 and `applications` 92 → 28 have no forensic record, because the delete-forensics
> trigger exists on `workers` and `worker_profiles` only. Both are open items in the graph.

---

## Roadmap header

| | |
|---|---|
| **CURRENT PHASE** | Phase 9 — taxonomy activation (Track A) |
| **CURRENT MILESTONE** | Stage D — promotion readiness |
| **COMPLETED** | Stage A observe · Stage B backfill (P1-B PASS) · Stage C shadow (offline) · 41 trainer phrases |
| **IN PROGRESS** | Stage D — 5 of 7 promotion gates green at 96/96 |
| **BLOCKED** | `RESOLVABLE_ABOVE_FLOOR` **34 of 96 fail** (62 pass — the two documents used opposite conventions) and `NO_REGRESSION` **96 of 96**. `EVAL_COVERED` is **green** under the fixture in use; the "41/96" quoted elsewhere is the superseded `retrieval-v2`. Promotion candidates **0**. |
| **NEXT 3 ACTIONS** | 1. **Owner: `D-7C-1a`** — two ratified decisions together orphan `GD&T`; the seeder refuses on it. 2. **Owner: `NO_REGRESSION` semantics** — two prior instructions point different ways, and the gate is untouched until one is unambiguous. 3. **Infra: the value of `SKILL_CANONICALIZE_ENABLED`** — the secret was changed 2026-08-24 and every deploy since carries it. |
| **PRODUCTION-CRITICAL** | **None.** No taxonomy component is on a production request path. |
| **OPTIONAL / HARDENING** | **6** write runners with no ops guard at all (measured 08-26, not 4) · `AI_SPEND_REDIS_URL` IPv6 · pooler saturation · no delete-forensics on `jobs`/`applications` |
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
| OTP / auth | ✅ | ✅ | ✅ 382 verified **[08-21 pre]** | ✅ **37 workers [08-26]**, all created 08-21..25 | — | **ACTIVE** |
| Consent / DPDP | ✅ | ✅ | ✅ 333 accepted **[08-21 pre]** | ✅ | — | **ACTIVE** |
| AI profiling | ✅ | ✅ | ✅ 223 extractions **[08-21 pre]** | ✅ | on | **ACTIVE** |
| Resume | ✅ | ✅ | ✅ 114 generated / 196 downloads | ✅ | — | **ACTIVE** |
| Job feed | ✅ | ✅ | ✅ 7,616 shows **[08-21 pre]** / **19 jobs, 17 open [08-26]** | ✅ | — | **ACTIVE — basic filters only** |
| Applications | ✅ | ✅ | **28 [08-26]** (92 across 21 jobs **[08-24]**, unreconciled) | ✅ | — | **ACTIVE** |
| Interview kit | ✅ | ✅ | ⚠ 16 failed / 12 completed | ✅ | — | **DEGRADED** |
| Voice | ✅ | ✅ | ❌ 0 events | ❌ | consent purpose unissued | **DORMANT** |
| Skill taxonomy corpus | ✅ | ✅ | ✅ 4,071 domains / 9,121 aliases **[08-24]** | ❌ | — | **BUILT, not routed** |
| Skill canonicalization | ✅ | ✅ | ❌ | ❌ | `SKILL_CANONICALIZE_ENABLED` — **value UNVERIFIED**; the secret exists and was changed 2026-08-24 11:30:45 UTC, and deploys run on every `main` push | **STATE UNKNOWN** |
| Domain match | ✅ | ✅ | ⚠ **10 of 22 profiles carry a `job_domain_id` [08-26]** — all lexical (`l0_exact`/`l2_trigram`) or worker-confirmed; the ANN layer never ran | partial | `DOMAIN_MATCH_ENABLED=false` — **PROVED**: the secret does not exist, so compose's `:-false` governs | **FLAG-OFF, lexical layers live** |
| Path A / Path B retrieval | ✅ | ✅ | shadow only | ❌ | gated by canonicalize | **SHADOW** |
| Reach engine / `job_reach` | ✅ | ✅ | ❌ **0 rows [08-26]** | ❌ | — | **NOT CONNECTED** |
| Relevance ranking | ✅ | ✅ | ❌ | ❌ | — | **NOT CONNECTED** |
| Job visibility relevance | ❌ | ❌ | ❌ | ❌ | — | **NOT BUILT** |

## C. "If I create a job today, how does a worker see it?"

| # | arrow | state | evidence |
|---|---|---|---|
| 1 | Job created → `jobs` row | **LIVE** | **19 jobs, 17 open [08-26]**; none created since 2026-08-05 |
| 2 | Job title → `job_domain` (ANN over `job_domain_alias`) | **FLAG-OFF** | `DOMAIN_MATCH_ENABLED=false` |
| 3 | `job_domain` → `job_domain_skill` scope | **NOT REACHED** | step 2 never runs |
| 4 | Skill phrases → canonical ids → `job_posting_skill` | **NOT CONNECTED** | **0 rows, ever** |
| 5 | Worker speech → extracted skill labels | **LIVE** | 223 extractions |
| 6 | Labels → canonical ids → `worker_skill` | **FLAG-OFF** | **0 rows [08-26]** |
| 7 | worker ∩ job skills → reachability (`job_reach`) | **NOT CONNECTED** | **0 rows [08-26]**; feed does not read it |
| 8 | reachability → relevance score | **NOT CONNECTED** | `scoring.ts` not on the request path |
| 9 | score → feed ordering | **NOT CONNECTED** | feed emits `score: 0` |
| 10 | **feed query → worker** | **LIVE** | `findOpenJobs` |
| 11 | feed → application | **LIVE** | **28 applications [08-26]** |

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
| **What changed 08-21 → 08-24** | the *evidence* moved, not the system: nine investigations landed, none touching production. The programme is no longer blocked on knowing things — it is blocked on deciding them (§H) |
| **Verify it** | §E above |

---

## G. Investigation ledger — 2026-08-21 → 2026-08-24

Nine tasks landed. **None mutated production, none changed a gate, floor or baseline, and
total AI spend across all of them was zero.** Each is one PR, merged and verified on `origin/main`.

| task | PR | what it established |
|---|---|---|
| 9A ISCO materializer | #1184 | pure core + dry-run with **no write path at all**, asserted by reading its own source |
| 9B fan-out measurement | #1188 | 488 edges / **64** domains, not the predicted 89; 4 of 28 roots produce all of it, two produce 81.8% |
| D-5 junk labels | #1189 | 96 non-title labels are NCO scrape residue — **Class A is empty**, none is disposable |
| D-6 vernacular | #1190 | floor pressure is a **paraphrase** property, not a language one |
| D-6 correction | #1192 | Hinglish **is** measured — by the wedge eval, not the gate-bearing fixture |
| D-7 crosswalks | #1193 | re-tagging can **invent** a match claim; two widening crosswalks, one live |
| D-5 artifact | #1194 | the owed JSON, with provenance |
| Provenance | #1195 | the worker-count discrepancy **resolved**; artifacts must now say when they were true |

### What each one refuses to let regress

Nine tripwires now fail if a finding silently changes: the dry-run's absent write path, the
inheritance invariants, the promotable-vs-bridge gap (96/96 outside `SKILL_CORPUS`), the
coded-occupation protection, cross-domain alias collisions, the zero romanized-Hindi coverage,
the ratified-alias delivery path, the two widening crosswalks, and evidence provenance.

---

## H. The decision surface — everything now waits on a human

> **The full brief is [`owner-decision-packet.md`](./owner-decision-packet.md)** — eight
> decisions in FACTS / MEASURED EVIDENCE / RISK / OPTIONS / RECOMMENDATION form, plus the
> mutation plans, rollbacks, sequencing and the pooler note. The table below is the index.

> **CORRECTED 2026-08-26.** The sentence that stood here — *"No independently executable
> engineering task remains in this programme"* — was true when written and stopped being true
> the same week. **Nine more engineering tasks have landed since, and one remains executable
> today.** The decision surface is now held as typed data with a validator
> (`programme-graph.ts`), rendered to
> [`programme-graph.md`](../registers/taxonomy-decisions/programme-graph.md), precisely so a
> claim like that cannot sit in prose being quietly wrong again.

**The programme is blocked on people, not on engineering — but not entirely.**

```
EXECUTABLE                     1   OPS-GUARD-COVERAGE
BLOCKED_ON_OWNER              11
BLOCKED_ON_AI_SPEND            2   INR 0.028128 total
BLOCKED_ON_PRODUCTION_WRITE    3   mechanisms built, tested, never invoked
BLOCKED_ON_DATA                2
BLOCKED_ON_INFRA               4
COMPLETE                       7
```

Promotion is blocked by **4** items, canonicalization by **12**. The table below is the older
index; the graph is authoritative for status.

| # | decision | evidence | recommendation |
|---|---|---|---|
| ~~**Q1**~~ | ~~who owns the attribute→match mapping~~ **RATIFIED 2026-08-26** | 5 mapped, 91 explicitly unmatched; the exhaustiveness contract now covers `SKILL_CORPUS` ∪ the promotable batch | **CLOSED** — `MATCH_VOCABULARY` passes 0/96 |
| **0.75 floor** | keep or move | Hindi and English paraphrase sit at the same distance from it; for single-word vernacular the correct answers **interleave with the negatives** (`chhilai` 0.5284 < `biryani banana` 0.5427) | **keep** — no threshold separates them; the fix is the corpus |
| **`NO_REGRESSION`** | fixture-version semantics | rejects on version mismatch before comparing scores | unchanged — decision recorded separately |
| **D6-0** | ~~ship the 22 ratified vernacular aliases~~ **— already shipped 2026-07-16** | all 22 live in `skill_alias` and embedded (measured 2026-08-24). The earlier "none delivered" claim was wrong. | authorize the **re-sweep** (~INR 0.003) — the effect has never been measured |
| **D-7 A** | should `skill_boring` inherit `mskill_cnc_turner` | bridge maps boring to `[]` deliberately; TD-03 routes it to turning | re-point, or accept explicitly. **Dormant** until a seed run |
| **D-7 B** | should `skill_chassis_fitting` inherit `mskill_fitter` | same shape, **and live in production today** | rule before the next `db:retag:skills` |
| **D-7 C** | seed the 4 corpus deprecations | 4 rows drift; the seeder warns `--preserve-existing-status` is mandatory | not until A and B are ruled on — seeding arms the dormant hazard |
| **D6-1** | who authors the vernacular fixture | 0 romanized cases in the gate-bearing fixture; `db:mine:aliases` has **nothing to mine** (1 worker) | needs human authoring or worker traffic — not an agent |
| **D-7C-1a** | *(new 08-26)* the 2026-08-21 elections and the D-7C seed together orphan `GD&T` | both ratified, each safe alone; `db:seed:deprecations` refuses on it | re-point the elections, drop `skill_gdt_reading` from the seed, or accept the loss |
| **D-7C-1b** | *(new 08-26)* which skill keeps `CAD`, `drawing padhna`, `read engineering drawings`, `technical drawing` | 4 duplicate rows at 1.0000; the successor is the corpus's own answer | ratify the successor, elect the source, or wait for TAX-6 |
| **§5a-2** | *(new 08-26)* the sibling margin | separation costs **26 of 43** right answers at its first working value; a shared-token rule misses GMAW/SMAW at 0.8405 | evidence favours A or a curated C; B is the option the numbers argue against |
| **Flag value** | *(new 08-26)* what is `SKILL_CANONICALIZE_ENABLED` in the running container | the secret exists and was **changed 2026-08-24 11:30:45 UTC**; deploys run on every `main` push | **infra fact request** — one command on the box |
| **Promotion** | — | `RESOLVABLE_ABOVE_FLOOR` **34 fail / 62 pass**, `NO_REGRESSION` 96 fail | **0 candidates.** Blocked on the above |

### Infrastructure

The Supabase pooler (`EMAXCONNSESSION`, `pool_size: 15`) blocked read-only verification eight
times on 2026-08-21, was responsive on 2026-08-24, and **did not fire once across the 2026-08-26
session** — roughly forty read-only runs, including six full-corpus vector sweeps. It is
intermittent rather than fixed, it remains the binding constraint on every measurement task, and
**no configuration was changed**. It warrants its own owner and task.

**Two infrastructure facts added 2026-08-26.** `DOMAIN_MATCH_ENABLED` does not exist as a secret,
so compose's `${DOMAIN_MATCH_ENABLED:-false}` governs and the deployed value is **proved false**.
`SKILL_CANONICALIZE_ENABLED` **does** exist, its value was **changed on 2026-08-24 11:30:45 UTC**,
and the deploy job runs on every push to `main` — so the change is live and nothing in this
repository records what it became. Several documents lean on *"the flag is off"* as a safety
argument; exactly one of those two flags supports it.
