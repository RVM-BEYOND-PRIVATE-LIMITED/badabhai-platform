# Trainer & product worksheet — TD-01 slots and TD-07

> **For a trade trainer and a product owner. No engineering knowledge needed.**
> Nothing here is a draft answer. Every blank is blank on purpose — see *Why the blanks are
> blank*.
>
> **Do Part 1 before reading Part 1B.** That order is not a formality; the reason is below.
>
> **Where these numbers come from:** the corpus source files on `main` and a read-only export of
> the alias vectors — **not** the production database. Two of the three facts about production
> are labelled as such where they appear. Revision 2, 2026-08-19: the first revision of this
> file contained four factual errors and one leading question; all are corrected here and the
> corrections are noted inline so nobody carries the old version forward.

---

## Why the blanks are blank

**DC-18** is the standing example in this repository. A test case read as a model failure for two
phases before anyone noticed the case itself was wrong — its "correct answer" was one person's
opinion, written by the same pipeline that then measured against it.

So if engineering invents how a lathe machinist describes reading a drawing, and then measures
whether the system finds that phrase, the measurement is circular. **Only phrasings from someone
who does the trade are worth measuring.**

The same logic is why Part 1 comes before Part 1B. Part 1B shows you which skills the system
currently confuses with this one. If you read that first, your paraphrases will be written to
avoid those specific confusions — and the test will then confirm a distinction you were shown
rather than discover one you know.

---

# Part 1 — TD-01: five paraphrases

## The skill

**Drawing reading (GD&T / technical drawing)** — `skill_drawing_reading`

It already answers to these phrases. **Do not reuse any of them** — a paraphrase that repeats an
existing phrase tests nothing:

> drawing reading · GD&T · geometric dimensioning and tolerancing · blueprint reading · CAD ·
> technical drawing · read engineering drawings · drawing padhna *(hi)*

## What to write

For each row: **how would a worker in that trade describe this skill, in their own words, without
using any phrase above?** One line each. Their words, not the catalogue's.

| # | case id | trade (job domain) | language | how a worker there would say it |
|---|---|---|---|---|
| 1 | `PR-drawing_reading-1` | **Quality Inspector** — forged, cast or machined components<br><sub>`jd_nco_7543_2001` · required</sub> | English | |
| 2 | `PR-drawing_reading-2` | **Quality Inspector** — forged, cast or machined components<br><sub>`jd_nco_7543_2001` · required</sub> | **Hindi — in Devanagari script**, as a worker would type or say it. Not romanised. | |
| 3 | `PR-drawing_reading-jd_nco_7223_6003` | **CNC Programmer**<br><sub>`jd_nco_7223_6003` · required</sub> | English | |
| 4 | `PR-drawing_reading-jd_nco_7223_0701` | **Lathe Machinist**<br><sub>`jd_nco_7223_0701` · required</sub> | English | |
| 5 | `PR-drawing_reading-jd_nco_7224_0102` | **Fitter — Fabrication**<br><sub>`jd_nco_7224_0102` · required</sub> | English | |

Those four trades were chosen by the corpus, not by taste: they are the ones that mark this skill
**`required`** — the corpus's own statement that it is not optional work there.

**One more question, and it is not a formality.** This skill is currently reachable in **12**
trades. Beyond the four above: Final Quality Inspector, CNC Operator-Turning, Sheet Metal Worker,
Pipe Fitter, Welder, Automobile Assembler, Electrical Fitter, Fitter Automobile. Does "reading a
drawing" mean the same job in all twelve? If a pipe fitter and a quality inspector mean materially
different things by it, this needs one case per trade rather than one shared case.

☐ Same everywhere ☐ Differs in: ______________________

**Stop here until the five rows above are filled in.**

---

# Part 1B — after the paraphrases are written

**Correction to revision 1.** It said filling these slots was why recall is reported over 113
cases instead of 127. That was wrong. `skill_drawing_reading` appears in **zero** of the 127 eval
cases — the pack records `existing_fixture_coverage_for_this_skill: 0`. The 113/127 difference is
a separate matter (negative cases and coverage-only cases). The true state: **this skill has no
eval coverage at all today**, and these five slots would be the first.

### Is the label right?

The catalogue calls this *"Drawing reading (GD&T / technical drawing)"*. Is that what a worker or
a supervisor would actually call it? If the label is jargon, the fix is the phrase list, not the
test cases.

