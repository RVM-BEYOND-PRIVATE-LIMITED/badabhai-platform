# Trainer & product worksheet — TD-01 slots and TD-07

> **For a trade trainer and a product owner. No engineering knowledge needed.**
> Nothing here is a draft answer. Every blank is blank because a plausible-looking answer
> written by the same process that scores it would measure nothing — see DC-18 below.
>
> Generated from `packages/db/data/taxonomy/eval/review-pack/td01-drawing-reading-trainer-pack.json`
> plus the production database (read-only, 2026-08-19). The pack is the machine-readable
> original; this file exists because the pack identifies domains as `jd_nco_7223_0701`, which
> nobody can answer questions about.

---

## Why the blanks are blank

**DC-18** is the standing example in this repository. A test case read as a model failure for
two entire phases before anyone noticed the case itself was wrong — the "correct answer" it
asserted was one person's opinion, written by the same pipeline that then measured against it.

So: if engineering invents how a lathe machinist describes reading a drawing, and then measures
whether the system finds that phrase, the measurement is circular. It proves the phrase matches
itself. **The only phrasings worth measuring are ones a person who does the trade supplied.**

The cases that DO carry a query are marked `mechanical`. Their query is the skill's own alias —
tautologically correct, weak by construction, present only to prove the skill is reachable at
all. **They must never be promoted to recall evidence.**

---

# Part 1 — TD-01: five empty slots

## The skill

**Drawing reading (GD&T / technical drawing)** — `skill_drawing_reading`

It already answers to these phrases. **Do not reuse any of them verbatim** — a paraphrase that
repeats an existing alias tests nothing:

> drawing reading · GD&T · geometric dimensioning and tolerancing · blueprint reading · CAD ·
> technical drawing · read engineering drawings · drawing padhna *(hi)*

## What to write

For each slot: **how would a worker in that trade describe this skill, in their own words,
without using any phrase above?** One line. Their words, not the catalogue's.

Then set `review_status` to `reviewed` in the pack JSON, or hand these back and engineering will.

| # | case id | trade (job domain) | language | how a worker there would say it |
|---|---|---|---|---|
| 1 | `PR-drawing_reading-1` | **Quality Inspector** — forged, cast or machined components<br><sub>`jd_nco_7543_2001` · required</sub> | English | |
| 2 | `PR-drawing_reading-2` | **Quality Inspector** — forged, cast or machined components<br><sub>`jd_nco_7543_2001` · required</sub> | **Hindi** | |
| 3 | `PR-drawing_reading-jd_nco_7223_6003` | **CNC Programmer**<br><sub>`jd_nco_7223_6003` · required</sub> | English | |
| 4 | `PR-drawing_reading-jd_nco_7223_0701` | **Lathe Machinist**<br><sub>`jd_nco_7223_0701` · required</sub> | English | |
| 5 | `PR-drawing_reading-jd_nco_7224_0102` | **Fitter — Fabrication**<br><sub>`jd_nco_7224_0102` · required</sub> | English | |

Those four trades were chosen by the corpus, not by taste: they are the ones that mark this
skill **`required`** — the corpus's own statement that it is not optional work there.

## Three questions that come with the slots

**Q1 — Is the label right?**
The catalogue calls this *"Drawing reading (GD&T / technical drawing)"*. Is that what a worker
or a supervisor would actually call it? If the label is jargon, the fix is the alias list, not
the test cases.

☐ Label is fine ☐ Should be: ______________________

**Q2 — Are these separate skills, or the same work under different names?**
Measured similarity to drawing reading, from the live vectors:

| skill | closest phrase | similarity |
|---|---|---|
| CAM software (Mastercam/Fusion/etc.) | "CAM software" | 0.681 |
| TIG welding | "GTAW" | 0.669 |
| CMM operation | "coordinate measuring machine" | 0.664 |
| Fixture / job setup | "workholding" | 0.643 |

