# D-7C-1 — what the duplicate-text cleanup would actually change

**Prepared against main `daa8d8b2` · measured 2026-08-26 · read-only**
**Production mutation: NONE · AI spend: ₹0 · no alias nulled, no skill deprecated, nothing enabled**

Reproduce: `pnpm db:audit:alias-cleanup [--plan] --json=<out>`
Artifact: [`d7c1-alias-collision-cleanup.json`](./d7c1-alias-collision-cleanup.json)
Proposal (wired into nothing): `packages/db/data/taxonomy/proposed-d7c1-cleanup.json`

> **STATUS: COMPLETE. The cleanup is necessary and it fixes none of what it was credited with.**
> Two owner decisions fall out of it, one of them a conflict between two decisions already
> ratified.

---

## The headline, before the detail

| claim | verdict |
|---|---|
| The cleanup removes the nondeterministic assignments | **TRUE** — 19 duplicate rows → 0 |
| It fixes the `dimensional inspection` collision (§5a §F step 1) | **FALSE** — it relocates it at the identical score |
| It lowers the anchor-path ceiling | **FALSE** — 0.7760 before and after |
| It lowers the sibling ceiling | **FALSE** — 0.8405 before and after |
| It is free | **FALSE** — four phrases leave the `cnc-programming` slug |
| It is safe to apply alongside the D-7C seed | **FALSE** — together they orphan two phrases |

**Nothing here argues against doing the cleanup.** A nondeterministic assignment between a live
skill and a corpus-deprecated one is a defect on its own terms, and no threshold can arbitrate a
tie at 1.0000. The point is narrower and matters more: **it buys determinism, not floor safety**,
and §5a's remediation order implied otherwise.

---

## How this was measured at ₹0

The de-election write is exactly `UPDATE skill_alias SET embedding = NULL WHERE id = $1`, and
every retrieval predicate in the system filters `embedding IS NOT NULL`. So the post-write corpus
is the pre-write corpus **minus those rows** — which `WHERE id <> ALL(...)` reproduces exactly, in
a read-only session, over vectors that already exist.

The same is true of a deprecation: retrieval admits a candidate on
`s.status = 'active' AND sa.embedding IS NOT NULL`, and deprecating a skill fails the first
conjunct just as NULLing a vector fails the second. **Both decisions can therefore be simulated on
one surface, exactly rather than approximately — and that is also why they can silently combine.**

Four scenarios:

| | what it models |
|---|---|
| **S0** | production as it stands |
| **S1** | the 4 elections ratified 2026-08-21 — **authorised and still unapplied** |
| **S2** | S1 plus the 4 proposed D-7C-1 elections — **not authorised** |
| **S3** | S2 plus the D-7C seed deprecating its three subjects |

S1 is separate on purpose: an authorised write that is merely owed must not be reported in the
same breath as one nobody has approved.

---

## A. The rows, which are not the phrases

§5a counted **eight phrases** from the probe side. From the row side there are **nine groups**,
and the ninth is the interesting one.

| group | today | after all elections | holders |
|---|---|---|---|
| `blueprint reading` | UNDECIDED | DECIDED_COMPLETE | drawing_reading / gdt_reading |
| `drawing reading` | UNDECIDED | DECIDED_COMPLETE | drawing_reading / gdt_reading |
| `gd&t` | UNDECIDED | DECIDED_COMPLETE | drawing_reading / gdt_reading |
| `geometric dimensioning and tolerancing` | UNDECIDED | DECIDED_COMPLETE | drawing_reading / gdt_reading |
| `cad` | UNDECIDED | DECIDED_COMPLETE | cad_interpretation / drawing_reading |
| `drawing padhna` | UNDECIDED | DECIDED_COMPLETE | cad_interpretation / drawing_reading |
| `read engineering drawings` | UNDECIDED | DECIDED_COMPLETE | cad_interpretation / drawing_reading |
| `technical drawing` | UNDECIDED | DECIDED_COMPLETE | cad_interpretation / drawing_reading |
| **`finishing`** | **LATENT** | **LATENT** | deburring / **furniture_finishing (provisional)** |

