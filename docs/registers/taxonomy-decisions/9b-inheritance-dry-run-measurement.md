# 9B — ISCO inheritance materializer, measured against production

**Measured 2026-08-21 · main `8aa4df78` · read-only · production mutation NONE · AI spend ₹0**

Evidence: [`9b-inheritance-dry-run.json`](./9b-inheritance-dry-run.json) ·
[`9b-bridge-coverage-phase9d.json`](./9b-bridge-coverage-phase9d.json)

Reproduce:

```
pnpm db:materialize:inheritance:dry-run --json=<out>
pnpm db:audit:bridge-coverage --json=<out>
```

The first opens one connection and issues three `SELECT`s. The second reads only committed
files and code — no database, no credentials.

---

## 1. The expected number was right, and it was measuring something else

The prediction was *28 authored occupations → ~89 domains*. **89 is exactly right, and it is
not the fan-out.**

```
28  authored root domains
64  strict descendants reached
 3  roots that are themselves descendants of another root
──
89  distinct domains TOUCHED  (28 + 64 − 3)
64  distinct domains that would GAIN an edge
```

The three double-counted domains are `jd_nco_4321_0100`, `jd_nco_4321_0601` and
`jd_nco_7233_0101` — and they are precisely the three that triggered `AUTHORED_WINS`. A
descendant that authored its own edges is both reachable and a root, which is the correct
outcome twice over rather than a discrepancy.

**Report 64, not 89.** 89 counts the roots, and a root gains nothing from itself.

## 2. Source state

| | |
|---|---|
| `job_domain` rows | 4,071 |
| `job_domain_skill` rows | 236 |
| `skill` rows | 165 |
| authored root domains | 28 |
| existing `inherited` rows | **0** — this would be the first materialization |

## 3. Fan-out — and it is not broad

**488 candidate edges across 64 domains, from 32 distinct skills.** All at **depth 1**.

| authored root | edges | domains | cumulative |
|---|---:|---:|---:|
| `jd_isco_7233` | 290 | 37 | 59.4% |
| `jd_isco_4321` | 109 | 17 | 81.8% |
| `jd_isco_7213` | 81 | 9 | 98.4% |
| `jd_isco_7127` | 8 | 1 | 100.0% |

**Four of 28 roots produce all of it. Two produce 81.8%.**

The 24 silent roots are not a defect and not a walk that stopped early — every one of them is
a `jd_nco_*` L5 leaf with no children, and all four productive roots are `jd_isco_*`. The
structure is therefore: **ISCO-level authorship inherits; NCO-level authorship is terminal by
construction.** The `{"1": 488}` depth histogram says the same thing from the other side — the
authored corpus sits exactly one level above the leaves, so there is no grandchild inheritance
to find.

The concentration is a statement about how thin the authored corpus is (28 occupations of
4,071), not about the tree.

Top skills by reach — the industrial-maintenance cluster under `jd_isco_7233` dominates:

| skill | domains | status |
|---|---:|---|
| `skill_belt_and_chain_drive_alignment` | 37 | provisional |
| `skill_pump_and_valve_repair` | 37 | provisional |
| `skill_bearing_replacement` | 36 | provisional |
| `skill_bench_fitting` | 36 | active |
| `skill_hydraulics_pneumatics` | 36 | active |
| `skill_machine_maintenance` | 36 | active |

## 4. Dispositions, and why each zero is a zero

A fail-closed count of zero means one of two very different things: the rule looked and found
nothing, or the rule could never have fired. Only the first is evidence. The dry-run now
reports the **population each rule was searching**, so the difference is legible.

| disposition | count | population it searched | reading |
|---|---:|---|---|
| `CANDIDATE` | 488 | — | would be written |
| `EXISTING` | 0 | 0 `inherited` rows today | first materialization — **idempotency is proven in memory, not observed in production** |
| `AUTHORED_WINS` | 16 | 3 descendants hold their own authored edges | rule fired; authored edges preserved |
| `AMBIGUOUS` | 0 | **0** domains reached by more than one root | cannot fire — no diamond exists in today's tree |
| `UNRESOLVABLE` | 0 | **0** authored-edge skills absent from `skill` | the foreign key doing its job |
| `SKIPPED_DOMAIN` | 0 | **0** reachable domains inactive or unselectable | every reachable domain is already servable |
| `SKIPPED_DEPRECATED_SKILL` | 0 | 2 deprecated skills on authored edges, **0 of them on a root with descendants** | see below |

**The deprecated-skill guard is the one to be careful about.** Two deprecated skills *are* on
active authored edges, so a naive reading of "2 at risk, 0 skipped" looks like a broken guard.
It is not: both sit on childless occupations, so nothing was ever evaluated against them. The
guard's only evidence today is its unit test — production has not exercised it. That is
recorded rather than glossed, and is why the report separates
`deprecatedSkillsOnAuthoredEdges` from `deprecatedSkillEdgesReachingDescendants`.

Duplicates: **structurally impossible**. `job_domain_skill` PK is `(job_domain_id, skill_id)`.

**326 of 488 candidates (66.8%) depend on a `provisional` skill** — invisible to production
retrieval, which serves `active` only. They are reported, not discarded: whether those skills
should be servable is a promotion decision, not an inheritance decision.

