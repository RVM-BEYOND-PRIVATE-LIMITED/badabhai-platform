# Owner Decision Packet — Phase 9 taxonomy programme

> **Companion to [`project-control.md`](./project-control.md) §H.** That section is the index;
> this is the brief. Nothing here has been decided, and nothing here has been actioned.
>
> Every decision below uses: **FACTS · MEASURED EVIDENCE · RISK · OPTIONS · RECOMMENDATION ·
> OWNER DECISION: PENDING.** The last line is deliberately unfilled in all eight.

**Prepared 2026-08-24 · main `24ed3ea0` · no production mutation · AI spend ₹0**

Evidence tags: **MEASURED** production observation · **STATIC** repository inspection ·
**TESTED** automated assertion · **INFERRED** derived conclusion.

---

## 1. Executive summary

Fifteen tasks of investigation are complete. **No independently executable engineering work
remains** — every open item needs a human to decide something, authorise a production write,
approve spend, or supply data that does not exist.

Three findings dominate the decision surface:

1. **Promotion would be inert.** All 96 promotable skills sit outside `SKILL_CORPUS`, so
   `ATTRIBUTE_TO_MATCH_SKILLS` cannot reach them. They would go `active`, match nothing, and
   **no test would fail.** (§9)
2. **One live crosswalk can invent a match claim.** `skill_chassis_fitting` is deprecated in
   production with a pointer to a skill that maps to `mskill_fitter`; the next
   `db:retag:skills` acts on it. (§6)
3. **The cheapest available win is already approved and undelivered.** 22 vernacular aliases
   ratified 2026-07-16, measured to convert ~0.55 UNRESOLVED into ≈1.0 exact, cost to ship
   **≈₹0.002**. (§5)

The programme is no longer blocked on knowing things. It is blocked on deciding them.

## 2. Main SHA this packet was prepared against

```
24ed3ea0   docs(architecture): refresh project-control — and date every count in it (#1196)
```

Stated as "prepared against" rather than "current" on purpose: `main` advances independently of
this document — it already has, via #1204 — and a bare SHA labelled *current* becomes wrong
without anyone editing it. Every measurement below carries its own date, and the artifacts
carry `measured_at` (§14, tripwire 9). **No finding here depends on a commit later than
`24ed3ea0`**, and none of the eight decisions is affected by unrelated work landing on `main`.

## 3. Current gate state — unchanged, and not to be touched

```
GATE_ACCEPTED           96 PASS
IS_PROVISIONAL          96 PASS
ACTIVE_EDGE             96 PASS
FULLY_EMBEDDED          96 PASS
EVAL_COVERED            96 PASS
RESOLVABLE_ABOVE_FLOOR  FAIL — 62/96
NO_REGRESSION           FAIL
PROMOTION CANDIDATES    0
```

## 4. Completed tasks

| # | task | PR | main | outcome |
|---|---|---|---|---|
| 1–8 | Phase 9 Stages B–G, de-collision, trainer pack, paid experiments | — | — | prior sessions |
| 9A | ISCO inheritance materializer | #1184 | `5c87f4c1` | pure core + dry-run with **no write path**, asserted from its own source |
| 9B | Fan-out measurement | #1188 | `0db268e3` | 488 edges / **64** domains (not 89); 4 of 28 roots produce all of it |
| 10 | D-5 junk labels | #1189 | `6c50bbb3` | 96 labels are NCO scrape residue; **Class A empty** — none disposable |
| 11 | D-6 vernacular | #1190 | `70a7dad8` | floor pressure is a **paraphrase** property, not a language one |
| 11b | D-6 correction | #1192 | `80c9ddfd` | Hinglish **is** measured — by the wedge eval, not the gate-bearing fixture |
| 12 | D-7 crosswalks | #1193 | `a95f954c` | re-tagging can **invent** a match claim; two widening crosswalks |
| 13 | D-5 artifact | #1194 | `d8d61df0` | the owed JSON, with provenance |
| 14 | Worker discrepancy + provenance | #1195 | `6cabf044` | discrepancy **resolved**; artifacts must say when they were true |
| 15 | project-control refresh | #1196 | `24ed3ea0` | every count date-stamped; decision surface stated |