`finishing` is held by `skill_deburring` and by `skill_furniture_finishing`, which is
**provisional**. §5a filters `status = 'active'`, so this pair was invisible to it — and
**promotion is all it takes to arm.** It is not in the 96-skill batch, so nothing imminent turns
it on; nothing prevents it either. Two different trades (deburring a machined edge, finishing
furniture) would become a coin flip.

That is the general shape worth keeping: **a duplicate whose partner is provisional is not an
absent defect, it is a scheduled one.** `classifyDuplicateGroup` reports it as `LATENT` rather
than as clean, and a test asserts promotion flips exactly those rows to `UNDECIDED`.

---

## B. What it costs — scope orphaning

Global orphans: **0.** Every contested text keeps a holder. That check is not sufficient.

Path B filters `sa.domain_id = $1`, so **each legacy slug is its own retrieval universe.** The
four proposed elections all remove `skill_cad_interpretation` rows from `cnc-programming`, and the
surviving copies live on `skill_drawing_reading` in `cnc-machining` — a different universe:

```
cad @ cnc-programming
drawing padhna @ cnc-programming
read engineering drawings @ cnc-programming
technical drawing @ cnc-programming
```

Alive globally, gone from the slug a caller queries. This is a **cost of the election, not a
defect in it**, and it disappears once per-label resolution (TAX-6) replaces slug-scoped
retrieval. It is stated because a reader looking only at the global check would conclude the
cleanup is free, and `drawing padhna` is one of the 22 ratified vernacular aliases.

---

## C. It does not fix `dimensional inspection`

§5a §F step 1 said the cleanup "removes the 8 duplicate-text pairs *and* the
`dimensional inspection` collision, which shares a cause." **Measured, that is wrong.**

| scenario | `dimensional inspection` resolves to | score | via |
|---|---|---:|---|
| S0 today | `skill_drawing_reading` | 0.7570 | *"geometric dimensioning and tolerancing"* |
| S2 after full cleanup | **`skill_gdt_reading`** | **0.7570** | *"geometric dimensioning and tolerancing"* |

The election moves the winning phrase from one skill to another. **The phrase itself survives by
design — that is what an election means** — so the vector is the same, the score is the same to
four places, and the only thing that changes is which skill the misassignment lands on. Both are
D-7C subjects.

The cause is not merge residue. It is **semantic**: *"dimensional inspection"* sits 0.7570 from
*"geometric dimensioning and tolerancing"*, and 0.75 does not separate them. The two phrases live
in different slugs (`metrology-quality` and `cnc-machining`), so **per-label resolution does reach
this one** — the labeled-domain above-floor count is 0 in every scenario. The alias cleanup does
not.

---

## D. The ceilings do not move

```
scenario                       anchor  labeled  sibling    above-floor a/l/s  dup-rows
S0_TODAY                       0.7760   0.0000   0.8405               3/0/16        19
S1_RATIFIED_APPLIED            0.7760   0.0000   0.8405               3/0/14         4
S2_RATIFIED_PLUS_PROPOSED      0.7760   0.0000   0.8405               3/0/14         0
S3_PLUS_D7C_DEPRECATION        0.7760   0.0000   0.8405               2/0/11         0
```

Read the columns separately. **`dup-rows` is what the cleanup is for**, and it goes to zero — the
four ratified elections alone clear 15 of the 19. **The three ceilings are what it does not
touch**, at any point, in any scenario.

Attributing the sibling reductions to the decision that causes them:

| cleared by | count | which |
|---|---:|---|
| the alias cleanup | 2 | `drawing padhna`, `read engineering drawings` (both 0.7985, drawing-family) |
| the D-7C seed | 3 | `quality check`, `quality check karna`, `quality control` (0.8083–0.8219) |
| **remaining** | **11** | — |

Crediting the cleanup with all five would be wrong: the three quality-family pairs vanish only
because D-7C deprecates `skill_dimensional_inspection`, which is a different decision under a
different authorisation.

