# The activation procedure — everything up to the flag, and the flag itself

**2026-08-27 · evidence gap CLOSED · every gate green · AI spend this phase ₹0.00563 (authorised)**
**`SKILL_CANONICALIZE_ENABLED` NOT read, NOT changed. Canonicalization is NOT active.**

> **Canonicalization is never "active" because a configuration file says `true`.** Runtime
> container state is the only source of truth, and step 7 is the only thing in this document
> that establishes it. A `docker-compose.yml` default, a GitHub secret, a `.env`, and this
> repository are all *inputs* to that value — none of them is the value.

---

## 0. Where this stands

Steps 1–4 are **done and verified below**. Step 5 needs a production configuration change and
is the authorisation boundary. Steps 6–16 are written to be executed in one sitting after it.

| | step | state |
|---|---|---|
| 1 | pre-activation database check | **DONE** |
| 2 | confirm 111 active / 34 held provisional | **DONE** |
| 3 | confirm every canonicalization gate green | **DONE** |
| 4 | confirm no unauthorized writer exists | **DONE** |
| 5 | enable `SKILL_CANONICALIZE_ENABLED` | **BLOCKED — needs owner authorisation** |
| 6–16 | redeploy, verify runtime, smoke, monitor, rollback, report | prepared, not run |

---

## 1 ▸ Pre-activation database check — DONE

Read-only against the production cluster, 2026-08-27.

```
skill.status                                    active=111  deprecated=5  provisional=49
held ids still provisional (want 34)            34
held ids that are active (want 0)               0
distinct embedding models on live rows (want 1) 1
skill_alias rows with a mock vector (want 0)    0
active skills with >=1 embedded alias           93 of 111   (18 pre-date this programme)
```

**Baselines for the monitoring step — the numbers activation is supposed to move:**

```
worker_skill rows          0
job_posting_skill rows     0
unresolved_phrase rows     48      newest last_seen 2026-08-26T11:49:04.109Z, all 48 scoped
```

`worker_skill = 0` is the sharpest signal available: **canonicalization has never assigned
anything.** Any non-zero value after step 5 is the first proof the flag took effect.

## 2 ▸ 111 active, 34 held — DONE

Confirmed by id, not by subtraction: all 34 register ids read `provisional`, none reads
`active`, and 0 of them are admitted by production's retrieval predicate
(`s.status='active' AND a.embedding IS NOT NULL`). All 62 promoted ids read `active` and all 62
are retrievable.

## 3 ▸ Every gate green — DONE, on evidence with NO coverage gap

The ₹0.00563 the owner authorised bought the 41 missing query vectors. **The sweep now decides
164 of 164 cases, 0 unmeasured, 0 errors** — the first complete measurement in this programme.

| criterion | over the 62 promoted |
|---|---|
| `GATE_ACCEPTED` | **62 / 62** |
| `ACTIVE_EDGE` | **62 / 62** |
| `FULLY_EMBEDDED` | **62 / 62** |
| `EVAL_COVERED` | **62 / 62** |
| `RESOLVABLE_ABOVE_FLOOR` | **62 / 62** |
| `NO_REGRESSION` | **62 / 62** — R@1 1 / MRR 1 vs the unchanged 1/1 reference |
| `IS_PROVISIONAL` | 0 / 62 — **because they are already `active`.** Promotion is idempotent-refusing, which is the correct post-promotion reading, not a failure |

`waived: []`, evidence freshness `current`, drift `[]`, match-vocabulary tripwire passing
(5 MATCHED / 91 INTENTIONALLY_UNMATCHED / 0 MISSING / 0 INVALID). Hold register: **34 held, 0
releasable, 0 unauthorised, 0 unknown.**

### What the newly-bought evidence actually decided

The 41 cases were bought to answer one question honestly: *does fuller evidence change the
62/34 split?* Measured on the provisional-inclusive sweep, so the held skills can score at all:

- **0 of the 34 held skills clear 0.75.** Not one.
- **0 of the 30 scored held skills moved by more than 0.0001.** The new cases produced no better
  correct resolution for any of them.
- The same **4** remain never-resolved (`skill_battery_capacity_checking`,
  `skill_indoor_unit_servicing_and_cleaning`, `skill_pump_and_valve_repair`,
  `skill_switchgear_installation`) — the 41 new cases did not reach them either.
- **All 62 promoted still clear the floor** on the fuller evidence: 62/62, none below, none
  unmeasured.

**The gap is closed and the ruling stands unchanged.** That is the strongest available outcome:
the disposition was decided on partial evidence and complete evidence confirms it.

### No regression introduced by the 62