**Across all of them: zero production mutations, zero gate changes, zero AI spend.**

---

## 5. DECISION 1 — D6-0: ship the 22 RVM-ratified vernacular aliases

### FACTS
Ratified by the RVM domain owner on **2026-07-16**, all 22, none struck, with two explicit
rulings (Q-A `chhilai` → `skill_deburring`; Q-B `drawing padhna` → `skill_drawing_reading`).
They live in `packages/taxonomy/src/wedge-aliases.ts` as `WEDGE_ALIASES`, every entry
`ratified: true`, every alias `lang: hi`.

### MEASURED EVIDENCE
**STATIC** — 22 aliases across **16 distinct skills**, all 16 present and live in
`SKILL_CORPUS`, **0 dangling**. **None of the 22 is in the corpus, and nothing consumes
`WEDGE_ALIASES`** — the only non-test reference in the repository is the generated `.d.ts`.
**TESTED** by `wedge-alias-delivery.test.ts`.

**MEASURED** (wedge eval, real vectors, 2026-07-14) — against the standards-only corpus these
phrases score **0.528–0.603**, i.e. below the 0.75 floor and therefore UNRESOLVED, while four
of five are the *correct* skill. As a stored alias each becomes an exact hit at **≈1.0**.

### Delivery plan, as requested

| item | answer |
|---|---|
| **1. Exact corpus mutation** | Add 22 `skill_alias` rows (`lang='hi'`, `source='rvm'`) against 16 existing `skill_id`s. **No new skill, no status change, no edge, no deletion.** Requires a seeder that consumes `WEDGE_ALIASES` — **none exists today**, so a small runner is part of the work. |
| **2. Expected vectors** | **22** — one embedding per new alias. Aliases seed with NULL embeddings, so `db:embed:skills` follows. |
| **3. Expected AI cost** | **≈₹0.002.** Derived from a recorded run: 164 embeddings cost ₹0.013969 → ₹0.0000852 each × 22. |
| **4. Affected skills** | 16: turning, deburring, drilling, tapping_threading, grinding_ops, fixture_setup, cnc_programming, program_editing, drawing_reading, measuring_instruments, quality_control, welder_occupation, gas_cutting, sheet_metal, bench_fitting, machine_maintenance. |
| **5. Rollback** | Additive and fully reversible: delete the 22 alias rows by id. No existing row is modified, so nothing else can be disturbed. Capture the inserted ids in the run record. |
| **6. Validation after deployment** | Re-run the wedge eval and confirm the five vernacular cases move from ~0.55 to ≈1.0; confirm `cross_domain_isolation` and the negatives are **unchanged** (recall must rise without precision moving); confirm alias count +22 and vector count +22. |
| **7. Changes any gate?** | **No.** It touches no gate input: not the promotable batch, not `EVAL_COVERED`, not the floor, not `REGRESSION_BASELINE`. `RESOLVABLE_ABOVE_FLOOR` and `NO_REGRESSION` are computed over the promotion batch, which this does not touch. |
| **8. Only SKILL_CORPUS / runtime-covered?** | **Yes** — all 16 are `SKILL_CORPUS` members, so all are inside the `ATTRIBUTE_TO_MATCH_SKILLS` universe. 6 of the 16 carry a live `mskill_*` mapping; the other 10 are deliberately `[]`. |

### RISK
Low and bounded. The additive shape means the failure mode is "an alias retrieves something it
should not", and the ratification already tested each phrase against its intended skill. The
one genuine risk is **collision**: a new alias normalizing onto an existing alias of a
*different* skill. Not yet measured — a pre-flight collision check over the 22 against the
existing `skill_alias` corpus should be part of the runner, failing closed.

### OPTIONS
- **A.** Authorise the corpus write + embed now.
- **B.** Keep waiting on the SR-1 staging environment named in the ratification packet.
- **C.** Strike the ratification and discard the 22.

