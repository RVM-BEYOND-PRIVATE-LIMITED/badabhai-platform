# §5a-2 — the sibling margin, measured. No option chosen.

**Prepared against main `561de152` · measured 2026-08-26 · read-only**
**Production mutation: NONE · AI spend: ₹0 · no threshold moved, no policy implemented**

Reproduce: `pnpm db:audit:sibling-margin --json=<out>`
Artifact: [`5a2-sibling-margin.json`](./5a2-sibling-margin.json) · Tests: `sibling-margin.test.ts` (26)

> **STATUS: THE DECISION IS NOW ARITHMETIC, NOT PREFERENCE.**
> Option B cannot work at any usable value. Option C misses the pair that motivated it. That
> narrows the question sharply and **does not answer it** — accepting a margin is still a
> product judgement about 7 named pairs. **OWNER DECISION: PENDING.**

---

## What changed about the measurement

§5a scored each alias against a pool that **still contained the alias itself**, so the top-1 was
always the probe at 1.0000 and the sibling figure was a runner-up. That is the right way to
measure a *ceiling* and the wrong way to measure a *decision*: no resolution ever happens with
the query already in the index.

This is **leave-one-out**. Each probe's own row is removed from the candidate pool; everything
else stays, **including the probe's other aliases**. That is a real retrieval — *"a worker said a
phrase we happen to know; can the rest of the corpus still find the right skill, and by how
much?"*

**Still a proxy, and a favourable one.** These are corpus phrases, not worker paraphrases. A
held-out alias is closer to its own skill's remaining aliases than a real paraphrase would be, so
**the wrong-answer count below is a lower bound.**

Two probes are `UNMEASURABLE`: their skill has exactly one alias, so leave-one-out leaves it
unrepresented. Scoring those as misses would report a retrieval defect where there is only a thin
corpus.

---

## The uncomfortable number, first

```
probes 106 · unmeasurable 2 · measurable 104

correct above the floor    43   (41.3%)
WRONG above the floor      15   (14.4%)
below the floor            46
```

**46 of 104 corpus phrases do not clear 0.75 without themselves in the index.** That is not the
sibling question and it belongs on the record anyway — it is the same shape as
`RESOLVABLE_ABOVE_FLOOR`, measured a different way.

Of the 15 wrong answers, **8 are duplicate text** — the runner-up carries the *same* phrase, so
the vectors are identical and the score is exactly 1.0000. No floor and no separation can
arbitrate that; those belong to the D-7C-1 cleanup, which drives them to zero. **7 are genuine.**

Every figure below is reported twice for exactly that reason: leaving the duplicates in would let
the cleanup's removals read as a margin policy working.

---

## Option B — a minimum separation. Answered by arithmetic.

### The two distributions overlap

| margin \|own − other\| | n | min | p50 | max |
|---|---:|---:|---:|---:|
| top-1 **correct** | 43 | **0.0000** | 0.1331 | 1.8743 |
| top-1 **wrong** | 15 | 0.0260 | 0.1505 | **0.2708** |

Some right answers are **closer** to their runner-up than some wrong ones are. **No single
separation orders them apart** — the same shape the 0.75 floor already has for single-word
vernacular, where `chhilai` (correct, 0.5284) sits below `biryani banana` (wrong, 0.5427).

### The sweep, with the trade shown

Duplicates removed — the post-cleanup world:

| δ | correct | wrong | unresolved | **right LOST** | **wrong REJECTED** |
|---:|---:|---:|---:|---:|---:|
| 0.000 | 43 | 7 | 46 | 0 | 0 |
| 0.005 | 40 | 7 | 49 | **3** | **0** |
| 0.030 | 39 | 6 | 51 | 4 | 1 |
| 0.075 | 30 | 4 | 62 | 13 | 3 |
| 0.100 | 28 | 2 | 66 | 15 | 5 |
| **0.150** | 17 | **0** | 79 | **26** | 7 |

**δ = 0.15 is the smallest value that eliminates every wrong answer, and it destroys 26 of 43
correct resolutions to reject 7 wrong ones — roughly four right answers per wrong one.** Even
δ = 0.005, the smallest step measured, already costs 3 right answers and rejects **none**.

With duplicates still present, **no swept value works at all**.

> A separation rule is not cheap-but-imperfect here. It is expensive **and** imperfect, and the
> sweep is the evidence rather than an opinion about it.

---

## Option C — a lexical disambiguation group

The mechanical form of "lexically close" is *do the two phrases share a content token* (stopwords
`ka`/`kaam`/`karna`/`se` dropped, or every Hinglish alias groups with every other).

Over the 15 genuine above-floor pairs: **caught 10, missed 5.**

```
MISSED:  GMAW / SMAW          <- 0.8405, the worst pair
         SMAW / GMAW
         GTAW / GMAW          <- 0.8355
         drilling / boring    <- 0.7556, the D-7A pair
         read engineering drawings / blueprint reading
```