Production-equivalent sweep (`skill_statuses = ["active"]`), all 164 cases:

```
threshold   TP    FP    FN    TN   precision   recall   assigned
    0.75   109     0    11    44     100.0%    90.8%     66.5%   <- CURRENT FLOOR
```

- **Zero false positives at the floor.** The highest-scoring wrong answer anywhere is **0.7245**
  (`TP-39 → skill_brazing_of_copper_lines`), which the floor refuses.
- 32 of the 44 sub-floor false positives name a skill promoted today — the promotion **did**
  widen the wrong answers as well as the right ones, and the floor is what makes that safe.
- **0** held skills appear as a wrong answer in the production-equivalent sweep: they are
  genuinely unretrievable, not merely unlikely.
- Evaluation on the baseline instrument, post-promotion: **R@1 1.0000 / MRR 1.0000**, 123
  queries, 0 failures, ₹0 (127/127 cached), fingerprint `skills_active = 111`.

## 4 ▸ No unauthorized writer — DONE

- Every production write this programme performed went through `enforceOpsGuard`, requiring
  `--i-am-authorised-to-write-to-production` **and** `OPS_ALLOW_PRODUCTION=<script>`. No guard
  was bypassed and no new writer was created.
- `lifecycle-writer-scan` derives the writer set from source rather than from a hand-maintained
  list; `script-entrypoint-guard.test.ts` and `programme-graph.test.ts` pin that every runner on
  the activation path reaches the guard.
- **The ai-service cannot write to the database at all.** It is DB-free by design: the write path
  runs through `get_skill_store()`, which returns the inert `NullSkillStore` unless *both*
  `BACKEND_API_URL` and `SKILLS_INTERNAL_TOKEN` are set (TD65 chain: **store + flag**, and the
  flag alone does nothing). The NestJS api runs every authorized query.

---

## 5 ▸ Enable the flag — **THE AUTHORISATION BOUNDARY. NOT DONE.**

The effective value **has not been read**, so whether this step is even needed is unknown. See
§5a. Assuming it reads `false`, this is the change, and it is the one thing needing approval:

```
GitHub → repo Settings → Secrets and variables → Actions → SKILL_CANONICALIZE_ENABLED
  set the value to: true
```

Then trigger a deploy (any push to `main` runs `deploy-lightsail`, or re-run the last workflow).
`docker-compose.yml` reads `SKILL_CANONICALIZE_ENABLED: ${SKILL_CANONICALIZE_ENABLED:-false}`,
so the secret's value governs and the `:-false` default applies only if it is empty.

**Nothing else in this document requires approval. This one line is the whole ask.**

### 5a ▸ The value must be READ first, and it cannot be read from here

The instruction was explicit: not from the local `.env`, repository defaults, GitHub secrets,
Langfuse, endpoint behaviour, or source code. Only the running container counts. Every route
from this workstation is closed — documented in
[`canonicalize-flag-read-2026-08-27.md`](./canonicalize-flag-read-2026-08-27.md).

> **An ai-service IS answering on `localhost:8000` — and it is NOT the deployed one.** Its
> `/health` reports `build: "unknown"`. The pipeline bakes a 7-char `GIT_COMMIT_SHA` into every
> image and CI *asserts* the derivation, so a process reporting `unknown` was not built by it.
> It is a local dev process, `docker ps` shows no `ai-service` container, and reading its
> environment would answer a question nobody asked.

**The one command an operator with Lightsail access must run:**

```bash
docker compose exec ai-service env | grep SKILL_CANONICALIZE_ENABLED
```

Report the value verbatim. If it is **absent** from the output, the variable is unset in the
container and the effective value is `false`.

---

## 6–16 ▸ After authorisation

### 6 ▸ Redeploy only the ai-service
```bash
docker compose pull ai-service && docker compose up -d --no-deps ai-service
```
`--no-deps` is deliberate: `ai-service` declares no `depends_on` (it is DB-free and its spend
ledger fails closed), so nothing else needs restarting and the api must not be bounced.

### 7 ▸ Verify the EFFECTIVE runtime value — the only step that establishes "active"
```bash
docker compose exec ai-service env | grep SKILL_CANONICALIZE_ENABLED   # expect: true
docker compose exec ai-service python -c "from app.config import get_settings; print(get_settings().skill_canonicalize_enabled, get_settings().skill_canonicalize_floor)"
curl -s localhost:8000/health | jq -r .build    # must equal the deployed short sha, not "unknown"
```
**Do not proceed past this step on the strength of the compose file, the secret, or a successful
deploy.** If the process reports `False`, the deploy did not carry the value and steps 8–14 would
measure the old build.