☐ Label is fine ☐ Should be: ______________________

### Which of these are the same work under another name?

Measured similarity to drawing reading, computed over the **corpus** alias vectors — this is an
offline measurement, **not** production traffic:

| skill | closest phrase | similarity |
|---|---|---|
| CAM software (Mastercam/Fusion/etc.) | "CAM software" | 0.681 |
| TIG welding | "GTAW" | 0.669 |
| CMM operation | "coordinate measuring machine" | 0.664 |
| Fixture / job setup | "workholding" | 0.643 |

For each: **same work, or different?** If the same, that is a taxonomy merge, not a test case. If
different, say in one line what separates them.

☐ CAM software: same / different — because ______________________
☐ TIG welding: same / different — because ______________________
☐ CMM operation: same / different — because ______________________
☐ Fixture setup: same / different — because ______________________

---

# Part 2 — TD-07: the generic welding gap

## What the corpus holds

Five welding-related skills, with the number of trades each is wired to:

| skill | trades wired | phrases | note |
|---|---|---|---|
| `skill_arc_welding` — Arc welding | 4 | 3 | |
| `skill_mig_welding` — MIG welding | 2 | 3 | |
| `skill_tig_welding` — TIG welding | 1 | 2 | |
| `skill_gas_cutting` — Gas cutting | 5 | 2 | filed under **fabrication**, not welding — the corpus does not model it as a joining process |
| `skill_welder_occupation` — Welder | **0** | 1 | an occupation, not a skill. **Zero trades wired**, so the domain-scoped retrieval path cannot return it anywhere |

`SMAW` vs `GMAW` sit at cosine **0.8405**, the closest cross-skill pair in the corpus.

## Two corrections to revision 1, both material

**1. Something specific is already being written, and it is not arc welding.**
Revision 1 said bare "welding" resolves to nothing, so no specific process is being assigned. That
was true only of one layer. At the **match** layer, `packages/taxonomy/src/match-skills.ts` maps
`skill_welder_occupation → mskill_mig_welder`. So a worker who says only *"welder"* or
*"welding ka kaam"* — the two phrases that skill answers to — already has **MIG welder** derived
onto their match profile. The silent specific-process assignment TD-07 was raised to prevent is
shipping today, by a different route than the one the register examined.

**2. Bare "welding" already works one layer up.** `"welding"` is a registered alias of the job
domain `jd_nco_7212_0301` (Welder). So at the *trade* layer the phrase resolves correctly. The gap
is specifically at the *skill* layer.

**Production, measured (read-only, 2026-08-19):** no skill phrase matches bare `"welding"`.
`"welder"` and `"welding ka kaam"` both match `skill_welder_occupation`.

## The options

Consequences below are mechanics only — what changes, what it costs, what it rules out. No option
is marked recommended.

| option | what it means | what it changes |
|---|---|---|
| **A — generic parent skill** | a new `skill_welding_general` with the specific ones as children | Needs a parent/child concept the schema does not have. New skill id ⇒ also needs a match-layer mapping entry |
| **B — flat generic skill** | `skill_welding_general` as a sibling, no hierarchy | New skill id ⇒ needs trade wiring, phrases, an embedding, and a match-layer mapping entry. A worker who does only TIG may then match generic-welding jobs, and the reverse |
| **C — route to the occupation** | bare "welding" resolves to `skill_welder_occupation` | That skill has **0 trades wired**, so it is unreachable on the domain-scoped path until edges are added. Also inherits the existing `→ mskill_mig_welder` mapping unless that is changed too |
| **D — ask the worker** | the interview follows up: "which kind — arc, MIG, TIG, gas cutting?" | One extra interview turn. Needs a product decision on turn budget |
| **E — leave the skill layer as it is** | status quo | Bare "welding" keeps matching no skill. The `→ mskill_mig_welder` derivation in correction 1 continues either way unless separately changed |
| **F — treat it as trade-level only** | leave the skill layer alone; rely on the job-domain alias that already resolves "welding" | Nothing to build. Bare "welding" identifies the trade but never a skill, so it contributes nothing to skill-based ranking |

**The `→ mskill_mig_welder` mapping is a separate decision from A–F** and applies under every one
of them. It can be changed, removed, or kept independently.