### RECOMMENDATION
**A**, with the collision pre-flight. The expensive input — human judgement across 22 phrases,
including two rulings — was spent five weeks ago. What remains costs about two-tenths of a
paisa and is reversible by deleting rows. Waiting preserves a state where the corpus provably
cannot hear the shop floor.

### OWNER DECISION: PENDING

---

## 6. DECISION 2 — D-7B: `skill_chassis_fitting` → `mskill_fitter` *(highest priority)*

### FACTS
`skill_chassis_fitting` is a **growth-corpus** skill. Production already holds it
`status='deprecated'` with `replaced_by='skill_mechanical_assembly'`.

> **Correction to the briefing.** `replaced_by` is **`skill_mechanical_assembly`**, not
> `mskill_fitter`. `mskill_fitter` is what the *successor* maps to through the bridge. The
> distinction matters: the crosswalk is skill→skill, and the match claim is acquired
> **downstream**, which is exactly why the widening is easy to miss.

### MEASURED EVIDENCE
**MEASURED** — production holds exactly two deprecated skills with pointers, so
`db:retag:skills` (`WHERE status='deprecated' AND replaced_by IS NOT NULL`) finds **2 rows
today**, this being one. **STATIC** — `skill_chassis_fitting` is outside `SKILL_CORPUS` so the
bridge maps it to nothing; `skill_mechanical_assembly` is inside and maps to
`["mskill_fitter"]`.

```
before retag:  worker carries skill_chassis_fitting   -> {}
after  retag:  worker carries skill_mechanical_assembly -> { mskill_fitter }
```

**TESTED** — pinned in `crosswalk-integrity-corpus.test.ts`.

### Does it widen matching semantics?
**Yes.** Nothing is lost; a posting-level claim is **created**.

### What population could be affected?
**MEASURED** — today: **none.** `worker_skill` is empty, `job_reach` is empty, and one worker
row remains after the 2026-08-21 deletion. **INFERRED** — the exposure is prospective: once
worker traffic resumes and the retag runs, every worker carrying `skill_chassis_fitting`
acquires a Fitter claim. The blast radius is "all future chassis-fitting workers", not zero.

### Safe semantic replacement, or invented signal?
**Defensible, and still an invention.** Chassis fitting *is* mechanical assembly work, so
unlike `skill_boring` the concept transfer is sound. But the worker never claimed Fitter — the
claim arrives because two tables were authored independently and never compared. A defensible
inference is still an inference, and it should be made deliberately.

### RISK
Product principle #2 is *never show irrelevant candidates for a job*. A false gain puts a
worker in front of an employer on a claim that was never theirs; a false loss merely narrows
reach and is visible as a missing match. This is the worse direction, and it is live.

### OPTIONS
- **A.** Accept the widening explicitly — record that chassis fitting implies Fitter.
- **B.** Re-point `skill_chassis_fitting` at a successor that maps to `[]`.
- **C.** Deprecate without a successor (`replaced_by = NULL`), so the retag skips it.
- **D.** Leave as-is and forbid `db:retag:skills` until decided.

### RECOMMENDATION
**A or C, decided before the next retag run** — and **D as an interim** if that run could
happen first. Of the two widening crosswalks this is the more defensible on the merits and the
more urgent on timing. What must not happen is the claim arriving because nobody looked.

### OWNER DECISION: PENDING

---

## 7. DECISION 3 — D-7A: `skill_boring` → `skill_turning`

### FACTS
`SKILL_CORPUS` marks `skill_boring` deprecated with `replacedBy: skill_turning` (TD-03,
ratified). **Production still has it `active` with `replaced_by` NULL**, so the crosswalk is
**dormant** — the retag runner cannot see it.

### MEASURED EVIDENCE
**STATIC** — the bridge maps `skill_boring: []` deliberately, alongside drilling, tapping and
deburring, with the stated rationale that these are near-universal shop-floor operations and
mapping them "would reach a lathe hand for a programmer's vacancy". `skill_turning` maps to
`["mskill_cnc_turner"]`.

TD-03's impact note reads: *"`ATTRIBUTE_TO_MATCH_SKILLS` already maps this to no master-skill —
**no matching signal is lost**."* **That is true and answers only the loss direction.**