### 8–11 ▸ Controlled smoke tests

Five cases, each with its measured score from the 2026-08-27 production-equivalent sweep, so the
expected outcome is known before the call. `POST /skills/canonicalize` with
`x-ai-internal-token`.

| # | case | phrase | `job_domain_id` | measured | **expected response** |
|---|---|---|---|---:|---|
| A | PH-04 | `माल की गिनती करना` (hi) | `jd_isco_4321` | 0.9546 | `matched` → `skill_stock_counting` |
| B | CV-04 | `fork-lift truck driving` (en) | `jd_nco_4321_0601` | 0.9069 | `matched` → `skill_forklift_operation` |
| C | TP-32 | `fixing brackets so the line does not sag` (en) | `jd_nco_7126_0301` | 0.6139 | **`unresolved`** — correct answer, below floor |
| D | TP-39 | `तापमान कंट्रोल का तार जोड़ना` (hi) | `jd_isco_7127` | 0.7245 | **`unresolved`** — the highest-scoring wrong answer in the corpus |
| E | TP-27 | `mounting contactors and breakers in the panel` (en) | `jd_nco_7412_0200` | 0.7211 | **`unresolved`** — wrong answer, second highest |

- **9 ▸ correct matches**: A and B must return `matched` with those exact `skill_id`s.
- **10 ▸ below-floor stays unresolved**: C is the *right* answer at 0.6139 and must still come
  back `unresolved`. A `matched` here means the floor is not 0.75 in the running process.
- **11 ▸ no false assignment**: D and E are the two closest calls in the entire corpus. Both
  expect a **held** skill and both retrieve a **promoted** one. If either returns `matched`, stop
  and roll back — a worker has just been given a skill they did not claim.

### 12 ▸ `unresolved_phrase` and event logging
```sql
SELECT count(*), max(last_seen) FROM unresolved_phrase;   -- baseline 48 / 2026-08-26T11:49:04.109Z
```
C, D and E must each produce a row (or bump an existing `count`) with a `last_seen` after the
smoke run. **Zero new rows after three unresolved calls means the seam is inert** — check
`BACKEND_API_URL` and `SKILLS_INTERNAL_TOKEN` before concluding anything about the flag.

### 13 ▸ Observability
Langfuse must show `task_type=skill_canonicalization` traces for all five calls, and **none**
carrying `status_message="skill_canonicalize_disabled"`. That string appearing after step 7
means the running process still has the flag off.

> Langfuse credentials in the local environment currently return **401** on both public
> endpoints. Fix that before activation, or step 13 cannot be performed — it is the only route
> that distinguishes "the flag is off" from "nothing matched", which return identical bodies.

### 14 ▸ Error-rate monitoring, first 24h
- `worker_skill` / `job_posting_skill` row counts — **0 today**; non-zero is the first proof
  activation did anything.
- `unresolved_phrase` growth rate by scope — the canonicalizer's miss rate in production.
- `ai.cost_recorded` events tagged `skill_embedding` — one embed per canonicalized phrase.
- ai-service 5xx rate and `/health` `spend` snapshot.
- **Re-measure the three §5a ceilings. A ceiling above its pre-promotion value is a reason to
  stop, not to continue carefully.**

### 15 ▸ Rollback
```bash
# 1. set the GitHub secret SKILL_CANONICALIZE_ENABLED back to: false
# 2. redeploy only the ai-service:
docker compose pull ai-service && docker compose up -d --no-deps ai-service
# 3. prove it took, from inside the container — never from the config file:
docker compose exec ai-service env | grep SKILL_CANONICALIZE_ENABLED   # expect: false
```
**Partial, and honestly so: rows written while the flag was on are NOT unwritten.** Any
`worker_skill`, `job_posting_skill` or `unresolved_phrase` rows created during the window
survive the rollback and must be removed deliberately if they are unwanted. The promotion itself
is separately reversible with `db:promote:skills --revert <report> --apply`.

### 16 ▸ Final activation report
Record: the value read at step 7 (before and after), the five smoke results with actual scores,
the `unresolved_phrase` delta, the Langfuse trace ids, the 24h counters, and whether the three
ceilings moved.

---

## The single outstanding authorisation

**Set the GitHub Actions secret `SKILL_CANONICALIZE_ENABLED` to `true` and redeploy the
ai-service.** Everything else in this document either is already done or follows from it without
further approval.

And before that, the one command that tells us whether it is even needed:

```bash
docker compose exec ai-service env | grep SKILL_CANONICALIZE_ENABLED
```