---

## E. The cross-decision conflict — the finding that changes sequencing

**Two decisions, each already ratified, each safe alone. Applied together they delete two phrases
from retrieval.**

- The **2026-08-21 election** hands `GD&T` and `geometric dimensioning and tolerancing` to
  `skill_gdt_reading`, and NULLs `skill_drawing_reading`'s copies.
- The **D-7C seed** deprecates `skill_gdt_reading`.

After both, neither phrase has a live holder anywhere:

```
orphaned once D-7C also seeds:  gd&t
                                geometric dimensioning and tolerancing
```

The winner named in the ratified exclusions file is precisely a skill the other decision retires,
and neither file mentions the other. **Ordering is not a fix** — the end state is identical
whichever runs first. A test asserts the overlap so it cannot re-open silently.

> **OWNER DECISION §D-7C-1a — who keeps GD&T after the seed.**
> **FACTS.** Two ratified decisions overlap on two phrases. Applying both removes
> `GD&T` and `geometric dimensioning and tolerancing` from retrieval entirely.
> **MEASURED.** `orphaned_if_d7c_also_seeds` = those two, from live rows, not from the files.
> **OPTIONS.** **A** — re-point the two exclusions so `skill_drawing_reading` keeps both, making
> the election agree with the corpus successor. **B** — drop `skill_gdt_reading` from the D-7C
> seed set, as `skill_boring` already is. **C** — apply both and accept losing the phrases.
> **RECOMMENDATION.** None on the product question. On evidence: **C is the only option that
> loses vocabulary**, and the loss is silent — no gate, test or runner currently detects it.
> **OWNER DECISION: PENDING.**

> **OWNER DECISION §D-7C-1b — the four proposed elections.**
> **FACTS.** `CAD`, `drawing padhna`, `read engineering drawings` and `technical drawing` are on
> both `skill_cad_interpretation` and its named successor `skill_drawing_reading`, at 1.0000.
> **MEASURED.** Electing the successor clears the last 4 duplicate rows, moves no ceiling, and
> costs four phrases in the `cnc-programming` slug.
> **OPTIONS.** **A** — ratify as proposed (successor keeps the text). **B** — elect the source
> instead. **C** — leave the tie in place until TAX-6 makes the slug question moot.
> **RECOMMENDATION.** None. The corpus already names the successor, so **A** is the reading
> consistent with the ratified crosswalk — but it is still an election, and elections have a
> reviewer. **OWNER DECISION: PENDING.**

---

## F. What survives every corpus decision on the table

11 above-floor sibling pairs, in **three lexical families** — this is §5a-2's exact population,
now enumerated:

| score | phrase | own skill | nearest sibling |
|---:|---|---|---|
| 0.8405 | `GMAW` / `SMAW` | MIG / arc welding | each other |
| 0.8355 | `GTAW` | TIG welding | MIG welding |
| 0.8002 | `TIG welding` / `MIG welding` | — | each other |
| 0.7864 | `arc welding` | arc welding | TIG welding |
| 0.7650 | `Fanuc controller` / `Mitsubishi controller` | — | each other |
| 0.7556 | `boring` / `drilling` | — | each other |
| 0.7501 | `stick welding` | arc welding | MIG welding |

Seven welding-process names, two controller brands, two hole-making operations. **None is a
scoping defect and none is merge residue** — they are lexically close names for genuinely
different work, inside the correct domain. No decision in the current plan reduces this set.

---

## What did NOT change

`SKILL_CANONICALIZE_ENABLED` (false) · the 0.75 floor · `NO_REGRESSION` · the regression baseline
· every alias row, vector, slug and domain · `decollided-aliases.json` (still exactly 4 entries,
asserted) · `MATCH_SKILLS` · the bridge · promotion status · D-7A · D-7B · the D-7C seed set.

## Gates