**MEASURED** — production `skill_boring`: 1 alias, 1 vector, 1 edge.

### The trap
Boring is performed on a machining centre or a boring mill as readily as on a lathe. It is
**not** evidence of turning competence, which is precisely why the bridge maps it to `[]`. The
crosswalk would hand every boring worker a CNC-turner claim.

**Dormant is not safe — it is armed by Decision 4.** Seeding the corpus deprecations makes this
live in the same operation.

### RISK
Same class as D-7B and weaker on the merits: the concept transfer boring→turning is *not*
sound, whereas chassis-fitting→mechanical-assembly is.

### OPTIONS — presented, not selected
- **A.** Leave `skill_boring` unmapped / `[]` forever.
- **B.** Replace with a semantically justified match.
- **C.** Retire without a runtime replacement.

### RECOMMENDATION
None offered — the briefing asks for the options, and this is a product-semantics call about
what a worker's boring experience entitles them to claim. The engineering observation is only
this: **option B has no obvious target.** No `mskill_*` corresponds to boring, and
`mskill_cnc_turner` is the wrong one.

### OWNER DECISION: PENDING

---

## 8. DECISION 4 — D-7C: seed the four deprecated skills

### FACTS
Four skills drift between corpus and database. **This must not be executed before Decisions 2
and 3**, because seeding arms the dormant `skill_boring` crosswalk.

### MEASURED EVIDENCE — `pnpm db:seed:skills --plan`, non-mutating

```
new skills            = 0
changed skills        = 4      status (active -> deprecated) x4
crosswalk pointers    = 4
WARNING: a status change is planned and --preserve-existing-status is NOT set.
```

| skill | production now | corpus target | aliases | vectors | edges |
|---|---|---|---:|---:|---:|
| `skill_boring` | active, NULL | deprecated → `skill_turning` | 1 | 1 | 1 |
| `skill_cad_interpretation` | active, NULL | deprecated → `skill_drawing_reading` | 4 | 4 | 0 |
| `skill_dimensional_inspection` | active, NULL | deprecated → `skill_quality_control` | 3 | 3 | 2 |
| `skill_gdt_reading` | active, NULL | deprecated → `skill_drawing_reading` | 4 | 2 | 0 |
| **total** | | | **12** | **10** | **3** |

*(Distinct from the 3 edges on the two skills already deprecated in production — see §6.)*

**Expected retag behaviour after seeding:** the crosswalk set grows from 2 rows to 6.
`skill_gdt_reading`, `skill_cad_interpretation` and `skill_dimensional_inspection` are
**match-set neutral** (`[]`→`[]` and `quality_inspector`→`quality_inspector`).
**`skill_boring` becomes live and widening.**

### Mutation plan
- **Rollback** — capture `skill_id, status, replaced_by` for the four rows before the write;
  reversal is a four-row `UPDATE` back to `active` / `NULL`. Aliases and vectors are untouched
  by the status change, so nothing paid-for is at risk.
- **Validation** — after seeding: exactly 6 rows match the retag predicate; the 12 aliases and
  10 vectors are intact; the 3 edges now point at deprecated skills and are therefore inert to
  the live query (which filters `status='active'`); `db:audit:bridge-coverage` unchanged.
- **Ordering** — mandatory, never reversed:

```
Decision 2 (D-7B) + Decision 3 (D-7A)
        ↓
Decision 4 (seed)
        ↓
controlled mutation, guarded, with the before-state captured
        ↓
retag
        ↓
validation
```

### RISK
Executing out of order arms an undecided widening crosswalk in the same breath as a routine
corpus sync — the two changes would be indistinguishable in the diff.

### OPTIONS
- **A.** Seed all four after Decisions 2 and 3.
- **B.** Seed the three neutral ones, hold `skill_boring` back.
- **C.** Do not seed; retire the corpus deprecations instead.

### RECOMMENDATION
**A, strictly after 2 and 3.** **B** is available if those decisions stall and the drift needs
closing — it is safe precisely because the three are match-set neutral, which is measured
rather than assumed.

### OWNER DECISION: PENDING

---