## 5. Invariants, re-derived rather than trusted

The unit tests prove the rules on synthetic trees. That is necessary and insufficient — the
production tree is 4,071 nodes no author ever saw. `verifyInvariants` re-derives the answer
from the same inputs and compares it against what the plan claims.

| invariant | method | result |
|---|---|---|
| author → **strict descendant** only | every proposal's target re-checked against an independently recomputed descendant set, including its depth | **HOLDS** (0 violations / 504 proposals) |
| never sibling, never ancestor, never self | a sibling or ancestor is by definition absent from that set; self-inheritance checked explicitly | **HOLDS** |
| `inherited` is never a root | relabel **every** edge in the corpus as `inherited` and re-plan — roots must come back empty | **HOLDS** |
| converges | materialize all 488 candidates in memory as `inherited` and re-plan | **HOLDS — second pass proposes 0** |

The third is the one that matters for recursion. If `inherited` could root a fan-out, the
result would depend on execution order and the plan would expand off its own output. The check
does not inspect the rule; it tries to make the rule fail and reports that it could not.

The fourth is a genuine one-pass fixed point, on real data, not a synthetic fixture.

Cycles in the domain tree: **0**. (`parent_job_domain_id` is a self-FK with nothing preventing
a loop, so the walk is cycle-guarded regardless.)

## 6. What this measurement does NOT mean

> **488 edges is authoring coverage. It is not matching coverage.**

```
ISCO inheritance → job_domain_skill → authoring / corpus coverage
```

```
worker attributes → ATTRIBUTE_TO_MATCH_SKILLS → mskill_* → worker_skill → job_reach → feed
```

`job_domain_skill` has **no runtime reader** ([`d1-runtime-path-trace.md`](./d1-runtime-path-trace.md)).
Materializing these 488 edges would change nothing a worker or an employer sees. The dry-run
prints that sentence with every run so a fan-out number cannot be quoted as a relevance win.

## 7. The Phase-9 blocker this measurement was asked to find

`pnpm db:audit:bridge-coverage`, against the batch that would actually promote
(`batch_2026-08-16T14-30-41Z-remediation-phase9d`, 96 skills):

```
promotable skills                     96
├── in SKILL_CORPUS + mapped           0
├── in SKILL_CORPUS + intentional []   0
├── in SKILL_CORPUS + missing mapping  0
└── outside SKILL_CORPUS              96      ← all of them
```

The same measurement over the parent 98-skill batch gives 98 outside. **The intersection
between the growth corpus and `SKILL_CORPUS` is empty.**

`ATTRIBUTE_TO_MATCH_SKILLS` has 49 keys reaching 15 distinct `mskill_*`, and its exhaustiveness
test asserts the key set equals `SKILL_CORPUS` exactly. That test reads as full protection and
is not: **its universe is the 49 hand-authored seeds.** A skill that never entered
`SKILL_CORPUS` is not unmapped-and-failing — it is outside the question the test asks.

So if the gates were satisfied tomorrow, promotion would make 96 skills `active`, visible to
canonicalization and to the corpus, **reaching nothing at match time, with no test failing
anywhere.** That silence is the defect, more than the coverage gap itself.

A tripwire is now pinned in `audit-runtime-bridge-coverage.test.ts` asserting the shape of this
finding (96 / 96 outside). It is not a gate — it fails if the situation changes, so this report
must be re-stated rather than quietly going stale.

### Evidence → impact → recommendation → owner decision

**Evidence.** 96 of 96 promotable skills are outside the runtime bridge's universe. 0 reachable.
0 triaged.

**Impact.** Promotion is currently a taxonomy-only event. It adds vocabulary and adds no reach.
Nothing fails, so the gap would not announce itself after the fact.

**Recommendation.** Before promotion, require every promotable skill to carry either a mapping
or an explicit "intentionally not matched" decision — that is, extend the exhaustiveness test's
universe from `SKILL_CORPUS` to the promotable corpus. Note this makes the bridge's cost
visible: 96 triage decisions, each with a product consequence, because mapping eagerly is how
an unrelated worker reaches a specialist vacancy.

**Owner decision required.** This is Q1 (mapping ownership: hardcoded constant vs database
relation) reaching its practical deadline. It is not changed here. **Nothing was mapped, and no
gate was touched.**

## 8. Gates — unchanged

```
GATE_ACCEPTED / IS_PROVISIONAL / ACTIVE_EDGE / FULLY_EMBEDDED / EVAL_COVERED    96 PASS
RESOLVABLE_ABOVE_FLOOR                                                          FAIL 62/96
NO_REGRESSION                                                                   FAIL
PROMOTION CANDIDATES                                                            0
```

Nothing in 9B evaluates, sweeps, promotes, or re-baselines. No embedding evaluation was rerun,
the 0.75 floor is untouched, and `REGRESSION_BASELINE` is untouched.

## 9. Deferred

- **An authorized apply.** The dry-run has no write path by construction. Execution belongs in
  a separate guarded runner, and there is no reason to build it while the fan-out has no
  runtime consumer.
- **The `AMBIGUOUS` and `SKIPPED_DEPRECATED_SKILL` guards are unexercised by production data.**
  Both are covered by unit tests only. This is the honest status, not a gap to paper over — a
  fixture cannot make a diamond exist in the real tree.