☐ Chosen: ______ ☐ Keep `skill_welder_occupation → mskill_mig_welder`? yes / no
Rationale: ______________________

## What is missing from this page, and should be before you decide

This worksheet has **no impact sizing** — no denominator. Engineering can produce these on
request; they are read-only queries, and none of them is a judgement call:

- how many worker utterances contain bare "welding" (from `unresolved_phrase` and chat logs);
- how many job posts require any welding skill;
- how many worker profiles currently carry `skill_welder_occupation`, and therefore how many
  already have MIG derived onto them by correction 1.

**Ask for these before choosing.** A five-way option table with no volumes behind it invites a
decision on aesthetics.

---

# Part 3 — the six skills the promotion gate now blocks

**Added 2026-08-20, after the owner chose E1 for `EVAL_COVERED`.** This part is separate from
Parts 1 and 2 and can be done by a different person: it needs a trade phrase, not a taxonomy
ruling.

## What changed

`EVAL_COVERED` used to accept a **mechanical** case as proof a skill had been measured. A
mechanical case is one where the query IS the skill's own catalogue phrase — so it asks the
search index whether an exact string matches itself. It cannot fail, and it says nothing about
whether a worker who describes the skill in their own words would be found.

Six skills are covered by nothing else. Under the new reading they can no longer be promoted.

| skill | the phrase that used to count | trade |
|---|---|---|
| Earthing and bonding | `earthing work` | Electrician, General |
| Order picking and packing | `ऑर्डर तैयार करना` | Warehouse Picker |
| Pipe support and clamping | `pipe clamping` | Pipe Fitter |
| Punching machine operation | `punching operation` | Sheet Metal Machine Operator |
| Structural fit-up and tacking | `fit up and tack` | Fitter — Fabrication |
| Suspension and steering repair | `suspension repair` | Fitter Automobile |

**Nothing is broken and no worker is affected.** None of the six exists in the production
database — they belong to a corpus that has never been seeded — so this blocks zero live
promotions. It is the cheapest this will ever be, which is why it was done now.

## What is needed

**One line per skill: how would a worker in that trade describe this, in their own words?**

Do not reuse the phrase in the table above, or any phrase the pack lists as already known. A
paraphrase that repeats an existing phrase tests nothing — that is the exact problem being
fixed here.

**The blanks are in the pack, not on this page**, so that filling them in is the same action as
updating the fixture:

> `packages/db/data/taxonomy/eval/review-pack/e1-eval-coverage-trainer-pack.md` — read this one
> `packages/db/data/taxonomy/eval/review-pack/e1-eval-coverage-trainer-pack.json` — write here

For each skill the pack gives the skill's known phrases, every trade it is wired to, and two
empty slots (English and Hindi). **One filled slot per skill clears the gate.** Set that slot's
`query`, change its `review_status` from `pending_review` to `reviewed`, and leave anything you
are unsure about as `pending_review` — it stays out of every metric and costs nothing.

Regenerate the pack any time with `pnpm --filter @badabhai/db db:review-pack:eval-coverage`
(delete the old files first; the runner refuses to overwrite evidence). It reads the promotion
gate's own function, so it can never list a different set from the one actually blocking.

**Why engineering did not just write the six phrases:** the same reason as Part 1. A paraphrase
written by the process that then scores it measures nothing — and here it would be worse, since
the entire point of the change is that self-certifying evidence must not unlock a promotion.

---

## Where the answers go

- **TD-01 slots** → `packages/db/data/taxonomy/eval/review-pack/td01-drawing-reading-trainer-pack.json`,
  setting each slot's `query` and flipping `review_status` from `pending_review` to `reviewed`.
- **TD-07** → a new decision entry in `phase-8-taxonomy-decisions.md` §TD-07, which currently
  reads *"GAP, not a merge"*. **Partly answered already:** the owner chose **T4 now, T1 at the
  first real welder** on 2026-08-20 and T4 has shipped. Part 2 below is still open for the
  `skill_welder_occupation → mskill_mig_welder` mapping and for T1's shape.
- **Part 3 (the six blocked skills)** → the pack itself:
  `packages/db/data/taxonomy/eval/review-pack/e1-eval-coverage-trainer-pack.json`.

Or hand this page back filled in and engineering will transcribe it.