## 9. DECISION 5 — Q1: the 96 promotable skills outside `SKILL_CORPUS`

### FACTS
`ATTRIBUTE_TO_MATCH_SKILLS` is the only bridge from an attribute skill to a posting-level
`mskill_*`. Its exhaustiveness test asserts the key set equals `SKILL_CORPUS` — 49
hand-authored seeds.

### MEASURED EVIDENCE
**STATIC / TESTED** — `pnpm db:audit:bridge-coverage`:

```
promotable skills                     96
├── in SKILL_CORPUS + mapped           0
├── in SKILL_CORPUS + intentional []   0
├── in SKILL_CORPUS + missing mapping  0
└── outside SKILL_CORPUS              96
```

Intersection with `SKILL_CORPUS`: **zero**. Promotion would make 96 skills `active`, reaching
nothing, **with no test failing** — the silence is the defect.

### The finding that reframes the triage effort
The 96 span **28 domains** in **10 trade families**. The 18 `mskill_*` are **17 industrial-
manufacturing (CNC / welding / fitting / quality) plus one delivery rider**.

| family | n | is there a plausible `mskill_*`? |
|---|---:|---|
| warehouse | 11 | **no** — no warehouse/forklift match skill exists |
| electrical | 11 | **no** — no electrician match skill exists |
| hvac | 10 | **no** |
| welding | 9 | **yes** — `mskill_mig/tig/arc_welder` |
| masonry | 9 | **no** |
| plumbing | 7 | partial — `mskill_plumber` exists |
| assembly (battery) | 7 | **no** |
| vehicle-mech | 7 | **no** |
| industrial maintenance | 6 | partial — `mskill_fitter` |
| sheet-metal | 3 | partial — `mskill_fitter` |
| other (machining attrs) | 16 | mostly deliberate `[]` territory |

> **INFERRED: for roughly two-thirds of the 96, "intentionally not matched" is the only correct
> answer today, because no target exists.** Q1 is therefore not 96 judgement calls between
> plausible options — it is a **`MATCH_SKILLS` coverage gap** with a mapping question attached.

### Where mapping would be unsafe
- **`Weld bead inspection`** → tempting `mskill_quality_inspector`; it is a welder's own check,
  not a claim to a QC chair. A textbook false friend.
- **`Electrode selection`** → welding-adjacent, but not evidence of being a MIG welder.
- **`Coolant management`, `Cutting tool selection`, `First piece approval`** → near-universal
  machining attributes; the bridge's existing doctrine keeps exactly these at `[]`.
- **`Forklift operation`** → no forklift match skill exists; mapping it anywhere would be
  invention.

### Where mapping looks obvious
Fewer than expected, and that is itself the finding. The welding family is the only one with a
clean home, and even there the mapping is to *a specific process* (`mig`/`tig`/`arc`), so
`Gas torch flame setting` and `Oxy-acetylene cylinder handling` still need a ruling rather than
a default.

### Proposed review format and effort
One row per skill: `skill_id · label · trade family · proposed mskill_* or [] · one-line
rationale`. Grouped by family so a reviewer rules on a coherent trade at a time rather than
context-switching 96 times. **Estimated effort: 3–5 hours** for a domain owner, most of it on
the ~34 skills in families where a target plausibly exists; the other ~62 are a fast
"no target exists → `[]`".

**Proposed approval mechanism:** the ratification-packet pattern already used for the 22 wedge
aliases — a committed markdown packet with a per-row ruling, a named owner and a date, and the
decision visible in the diff.

### RISK
Mapping eagerly is how an unrelated worker reaches a specialist vacancy. Mapping nothing leaves
96 active skills that reach nothing — honest, but it means promotion buys vocabulary and no
reach.

### OPTIONS
- **A.** Require a mapping or an explicit `[]` for every promotable skill before promotion, and
  extend the exhaustiveness test's universe accordingly.
- **B.** Promote without mappings; treat reach as a later phase.
- **C.** Expand `MATCH_SKILLS` first (electrician, mason, HVAC, warehouse, vehicle mechanic),
  then map.