**The rule cannot see acronyms, and acronyms are the finding.** `TIG welding`/`MIG welding` share
a word and are caught; `GMAW`/`SMAW` share nothing and are the highest-scoring collision in the
corpus. A rule that misses its own headline case is worth knowing about before anyone adopts it.

This does not kill option C — a hand-curated group would catch them. It relocates the cost: the
group becomes a **maintained list**, not a rule, and something has to keep it current as the
corpus grows.

---

## The 7 genuine pairs, in full

| score | margin | phrase | wanted | got |
|---:|---:|---|---|---|
| 0.8405 | 0.0748 | `GMAW` | MIG welding | arc welding |
| 0.8405 | 0.1026 | `SMAW` | arc welding | MIG welding |
| 0.8355 | 0.0613 | `GTAW` | TIG welding | MIG welding |
| 0.8219 | 0.1234 | `quality check` | dimensional inspection | quality control |
| 0.8219 | 0.0923 | `quality check karna` | quality control | dimensional inspection |
| 0.8083 | 0.0755 | `quality control` | quality control | dimensional inspection |
| 0.8002 | 0.0260 | `TIG welding` | TIG welding | MIG welding |

Two families. **Welding-process acronyms** — GMAW *is* MIG, SMAW *is* stick/arc, GTAW *is* TIG:
different machines, different tickets, and the confusion is an artifact of acronym shape.
**The quality-check family** — three of these disappear when D-7C deprecates
`skill_dimensional_inspection`, which is a decision already approved in principle.

So after the cleanup **and** the D-7C seed, the population is **four welding acronyms**. That is
the actual size of §5a-2.

---

## What this does and does not settle

**Settled by measurement:**

- Option B costs about four right answers per wrong one at the only value that works, and does
  not work at all until the duplicates are cleaned up.
- Option C's simple form misses the worst pair; its workable form is a maintained list.
- The population is 7 pairs now and **4** after decisions already approved.

**Not settled, and not for an agent:** whether four welding-acronym pairs at 0.80–0.84 inside the
correct domain are an acceptable risk once canonicalization is on. That depends on what a wrong
weld-process assignment costs a worker, which is a product question.

> **OWNER DECISION §5a-2 — the sibling margin. STILL PENDING.**
> **A** accept the margin · **B** minimum separation · **C** disambiguation group.
> **MEASURED:** B costs 26 of 43 right answers at δ=0.15, its first working value. C's simple
> form misses GMAW/SMAW at 0.8405. A leaves 4 welding-acronym pairs after the approved cleanup
> and seed.
> **RECOMMENDATION:** none on the product question. On evidence: **B is the option the numbers
> argue against**, and the choice is genuinely between A and a curated form of C.

---

## Nothing was implemented

`separation` exists only inside this audit process. No runner, service or config reads it;
`config.py` is untouched and still pins `skill_canonicalize_floor = 0.75`. A test greps the
runtime config for `separation|min_margin|margin_floor` and asserts it finds nothing.

## Gates

```
MATCH_VOCABULARY          PASS — 0 of 96 missing a disposition
RESOLVABLE_ABOVE_FLOOR    FAIL — 34 of 96 blocked
NO_REGRESSION             FAIL — 96 of 96 blocked
EVAL_COVERED              PASS under fixture v3
PROMOTION CANDIDATES      96, eligible 0
```

**PROMOTION BLOCKED · CANONICALIZATION BLOCKED.**


---

## OWNER RULING — 2026-08-26: **OPTION A, accept the margin**

**Ruled:** accept the margin as measured. **Do not lower the 0.75 floor. Do not weaken the
existing safety gate. Preserve the measured evidence and the tripwires.**

**What this changes in the repository: nothing, and that is the ruling.** No minimum-separation
rule, no disambiguation group, no `separation` value anywhere a runner can read. The test that
greps the runtime config for `separation|min_margin|margin_floor` and asserts it finds nothing
**stays**, and its meaning changes: it used to guard the absence of a decision, and now guards
the decision itself.

**Why the evidence supported it.** Option B costs **26 of 43 right answers** at δ=0.15, its first
working value — about four right answers surrendered per wrong one rejected. Option C's simple
form misses the worst pair, GMAW/SMAW at 0.8405, and its workable form is a maintained list.
Neither buys enough to pay for itself at this corpus size.

**The residual risk, stated rather than closed.** Four welding-acronym pairs at 0.80–0.84 sit
inside the correct domain after the approved cleanup and seed: `GMAW`/`SMAW`, `GTAW`,
`TIG welding`/`MIG welding`, `arc welding`/`stick welding`. A wrong weld-process assignment is
a real cost to a worker and this ruling accepts it **while canonicalization is off**. Activation
step 8 (`OBSERVE`) re-measures the three ceilings against the promoted corpus before the flag
moves, and a ceiling that rises above its pre-promotion value is a reason to stop.

`5a-2` is now **COMPLETE** in the programme graph.