```
MATCH_VOCABULARY          PASS — 0/96       unchanged
RESOLVABLE_ABOVE_FLOOR    FAIL — 62/96      unchanged
NO_REGRESSION             FAIL — 96/96      unchanged
EVAL_COVERED              FAIL — 41/96      unchanged
PROMOTION CANDIDATES      96, eligible 0    unchanged
```

**PROMOTION BLOCKED · CANONICALIZATION BLOCKED.**


---

## OWNER RULING — 2026-08-26: **§D-7C-1a OPTION A · §D-7C-1b OPTION A**

Both decisions ruled the same way, and the two readings agree: **the holder that survives keeps
the text.**

### §D-7C-1a — option A, applied

The two exclusions were **re-pointed**, not added to. Before, they excluded
`skill_drawing_reading`'s copies so that `skill_gdt_reading` kept `GD&T` and
`geometric dimensioning and tolerancing` — and D-7C deprecates `skill_gdt_reading`, so applying
both ratified decisions removed the two phrases from retrieval entirely, silently, with no gate
detecting it.

| | before | after |
|---|---|---|
| `GD&T` | exclude `60913ff3…` on `skill_drawing_reading` | exclude `ff0e1497…` on `skill_gdt_reading` |
| `geometric dimensioning and tolerancing` | exclude `b6cf46a9…` on `skill_drawing_reading` | exclude `046812dd…` on `skill_gdt_reading` |
| winner | `skill_gdt_reading` — a deprecation subject | `skill_drawing_reading` — survives the seed |

**The competency judgement of 2026-08-21 is untouched.** GD&T is still a distinct, narrower
competency; what changed is which *row* carries the text, because the other row is about to go
dark. Each re-pointed entry records its own `repointed_2026_08_26` block naming the id it
replaced and why, so the original decision stays legible.

**Verified against live rows, dry run, ₹0:** `db:seed:deprecations --plan` now reports
`cross-decision orphans: 0` (was 2) and its preconditions **PASS**. The precondition itself was
not relaxed — it still reads live rows and still counts ratified-but-unapplied elections as
applied.

**The tripwire was inverted, not deleted.** `alias-cleanup-plan.test.ts` used to assert that a
winner named in the ratified file *is* a D-7C subject, pinning the defect. It now asserts that
**no** winner is one — for any subject, not just this one — so re-pointing either exclusion back,
or adding a new election that hands a text to a doomed holder, fails the suite.

### §D-7C-1b — option A, applied

`CAD`, `drawing padhna`, `read engineering drawings` and `technical drawing` go to
`skill_drawing_reading`, the successor the ratified crosswalk already names.

The four rows were **moved** into `decollided-aliases.json` and `proposed-d7c1-cleanup.json` was
**deleted**. That is what ratification means in this design: `parseCleanupProposal` refuses a
file marked `RATIFIED` in place precisely so a second, unread source of truth cannot exist, and
`loadCleanupProposal` degrades to `[]` when the file is absent.

**The stated cost stands and was not re-litigated.** The `cnc-programming` slug loses those four
phrases — `skill_drawing_reading`'s copies live in `cnc-machining` — until TAX-6 replaces
slug-scoped retrieval. That is a cost of the election, not a defect in it.

**`drawing padhna` is one of the 22 vernacular aliases ratified 2026-07-16**, so its surviving
copy was verified before the file was written: `794cc831-ccf7-5f32-8fa4-dfb7ab2585b2`, lang `hi`,
embedded, on `skill_drawing_reading`. The ratified vernacular term survives the election.

### State after the ruling

```
decollided-aliases.json     8 exclusions   (2 from 08-21, 2 re-pointed, 4 moved)
proposed-d7c1-cleanup.json  deleted
cross-decision orphans      0              (was 2)
seeder preconditions        PASS           (was REFUSED)
ceilings                    unmoved        — the cleanup buys determinism, not floor safety
```

Both `D-7C-1a` and `D-7C-1b` are now **COMPLETE** in the programme graph. Neither write has been
executed: applying the elections is activation step 3 and seeding is step 4, both production
mutations behind the two ops-guard signals.