### RECOMMENDATION
**A, informed by C.** A alone will produce ~62 rulings of "no target exists", which is honest
but leaves the reach gap intact; C is the work that would actually widen matching. Do A as the
gate and let its output scope C.

### OWNER DECISION: PENDING

---

## 10. DECISION 6 — the 0.75 canonicalization floor

### FACTS
`CANONICALIZATION_FLOOR = 0.75` governs the **assignment** decision: at or above, a phrase is
assigned an existing `skill_id`; below, it is recorded as an unresolved phrase.

### MEASURED EVIDENCE
```
precision  = 100%
recall     = 74.2%
assigned   = 66.5%
separable  = false

lowest correct  = 0.5986
highest wrong   = 0.7216
```

**No threshold on this corpus separates correct from incorrect.** The bands overlap by
construction, and the vernacular evidence makes it starker — correct single-word trade terms
interleave with nonsense:

```
correct   chhilai 0.5284   ghisai 0.5352   kharad 0.5750
negative  biryani banana 0.5427   computer typing 0.5722
```

`chhilai` is the **correct** answer and scores **below** `biryani banana`.

### The decision is product-level, not tuning
The floor trades two failures that are not equivalent:

| | **FALSE ASSIGNMENT** (floor too low) | **FALSE UNRESOLVED** (floor too high) |
|---|---|---|
| what happens | a worker is credited with a skill they did not claim | a real skill is dropped; the phrase enters the growth queue |
| who sees it | the employer — an irrelevant candidate | nobody immediately; the worker's profile is thinner |
| recoverable? | only by noticing a bad match | **yes** — the growth loop is designed to re-surface it |
| product cost | trust in the shortlist | coverage, and a slower corpus |

**INFERRED** — the current setting expresses a preference for false-unresolved over
false-assignment, and the measured `precision = 100%` shows it is achieving exactly that. The
D-6 evidence removes the most common argument for lowering it: **the below-floor population is
not disproportionately vernacular**, so lowering would not buy Hindi coverage — it would buy
false assignments in both languages.

### RISK
Lowering to catch `chhilai` at 0.5284 also admits `biryani banana` at 0.5427. There is no
setting that gets one without the other; the corpus must change, not the number.

### OPTIONS
- **A.** Keep 0.75. Accept 74.2% recall; close the gap by adding aliases (Decision 1).
- **B.** Lower it. Buys recall, **loses the 100% precision**, in both languages.
- **C.** Two-tier: assign above 0.75, and hold a review band below it rather than discarding.

### RECOMMENDATION
**A**, and note that **C** is the only option that improves coverage without trading precision
— at the cost of building a review surface that does not exist today. **B** is not supported by
any measurement in this programme.

### OWNER DECISION: PENDING

---

## 11. DECISION 7 — `NO_REGRESSION` semantics

### FACTS
`REGRESSION_BASELINE = { recall_at_1: 1.0, mrr: 1.0, evaluator_version: 2, fixture_version: 2 }`.
`judgeRegression` rejects on **fixture-version mismatch before comparing scores**, and passes
only on `recall >= 1.0 && mrr >= 1.0` with no epsilon.

### MEASURED EVIDENCE
The gate fails for **two independent reasons**, and either alone is sufficient:

1. **Fixture-version mismatch** — the evaluation ran on v3; the baseline is v2. Rejected before
   any score is read.
2. **Scores below baseline** — v3 measured `recall@1 = 0.9675`, `MRR = 0.9816`, against a
   baseline demanding 1.0 for both.

**TESTED** — `no-regression-v3-conflict.test.ts` pins both failure modes, so a silent
re-pointing of the baseline breaks a test.

### The real tension
The baseline was set on a 127-case fixture that the corpus had effectively memorised (`R@1 = 1.0`).
v3 added 41 reviewed trainer phrases covering skills the old fixture never named. **The score
fell because the fixture got harder and more representative, not because retrieval regressed.**

A perfect-score baseline is only sustainable while the fixture stays easy — which is the
opposite of what an evaluation corpus should do.

### OPTIONS