For each: **same work, or different?** If the same, that is a taxonomy merge, not a test case.
If different, say in one line what separates them, so the paraphrase can be written to keep them
apart.

☐ CAM software: same / different — because ______________________
☐ TIG welding: same / different — because ______________________
☐ CMM operation: same / different — because ______________________
☐ Fixture setup: same / different — because ______________________

**Q3 — Does it mean the same thing everywhere?**
This skill is reachable in **12** trades. Beyond the four above: Final Quality Inspector, CNC
Operator-Turning, Sheet Metal Worker, Pipe Fitter, Welder, Automobile Assembler, Electrical
Fitter, Fitter Automobile.

Does "reading a drawing" mean the same job in all twelve? If a pipe fitter and a quality
inspector mean materially different things by it, this needs one case per trade rather than one
shared case.

☐ Same everywhere ☐ Differs in: ______________________

---

# Part 2 — TD-07: the generic welding gap

## The finding, restated

There is **no generic welding skill**. The catalogue holds four specific ones:

| skill | aliases in production |
|---|---|
| `skill_arc_welding` — Arc welding | 3 |
| `skill_mig_welding` — MIG welding | 3 |
| `skill_tig_welding` — TIG welding | 2 |
| `skill_gas_cutting` — Gas cutting | 3 |

Plus `skill_welder_occupation` ("Welder"), which is an **occupation**, not a skill — it answers
to *"welder"* and *"welding ka kaam"*.

`SMAW` vs `GMAW` sit at cosine **0.8405**, the closest cross-skill pair anywhere in the corpus.
They are genuinely near-identical in phrasing and genuinely different in the workshop.

## Why it was left open rather than guessed

A worker who says only **"welding"** has not said which process. Resolving that silently to
`skill_arc_welding` — the tempting default, since it is the most common — writes a specific
process onto their profile that they may not do. That is a hiring-quality failure the platform
cannot see and the worker cannot correct.

## The current production behaviour, measured

Bare **"welding"** matches **no skill alias**. The nearest thing is the occupation
`skill_welder_occupation` via *"welder"*. So today a bare "welding" does not silently become arc
welding — the gap is open, not papered over. **Nothing is on fire; this is a coverage decision,
not an incident.**

## What product + a trainer need to choose

| option | what it means | consequence |
|---|---|---|
| **A — create a generic parent skill** | a new `skill_welding_general`, with the four specific ones as children | Bare "welding" resolves to something honest. Needs a parent/child concept the taxonomy does not currently have |
| **B — create a flat generic skill** | `skill_welding_general` as a sibling, no hierarchy | Cheapest. Risk: a worker who does only TIG may now match generic-welding jobs, and vice versa |
| **C — route to the occupation** | bare "welding" resolves to `skill_welder_occupation` | Uses what already exists. But an occupation is not a skill, and mixing them makes "what can this worker do" ambiguous |
| **D — ask the worker** | the interview follows up: "which kind — arc, MIG, TIG, gas cutting?" | Best data quality. Costs one interview turn and needs a product decision about turn budget |
| **E — leave the gap open** | status quo | Bare "welding" keeps matching nothing. Honest, and loses a real worker signal |

**Engineering has no view on which is right** — every one of them is a product judgement about
what a worker's profile should claim on their behalf. What engineering can say is that A needs a
schema concept that does not exist yet, D needs an interview-flow change, and B, C and E are
data-only.

☐ Chosen: ______ Rationale: ______________________

---

## Where the answers go

Hand this back filled in, or edit directly:

- **TD-01 slots** → `packages/db/data/taxonomy/eval/review-pack/td01-drawing-reading-trainer-pack.json`,
  setting each slot's `query` and flipping `review_status` from `pending_review` to `reviewed`.
- **TD-07** → a new decision entry in `phase-8-taxonomy-decisions.md` §TD-07, which currently
  reads *"GAP, not a merge"*.

Until TD-01's five slots are `reviewed`, they stay **excluded from every recall metric** — which
is why R@1 0.9912 is reported over 113 cases and not 127.