| | option | regression protection | fixture evolution | historical comparability |
|---|---|---|---|---|
| **A** | keep v2 baseline, keep failing | strongest | **blocked** — any new coverage fails the gate | preserved |
| **B** | re-baseline to v3's measured scores | weakened — bakes in today's misses as acceptable | unblocked | **broken** — v2 and v3 numbers stop being comparable |
| **C** | version the baseline: keep v2's for v2, record v3's separately, compare **within** a fixture version | preserved per version | unblocked | preserved, explicitly per-version |
| **D** | split the gate: "no regression on the v2 subset" + "coverage floor on new cases" | strongest where it matters | unblocked | preserved — v2 cases still judged against 1.0 |

### RISK
**B** is the tempting one and the dangerous one: it makes the gate green by redefining success
as whatever was measured last, which is the failure mode this programme has repeatedly refused.

### RECOMMENDATION
**D**, with **C** as the simpler fallback. v3 contains v2's 127 cases **unchanged**, so the
v2 subset can still be judged against `1.0` with no loss of protection, while the 41 new cases
get a coverage criterion appropriate to their purpose. Nothing is re-pointed and nothing is
weakened.

### OWNER DECISION: PENDING

---

## 12. DECISION 8 — D6-1: who authors the vernacular fixture

### FACTS
The gate-bearing fixture has **0 romanized-Hindi cases** out of 168 — measured, and **TESTED**
by `vernacular-coverage.test.ts` which pins the zero. Code-switching and spelling variation are
likewise absent from both instruments.

### MEASURED EVIDENCE
`db:mine:aliases` — the report-only runner designed to source real worker language from chat —
**has effectively nothing to mine**: `workers` = 1, `worker_profiles` = 1, `worker_skill` = 0
after the 2026-08-21 deletion.

**The precedent that rules out the obvious shortcut:** TP-36 and TP-19 were machine-plausible
paraphrases that named a *sibling* skill's identity. They retrieved the sibling at 0.7216 and
0.6923 — author errors, not retrieval errors, and unmeasurable as test cases. A phrase naming a
sibling's identity has no correct answer for retrieval to find.

### PATH A — human-authored controlled fixture
- **Quality:** high per case. A speaker of the register writes what a worker would actually say.
- **Reliability:** the phrases are *plausible*, not *observed*. A fixture author imagines the
  worker; a real worker surprises you.
- **Cost:** human time, roughly 3–5 cases × 4 categories × the domains that matter.
- **Available:** now.
- **Hazard:** the TP-36 class of error, mitigated but not eliminated by
  `siblingLexicalLeaks` — which now runs over every case, not just the trainer pack.

### PATH B — wait for real worker traffic
- **Quality:** highest possible. Observed language, with real frequency and real noise.
- **Reliability:** it is ground truth by definition.
- **Cost:** zero authoring; requires traffic and a mining + review pass.
- **Available:** **not today** — and there is no date, because the worker tables were cleared.
- **Hazard:** indefinite delay, and the growth loop stays unmeasured meanwhile.

### The difference that matters
Path A measures **whether retrieval handles the register we imagine**. Path B measures
**whether it handles the register that exists**. They are not substitutes: A can pass while B
fails, and that gap is invisible until B runs.

### RISK
An agent-authored fixture is Path A with the *lowest* reliability variant — I would be
imagining the worker at one further remove, and TP-36/TP-19 is what that produced last time.
**I have not authored one and recommend against my doing so.**

### OPTIONS
- **A.** Human-authored controlled fixture now.
- **B.** Wait for worker traffic.
- **C.** A now, re-validated against B when traffic returns.

### RECOMMENDATION
None selected, per the briefing. The engineering observation: **C costs almost nothing extra**
— a Path A fixture is not wasted when Path B arrives, because the instrument already segments
`by_category` and the two can be compared directly.

### OWNER DECISION: PENDING

---

## 13. Infrastructure — Supabase pooler

**Status: INTERMITTENT INFRASTRUCTURE BLOCKER. Not fixed.**

### Observed
```
error   (EMAXCONNSESSION) max clients reached in session mode
        max clients are limited to pool_size: 15
```

| date | observation |
|---|---|
| 2026-08-21 | blocked read-only verification **eight times** across the session, in bursts separated by successful windows |
| 2026-08-21 | four consecutive attempts over ~15 minutes on the D-5 artifact — abandoned per the retry policy |
| 2026-08-24 | **responsive** — the D-5 artifact, the D-7 seed plan and three forensic probes all completed |

**pool_size: 15**, session mode.

### Impact
It is the binding constraint on every measurement task. Each block cost a task its database
half; the D-5 artifact was owed for three days purely because of it. It does **not** affect
repository-only work, which is why D-6 was unaffected.

Two consequences worth naming:
- Work was **reordered around it** — the static half of a task first, database half opportunistically.
- It produced a false signal once: I recorded D-5's measurement as blocked when the data was
  already captured, because the artifact could not be written.

### What was NOT done
No configuration was changed. No pool size, no Supabase settings, no connection limits, no
application pooling. Every runner already uses `max: 1`.

### Recommendation for owner / infrastructure review
- Establish whether the saturation is BadaBhai's own connections or shared-tenant pressure.
- If it is ours, the candidates are the API's pool sizing and any long-lived sessions — not the
  audit scripts, which take one connection each and close it.
- Consider a dedicated read-only path for verification work so measurement cannot be starved by
  application traffic.

**Not called fixed. It was quiet on one day.**

### OWNER DECISION: PENDING

---

## 14. Recommended sequencing after owner decisions

Ordering is load-bearing in two places — marked ⚠.

```
1.  Decision 1  D6-0 ship 22 aliases          independent, ≈₹0.002, reversible
2.  Decision 2  D-7B chassis_fitting ruling   ⚠ before any db:retag:skills
3.  Decision 3  D-7A boring ruling            ⚠ before any db:seed:skills
4.  Decision 4  D-7C seed the four            only after 2 AND 3
5.              controlled retag              only after 4, with before-state captured
6.  Decision 7  NO_REGRESSION architecture    unblocks fixture evolution
7.  Decision 5  Q1 bridge triage              gates promotion; ~3-5h owner effort
8.  Decision 6  0.75 floor                    can run in parallel with 6-7
9.  Decision 8  D6-1 fixture path             feeds a later re-measurement
10.             re-evaluate promotion readiness
```

Items 1, 6, 7, 8 and 9 are mutually independent. Items 2→5 are a strict chain.

## 15. Promotion status

> **PROMOTION REMAINS BLOCKED. 0 candidates.**

`RESOLVABLE_ABOVE_FLOOR` FAIL (62/96) and `NO_REGRESSION` FAIL, both under existing semantics,
neither touched. Promotion stays prohibited until every relevant gate passes **under those
semantics** — not by re-pointing a baseline, moving a floor, or waiving a criterion.

Q1 (§9) is a separate and equally binding precondition: promoting 96 skills that reach nothing
would satisfy the gates and still deliver no matching value.

---

## Tripwires — preserve all nine

Each fails if a finding silently changes. They are evidence architecture, not tests of code.

| # | tripwire | protects |
|---|---|---|
| 1 | `materialize-inheritance.test.ts` | the dry-run's **absent** write path — capability, not a flag |
| 2 | `isco-inheritance.test.ts` | downward-only inheritance, no cascade, one-pass convergence |
| 3 | `audit-runtime-bridge-coverage.test.ts` | 96/96 promotable skills outside `SKILL_CORPUS` |
| 4 | `junk-label-classifier.test.ts` | a coded occupation can never be classified disposable |
| 5 | `audit-junk-domain-labels` classifier | cross-domain alias collisions outrank good shape |
| 6 | `vernacular-coverage.test.ts` | zero romanized-Hindi coverage in the gate-bearing fixture |
| 7 | `wedge-alias-delivery.test.ts` | the 22 ratified aliases remain undelivered |
| 8 | `crosswalk-integrity-corpus.test.ts` | exactly two widening crosswalks, pinned by name |
| 9 | `evidence-provenance.test.ts` | every committed artifact says when it was true |

Several are pinned **two-way**: fixing the finding also fails the test, in the commit that
earns the change. That is intentional — it makes a resolution deliberate rather than silent.
