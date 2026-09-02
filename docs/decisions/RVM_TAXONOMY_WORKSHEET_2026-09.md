# RVM Taxonomy Worksheet — Section-1 Roles

**For:** RVM (domain-truth authority) and the CEO
**From:** BadaBhai engineering
**Date:** 2026-09
**Code state:** HEAD `fb134c4a18e07f523511b0148eebc1eeb3b6beed`

---

## How to use this document

This is a **worksheet, not an answer**. Engineering has filled in every column it is
allowed to fill in, so that RVM's job is to **accept, correct, or strike** — never to
start from a blank page.

- Every cell engineering filled is a **PROPOSAL**. Nothing here is decided.
- The **RVM VERDICT** column is deliberately empty. It stays empty until RVM writes in it.
- The recommendations in Part 3 are engineering's opinion offered to speed you up.
  **A recommendation is not a ruling.** R1–R7 are settled only by a signature on the
  line provided.

### Source of authority

| Rank | Source                                                        | Used for                                                         |
| ---- | ------------------------------------------------------------- | ---------------------------------------------------------------- |
| 1    | `BadaBhai_MVP_Matching_and_Posting_Execution_Spec_2026-09-01` | The A0–A11 analysis, the proposed family re-cut, R1–R7           |
| 2    | `BadaBhai_MASTER_CONTEXT_2026-07-23` §21 §22 §23 §24          | The **locked** function enum, collar tiers, domains, alias rules |
| 3    | `BadaBhai_Role_Taxonomy_Master` (2026-08-09)                  | The 21–22 Section-1 roles, their ladders and attributes          |
| 4    | Code at HEAD                                                  | What is actually built today (cited by file:line throughout)     |

Where a claim about the code appears below, it was read at HEAD and is cited by file and
line. The execution spec's own closing caveat asks for exactly this: _"Every claim above
about current code state derives from the 2026-09-01 codebase report, which carries no
commit SHA. Confirm against HEAD before committing dates."_

---

## The locked vocabulary — engineering may not add to these

**`function`** — `MASTER_CONTEXT` §21, locked 2026-07-09. Nine values:

```
operator (default) · setter · programmer · trainer · supervisor
maintenance · inspector · manager · apprentice
```

Plus **one proposed addition**, which is what R1 asks you to approve:

```
setter_programmer          <-- PROPOSED, not locked. See R1.
```

**`collar_tier`** — `MASTER_CONTEXT` §21 Axis B, locked. Four values:

```
elementary -> semi-skilled -> skilled trade -> technician
```

**`domain`** — `MASTER_CONTEXT` §23. The section header says _"11 domains"_ but the table
below it lists **ten**. That missing eleventh slot is Question 2.

```
1  Machining & Cutting            6  Plastics & Polymer
2  Forming & Fabrication          7  Assembly & Integration
3  Tooling, Die & Mould           8  Quality & Inspection
4  Casting & Foundry              9  Maintenance & Plant
5  Heat Treatment & Finishing    10  Production Support & Supervision
```

**`family`** — the locked set is
`{Turning} {Milling} {Setting/Programming} {Grinding} {Welding/Fab} {Moulding}`.
Spec §A3 dissolves `{Setting/Programming}` and proposes an 11-family re-cut. **The
`proposed_family` column below uses the A3 re-cut, which is itself unratified — that is
R2.**

### Notation used in the table

| Mark                 | Meaning                                                                                                                                         |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| _(plain value)_      | The Aug-9 ladder names this rung and it maps **1:1** to a locked enum value. Traceable, low-risk.                                               |
| `?value`             | **Engineering's proposed mapping.** The rung wording is not a name match — a human judgement is required. Highest-value cells for RVM to check. |
| `setter_programmer*` | The proposed **new** enum value. Invalid until R1 is signed.                                                                                    |
| _(blank)_            | No defensible mapping exists. The rung is listed under **Unmapped rungs**.                                                                      |
| `[E]`                | Alias **already exists in code** — no RVM effort needed unless you want it struck.                                                              |
| `[N]`                | Net-new alias proposal — needs an accept/strike verdict.                                                                                        |
| ⚠                    | A known collision. See R4.                                                                                                                      |

**No marker means proposed, not settled.** A bare value in `proposed_domain` or
`proposed_family` — `Machining & Cutting`, `Turning` — is engineering's proposal
exactly like a `?`-marked one. The `?` records only _how much_ judgement went into
the cell, never whether the cell is open. **Every cell in every column of Part 1 is
open until RVM writes in the verdict column.**

---

# Part 1 — The role table

21 rows. Section 1A (4) + 1B (1) + 1C (11) + 1D (5) = **21**. The sheet's own summary says
22 — that is Question 1.

| #   | role_label                             | proposed_domain                                                                         | proposed_family        | applicable function values                            | applicable collar tiers                            | 5 candidate Hinglish aliases (all PROPOSED)                                                                                                                       | RVM VERDICT |
| --- | -------------------------------------- | --------------------------------------------------------------------------------------- | ---------------------- | ----------------------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| 1   | CNC Turner                             | Machining & Cutting                                                                     | Turning                | operator · setter · `setter_programmer*` · programmer | skilled trade · `?technician`                      | 1 kharad `[E]` · 2 खराद `[E]` · 3 lathe / लेथ `[E]` · 4 cnc turning `[E]` · 5 turning ka kaam `[E]`                                                               |             |
| 2   | CNC Machining Centre Operator          | Machining & Cutting                                                                     | Milling                | operator · setter · `setter_programmer*` · programmer | skilled trade · `?technician`                      | 1 vmc operator `[E]` · 2 वीएमसी `[E]` · 3 milling machine / मिलिंग `[E]` · 4 hmc operator `[N]` · 5 machining centre `[N]`                                        |             |
| 3   | CNC Grinding Operator                  | Machining & Cutting                                                                     | Grinding               | operator · setter · `setter_programmer*`              | skilled trade · `?technician`                      | 1 grinding machine `[E]` · 2 ghisai / घिसाई `[E]` · 3 grinding ka kaam `[N]` · 4 cylindrical grinding `[N]` · 5 surface grinder `[N]`                             |             |
| 4   | CAM Programmer                         | Machining & Cutting                                                                     | Programming Desk       | programmer · `?apprentice`                            | `?technician`                                      | 1 cam programmer `[N]` · 2 mastercam `[N]` · 3 program banana `[E]` · 4 cnc program banana `[N]` · 5 post processor `[N]`                                         |             |
| 5   | CAD Designer / Draughtsman             | **⚠ BLANK — no locked domain. See Q2.**                                                 | Programming Desk       | _(blank — see Unmapped rungs)_                        | `?technician`                                      | 1 cad designer `[N]` · 2 draughtsman / ड्राफ्ट्समैन `[N]` · 3 drawing banana `[N]` · 4 autocad ka kaam `[N]` · 5 design ka kaam `[N]`                             |             |
| 6   | Conventional Machinist                 | Machining & Cutting                                                                     | Conventional Machining | operator                                              | `?elementary` · `?semi-skilled` · skilled trade    | 1 machinist `[E]` · 2 machine shop `[E]` · 3 manual lathe `[N]` · 4 traditional kharad `[N]` · 5 milling drilling ka kaam `[N]`                                   |             |
| 7   | Welder                                 | Forming & Fabrication                                                                   | Welding & Fabrication  | _(blank — see Unmapped rungs)_                        | `?elementary` · skilled trade                      | 1 welder / वेल्डर `[E]` · 2 welding / वेल्डिंग `[E]` · 3 welding mistri `[E]` · 4 jodai ka kaam / जोड़ाई `[E]` · 5 veldar `[E]`                                   |             |
| 8   | Fitter                                 | Assembly & Integration _(straddles Maintenance & Plant — note F)_                       | Fitting & Maintenance  | _(blank — see Unmapped rungs)_                        | `?elementary` · skilled trade                      | 1 fitter / फिटर `[E]` · 2 bench fitter `[E]` · 3 maintenance fitter `[E]` · 4 fitting ka kaam `[E]` · 5 assembly fitter `[N]`                                     |             |
| 9   | Quality Inspector / QC                 | Quality & Inspection                                                                    | Quality                | inspector                                             | skilled trade · `?technician`                      | 1 quality check karna `[E]` · 2 qc inspector `[N]` · 3 quality wala `[N]` · 4 naap tol `[E]` · 5 inspection ka kaam `[N]`                                         |             |
| 10  | Sheet Metal Worker                     | Forming & Fabrication                                                                   | Welding & Fabrication  | operator                                              | `?elementary` · skilled trade                      | 1 chadar ka kaam `[E]` · 2 sheet metal `[N]` · 3 press brake `[N]` · 4 laser cutting `[N]` · 5 fabrication ka kaam `[N]`                                          |             |
| 11  | Assembly Line Worker                   | Assembly & Integration                                                                  | General Production     | operator                                              | `?elementary` · `?semi-skilled`                    | 1 assembler / असेंबलर `[E]` · 2 assembly line / असेंबली `[E]` · 3 assembly ka kaam `[N]` · 4 fitting line `[N]` · 5 production line `[N]`                         |             |
| 12  | Maintenance Technician                 | Maintenance & Plant                                                                     | Fitting & Maintenance  | `?maintenance`                                        | `?elementary` · technician                         | 1 machine ki marammat `[E]` · 2 maintenance `[N]` · 3 breakdown maintenance `[N]` · 4 machine repair `[N]` · 5 marammat ka kaam `[N]`                             |             |
| 13  | Industrial Electrician                 | Maintenance & Plant                                                                     | Fitting & Maintenance  | `?maintenance`                                        | `?elementary` · skilled trade                      | 1 bijli mistri / बिजली मिस्त्री `[E]` · 2 electric mistri `[E]` · 3 wiring ka kaam / वायरिंग `[E]` · 4 ilectrician `[E]` · 5 panel wiring `[N]`                   |             |
| 14  | Tool & Die Maker                       | Tooling, Die & Mould                                                                    | Tooling                | `?apprentice`                                         | `?semi-skilled` · skilled trade · `?technician`    | 1 tool maker / टूल मेकर `[E]` · 2 tool room / टूल रूम `[E]` · 3 **die maker / डाई मेकर** `[E]` ⚠ **R4-c** · 4 jig fixture `[E]` · 5 tool room ka kaam `[N]`       |             |
| 15  | Press / Machine Operator               | Forming & Fabrication _(⚠ §23 splits this — see R4-a)_                                  | General Production     | operator · setter                                     | `?elementary` · `?semi-skilled`                    | 1 power press `[N]` · 2 press operator `[N]` · 3 press ka kaam `[N]` · 4 machine operator `[N]` · 5 stamping `[N]`                                                |             |
| 16  | Painter / Powder Coating               | Heat Treatment & Finishing                                                              | General Production     | operator                                              | `?elementary` · `?semi-skilled` · `?skilled trade` | 1 industrial painter `[E]` · 2 spray painter / स्प्रे पेंटिंग `[E]` · 3 powder coating `[N]` · 4 booth painter `[N]` · 5 paint ka kaam `[E]` ⚠ **note P**         |             |
| 17  | Injection Moulding Operator            | Plastics & Polymer                                                                      | Moulding & Polymer     | operator · setter                                     | `?semi-skilled` · `?technician`                    | 1 injection moulding `[N]` ⚠ **R4-a** · 2 moulding operator `[N]` · 3 plastic moulding `[N]` · 4 moulding ka kaam `[N]` · 5 plastic machine chalana `[N]`         |             |
| 18  | Mould / Die Maker (Plastics)           | **⚠ Tooling, Die & Mould** _(§23) — but the sheet files it under 1D Plastics. See R4-c_ | Tooling                | `?apprentice`                                         | `?semi-skilled` · skilled trade                    | 1 mould maker `[N]` · 2 mould fitting `[N]` · 3 **die maker** `[E]` → today resolves to row 14 ⚠ **R4-c** · 4 spark erosion / EDM `[N]` · 5 mould polishing `[N]` |             |
| 19  | Blow Moulding / Extrusion Operator     | Plastics & Polymer                                                                      | Moulding & Polymer     | operator · setter                                     | `?elementary` · `?semi-skilled`                    | 1 blow moulding `[N]` · 2 extrusion `[N]` · 3 pipe extrusion `[N]` · 4 blown film `[N]` · 5 extruder operator `[N]`                                               |             |
| 20  | Rubber Moulding / Compression Operator | Plastics & Polymer                                                                      | Moulding & Polymer     | operator · setter                                     | `?elementary` · `?semi-skilled`                    | 1 rubber moulding `[N]` · 2 compression moulding `[N]` · 3 rubber ka kaam `[N]` · 4 mixing mill `[N]` · 5 kneader operator `[N]`                                  |             |
| 21  | Plastic Process / Quality Technician   | **⚠ Plastics & Polymer** _or_ Quality & Inspection — see R4-b                           | Moulding & Polymer     | _(blank — see Unmapped rungs)_                        | technician                                         | 1 process technician `[N]` · 2 plastic qc `[N]` ⚠ **R4-b** · 3 parameter setting `[N]` · 4 rejection control `[N]` · 5 process setting `[N]`                      |             |

### Notes referenced above

**Note F (Fitter).** The Aug-9 attributes are _"Mechanical / assembly / maintenance
fitting."_ §23 places `Machine Fitter` under **Assembly & Integration** and
`Maintenance Technician (Mechanical)` under **Maintenance & Plant**. The alias
`maintenance fitter` is already seeded in code. One role, two locked domains — RVM
picks the anchor domain. §21 rule: _"Anchor Industry/Domain to the TRADE, not the job's
function."_

**Note P (Painter).** `paint ka kaam`, `putai`, `safedi`, `rangai putai` are already
seeded — but to `jd_nco_7131_0100`, which is **house painting**, not industrial
finishing. Seeding `paint ka kaam` onto the industrial role would put a building painter
and a powder-coating operator in the same bucket. Engineering recommends **striking
alias 5** and keeping only `industrial painter` / `spray painter`. This is a fourth
collision found in code, outside the three R4 traps.

---

## Unmapped rungs

Aug-9 ladder rungs with **no defensible mapping** to a locked enum value. Engineering has
not invented a value for any of these. Each needs an RVM instruction: _map it to an
existing value · treat it as a collar tier · treat it as a display-only attribute · drop
it._

| Role                                                        | Rung                                                   | Why it does not map                                                                                                   | RVM instruction |
| ----------------------------------------------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- | --------------- |
| CNC Turner, CNC MC Op, CNC Grinding                         | **Setter-cum-Programmer**                              | No such `function` value exists. This is what `setter_programmer` is proposed for.                                    |                 |
| CAM Programmer                                              | **Junior**, **Senior Programmer**                      | Seniority words, not functions. Probably collar tier.                                                                 |                 |
| CAD Designer                                                | **Draughtsman**, **CAD Designer**, **Design Engineer** | None is a `function`. `Engineer` is not in the enum. Whole ladder is unmapped.                                        |                 |
| Conventional Machinist, Sheet Metal, Assembly Line, Painter | **Helper**, **Skilled**                                | Tier words, not functions. `Helper` → `elementary` or `semi-skilled`? **Affects 8 roles — see R1 sub-question (i).**  |                 |
| Welder                                                      | **Welder**, **Certified Welder**                       | `Welder` is the role name at journeyman rung. `Certified` is an attribute per the sheet's own "certification" column. |                 |
| Fitter                                                      | **Fitter**, **Senior Fitter**                          | Role name + seniority.                                                                                                |                 |
| Quality Inspector                                           | **QC Engineer**                                        | `Engineer` is not in the enum.                                                                                        |                 |
| Maintenance Technician                                      | **Technician**, **Senior Technician**                  | `technician` is a **collar tier**, not a function. Proposed as tier, not function.                                    |                 |
| Industrial Electrician                                      | **Electrician**, **Senior**                            | Role name + seniority.                                                                                                |                 |
| Tool & Die Maker                                            | **Trainee**, **Tool Maker**, **Senior**                | `Trainee` → `?apprentice` is a judgement. `Tool Maker` is the role name.                                              |                 |
| Press / Machine Operator                                    | **Helper**                                             | See above.                                                                                                            |                 |
| **Injection Moulding Operator**                             | **Setter-cum-Process Technician**                      | **Not the same as `setter_programmer`.** A process technician is not a programmer. There is no enum value for it.     |                 |
| Mould / Die Maker (Plastics)                                | **Trainee**, **Mould Maker**, **Senior**               | As Tool & Die Maker.                                                                                                  |                 |
| **Plastic Process / Quality Technician**                    | **Technician**, **Process Engineer**                   | Neither is a `function`. `Process Engineer` has no enum value at all.                                                 |                 |
| Blow Moulding, Rubber Moulding                              | **Helper**                                             | See above.                                                                                                            |                 |

---

## Alias tick-list (an aid — the table above is the record)

105 candidates across the 21 roles: **40 already in code `[E]`**, **65 net-new `[N]`**.
Only the 65 `[N]` rows strictly need a verdict — they are all listed below. Mark
`A` accept · `S` strike · or write a replacement.

`[E]` aliases are already seeded at
[packages/db/data/job-domains/rvm-aliases.jsonl](../../packages/db/data/job-domains/rvm-aliases.jsonl)
or ratified at
[packages/taxonomy/src/wedge-aliases.ts](../../packages/taxonomy/src/wedge-aliases.ts)
(the 22-entry packet RVM ratified on 2026-07-16). They are listed so you can strike one
if it is wrong — not because they need re-approval.

| Role                           | `[N]` aliases needing a verdict                                                                        | A / S |
| ------------------------------ | ------------------------------------------------------------------------------------------------------ | ----- |
| CNC Turner                     | _(none — all 5 exist)_                                                                                 | —     |
| CNC Machining Centre Op        | hmc operator · machining centre                                                                        |       |
| CNC Grinding Op                | grinding ka kaam · cylindrical grinding · surface grinder                                              |       |
| CAM Programmer                 | cam programmer · mastercam · cnc program banana · post processor                                       |       |
| CAD Designer                   | cad designer · draughtsman/ड्राफ्ट्समैन · drawing banana · autocad ka kaam · design ka kaam            |       |
| Conventional Machinist         | manual lathe · traditional kharad · milling drilling ka kaam                                           |       |
| Welder                         | _(none — all 5 exist)_                                                                                 | —     |
| Fitter                         | assembly fitter                                                                                        |       |
| Quality Inspector              | qc inspector · quality wala · inspection ka kaam                                                       |       |
| Sheet Metal Worker             | sheet metal · press brake · laser cutting · fabrication ka kaam                                        |       |
| Assembly Line Worker           | assembly ka kaam · fitting line · production line                                                      |       |
| Maintenance Technician         | maintenance · breakdown maintenance · machine repair · marammat ka kaam                                |       |
| Industrial Electrician         | panel wiring                                                                                           |       |
| Tool & Die Maker               | tool room ka kaam                                                                                      |       |
| Press / Machine Operator       | power press · press operator · press ka kaam · machine operator · stamping                             |       |
| Painter / Powder Coating       | powder coating · booth painter _(+ strike `paint ka kaam`? — note P)_                                  |       |
| Injection Moulding Op          | injection moulding · moulding operator · plastic moulding · moulding ka kaam · plastic machine chalana |       |
| Mould / Die Maker              | mould maker · mould fitting · spark erosion/EDM · mould polishing                                      |       |
| Blow Moulding / Extrusion      | blow moulding · extrusion · pipe extrusion · blown film · extruder operator                            |       |
| Rubber Moulding                | rubber moulding · compression moulding · rubber ka kaam · mixing mill · kneader operator               |       |
| Plastic Process / Quality Tech | process technician · plastic qc · parameter setting · rejection control · process setting              |       |

> **Scale check.** This worksheet covers **role** aliases only (~105). The **skill**-alias
> budget for MVP is a separate ~1,900 (spec §A5). This worksheet is the front door, not
> the whole seeding job.

---

# Part 2 — Two direct questions

## Question 1 — The sheet says 22 roles. Sections 1A–1D contain 21.

Counting the rows in `BadaBhai_Role_Taxonomy_Master`:

| Section | Heading                                             | Rows counted |
| ------- | --------------------------------------------------- | ------------ |
| 1A      | Phase 1 — the launch wedge                          | **4**        |
| 1B      | Phase 2 — Design & drafting                         | **1**        |
| 1C      | Phase 2 — Metal fabrication, assembly & maintenance | **11**       |
| 1D      | Phase 2 — Plastics & rubber cluster                 | **5**        |
|         | **Total**                                           | **21**       |

The sheet's own summary line reads: _"Total already planned: 22 roles — 4 in the Phase 1
launch wedge, 18 in Phase 2."_ The Phase-1 count of 4 is correct. **The Phase-2 count is
the discrepancy: 1 + 11 + 5 = 17 rows, not 18.**

So the question is narrow and answerable:

- **(a)** A 22nd role exists and was dropped from Section 1B/1C/1D when the sheet was
  compiled. → **Name it.** It gets a row and an alias budget.
- **(b)** There are 21 roles and the summary line is an arithmetic slip. → The correct
  count is 21, and the ~2,100-alias budget in spec §A5 (which assumes 21) stands.

**Why it cannot wait:** role count drives the alias seeding budget and the golden-fixture
set. Spec §D says golden fixtures across all roles are _"the thing that makes any of this
safe."_ A fixture set built for 21 that should have covered 22 has a silent hole.

```
RVM / CEO answer: ............................................................

.............................................................................
```

---

## Question 2 — Is "Design & Drafting" the unlisted 11th domain, or is it missing?

**CAD Designer cannot carry an empty domain.** Row 5 of the table above is blank, and it
is the only blank domain in the sheet.

The evidence is unusually clean. `MASTER_CONTEXT` §23 opens with:

> **"11 domains, ~45 roles."**

The table immediately under that heading lists **ten**:

```
Machining & Cutting · Forming & Fabrication · Tooling, Die & Mould · Casting & Foundry
Heat Treatment & Finishing · Plastics & Polymer · Assembly & Integration
Quality & Inspection · Maintenance & Plant · Production Support & Supervision
```

An eleventh domain was intended and is not in the table. No listed domain accommodates
drafting work.

| Option                                                                 | What it means                                     | What it costs later                                                                                                                                                                                                                                           |
| ---------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **(a)** Design & Drafting **is** the 11th domain                       | Add it; CAD Designer and Draughtsman anchor there | One new domain means adjacency rows against the other ten. Config, not schema (§32) — cheap and reversible.                                                                                                                                                   |
| **(b)** CAD Designer folds into **Machining & Cutting**                | Sits beside CAM Programmer as a second desk role  | §24 mandates **domain-scoped vector search** for precision, warning that _"cutting means different things in metal, tailoring, and a salon."_ Drafting phrases would be searched inside a metal-cutting index. Precision loss on RVM's highest-volume supply. |
| **(c)** The 11th domain is something else; Design is genuinely missing | Name the real 11th, then decide CAD separately    | Blocks alias seeding for row 5 until resolved.                                                                                                                                                                                                                |

**Engineering recommends (a).** CAD Designer / Draughtsman is described in the sheet as
_"RVM's core student profile — highest-volume warm supply we own."_ A null domain on the
highest-volume role is not survivable, and this is the cheapest of the three to reverse.

```
RVM / CEO answer: ............................................................

.............................................................................
```

---

# Part 3 — Rulings R1 to R7

Each block: the question · concrete options · what each costs later · engineering's
recommendation · a signature line. **A recommendation is not a ruling.**

---

## R1 — One `skill_id` per role; ladders decompose into `(function, collar_tier)`

**Owner:** RVM / CEO · **Blocks:** everything in Part A of the execution spec

### The question

Spec §A0 states the design fork is already closed by §21 — one `skill_id` per role, with
`function` and `collar_tier` as modifiers — and that the Aug-9 sheet re-opened a settled
question. §A1 then says the Aug-9 ladders flatten **two orthogonal locked axes** into one
string:

- _CNC Turner:_ Operator → Setter → Setter-cum-Programmer → Programmer is **function**,
  all at one collar tier.
- _Welder:_ Helper → Welder → Certified Welder is **collar tier** plus a certification
  attribute.

Modelling both as "level" makes the locked adjacency multipliers unimplementable: you
cannot apply `operator→higher-tier 0.25` to a Helper→Senior Fitter pair and get anything
meaningful.

### What the code says today

The closed canonical role set at HEAD, in
[apps/ai-service/app/profiling/canonical_roles.py](../../apps/ai-service/app/profiling/canonical_roles.py),
still encodes the **pre-§A0 model** — functions as separate roles:

```
role_cnc_turner_operator      role_cnc_setter_operator   <-- function as a role
role_vmc_operator             role_cnc_programmer        <-- function as a role
role_hmc_operator             role_cam_programmer
role_cnc_grinding_operator    role_cnc_operator (generic)
role_welder
```

Two consequences worth pricing before you sign:

1. `role_cnc_setter_operator` and `role_cnc_programmer` are the `{Setting/Programming}`
   family that §A3 dissolves. Confirming A0 means **deprecating them**.
2. `role_vmc_operator` and `role_hmc_operator` are **two ids for one Aug-9 role** (CNC
   Machining Centre Operator, which the sheet says _"absorbs the old VMC Operator + HMC
   Operator; machine type is an attribute, not two roles"_).

§24 is explicit: **`skill_id` is immutable and never reused — deprecate, never delete,
never renumber.** So this is a one-way door on identifiers, though the adjacency
_multipliers_ remain config.

Also confirmed at HEAD: **no `function` or `collar_tier` column exists on any table yet**
(checked across `packages/db/src/`). Nothing is locked in by prior schema.

### Options

|         | Option                                                                                                                            | What it costs later                                                                                                                                                                                                                              |
| ------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **(a)** | Confirm §A0/§A1 as written. One `skill_id` per role; `function` + `collar_tier` become modifier columns; add `setter_programmer`. | Deprecate 4 live role ids (never delete). One migration adds the two columns. Adjacency becomes implementable as specified.                                                                                                                      |
| **(b)** | Keep level-as-role (today's code).                                                                                                | Resurrects a **dead idea** explicitly banned in the build rules. Role count grows ~4× as ladders expand; the directional multipliers `higher-tier→operator 0.85` / `operator→higher-tier 0.25` cannot be expressed at all.                       |
| **(c)** | Confirm §A0 but **without** `setter_programmer` — fold Setter-cum-Programmer into `setter`.                                       | Enum stays untouched at 9 values. But 3 of the 4 wedge roles list Setter-cum-Programmer as a real rung; those workers land on `setter` and are under-sold to programmer jobs. `function` is single-valued by lock, so there is no "both" escape. |

**Engineering recommends (a).**

### Sub-questions inside R1 — please answer all three

**(i) `Helper` maps to which collar tier — `elementary` or `semi-skilled`?**
It appears in **8 of 21 ladders** (Conventional Machinist, Welder, Fitter, Sheet Metal,
Assembly Line, Maintenance Tech, Industrial Electrician, Press/Machine Op, Blow Moulding,
Rubber Moulding). One answer settles all of them. Getting it wrong shifts the platform's
"too low for the platform" floor — §21 Axis B says collar tier is _"also how you decide
what's too low for the platform."_

```
Answer: ......................................................................
```

**(ii) `Trainee` / `Junior` — collar tier, or `function = apprentice`?**
Affects CAM Programmer, Tool & Die Maker, Mould/Die Maker. `apprentice` is a locked
`function` value, so both readings are legal.

```
Answer: ......................................................................
```

**(iii) A blank `function` defaults to `operator` (§21: _"operator (default)"_). Is that
right for desk roles?**
CAD Designer and Plastic Process Technician both have **no mappable function** (see
Unmapped rungs). Under the default they silently become "operators." Spec §A4 says a
worker with unknown function scores `0.85` and is surfaced as _"function not confirmed"_ —
never zero — so a genuine null is safe. A wrong default is not.

```
Answer: ......................................................................

Signed (RVM / CEO): .......................  Date: .................
```

---

## R2 — Re-cut the families; confirm the Tool & Die ↔ Plastics-Mould edge

**Owner:** RVM · **Blocks:** adjacency config, alias seeding

### The question

The locked family set is
`{Turning} {Milling: VMC, HMC} {Setting/Programming: Setter-Op, CNC Programmer, CAM Programmer} {Grinding} {Welding/Fab} {Moulding: injection, blow, extrusion}`.

`{Setting/Programming}` is an artifact of the older 45-role list where Setter-Operator and
CNC Programmer were separate roles. Under §21's function model they are not roles at all,
so that family dissolves — only CAM Programmer survives it, correctly, as a desk role with
entirely different Skills[]. **The build rules list `{Setting/Programming}` as a dead
idea.** The `proposed_family` column in Part 1 uses the §A3 re-cut, which is what this
ruling ratifies.

### Why family membership matters more than it looks

The locked adjacency multipliers are:

```
exact                             1.00
same family                       0.90   <--
same domain, function differs     0.85 x skill-overlap
adjacent domain                   0.45   <--
distant domain (same industry)    0.30
```

**Same-family is 0.90; adjacent-domain is 0.45.** Family membership is worth double. On a
0.35-weighted trade factor that is the single largest lever in the ranking.

### The highest-value cell in this document

Spec §A3 calls grouping **Tool & Die Maker** with **Mould / Die Maker (Plastics)** into one
`Tooling` family _"the highest-value judgement in the table: it is the one edge that
creates liquidity between the metal cluster and the plastics cluster."_

**It decides whether a tool-room worker sees moulding jobs.**

|         | Option                                                                                            | What it costs later                                                                                                                                                                                            |
| ------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **(a)** | Adopt the §A3 re-cut; **one `Tooling` family** holding both Tool & Die Maker and Mould/Die Maker. | A metal tool-room worker gets moulding jobs at 0.90 instead of 0.45. If the skills genuinely transfer this is free liquidity for the thin plastics cluster. If they do not, it is precision loss on the wedge. |
| **(b)** | Adopt the §A3 re-cut but **split** into `Metal Tooling` and `Plastics Tooling`.                   | Clean precision; the plastics cluster stays thin and isolated. Section 3 of the taxonomy sheet already flags plastics as over-weighted at 5 of 22 roles with low pan-belt volume — isolation makes that worse. |
| **(c)** | Keep the locked 6 families.                                                                       | Retains a **dead idea**. Not viable.                                                                                                                                                                           |

**Engineering recommends (a)**, with one reassurance: families live in config, not schema
(§32 puts adjacency multipliers outside the schema), so unlike `skill_id` this is
**reversible without a migration**. Spec §D step 2 proposes a `matching_catalog` table so
taxonomy churn becomes a data publish with RVM sign-off rather than a deploy.

```
Signed (RVM): .......................  Date: .................
```

---

## R3 — Is Design & Drafting the 11th domain?

**Owner:** RVM · **Blocks:** domain-scoped resolution, row 5 alias seeding

The full evidence is in **Question 2** above — `MASTER_CONTEXT` §23 says _"11 domains"_
and lists ten, and CAD Designer (row 5) is the only role in the sheet with no domain.
The options are restated inline so this block can be signed without scrolling.

|         | Option                                                                                        | What it costs later                                                                                                                                                                                                                                   |
| ------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **(a)** | Design & Drafting **is** the 11th domain. Add it; CAD Designer and Draughtsman anchor there.  | One new domain means adjacency rows against the other ten. Config, not schema (§32) — cheap and reversible.                                                                                                                                           |
| **(b)** | CAD Designer folds into **Machining & Cutting**, beside CAM Programmer as a second desk role. | §24 mandates domain-scoped vector search for precision, warning that _"cutting means different things in metal, tailoring, and a salon."_ Drafting phrases get searched inside a metal-cutting index — precision loss on RVM's highest-volume supply. |
| **(c)** | The 11th domain is something else and Design is genuinely missing.                            | Name the real 11th, then decide CAD separately. Blocks alias seeding for row 5 until resolved.                                                                                                                                                        |

**Engineering recommends (a)** — a null domain on the highest-volume role is not
survivable, and (a) is the cheapest of the three to reverse.

```
Signed (RVM): .......................  Date: .................
```

---

## R4 — The three role overlaps, and 21 vs 22

**Owner:** RVM · **Blocks:** `skill_id` allocation — **immutable, so this is one-way**

These three pairs will map the same worker to two different roles depending on phrasing.
`skill_id` is immutable and never reused (§24) — get it wrong and it cannot be cleanly
undone.

---

### R4-a · Press / Machine Operator **vs** Injection Moulding Operator

**The collision, from the sheet itself.** The Aug-9 attributes for **Press / Machine
Operator** read:

> Power press · **injection moulding** · general machine operation · tonnage

_"Injection moulding" is the entire scope of another role in the same list_ (row 17).

**Second, independent collision.** §23 does not have one "Press / Machine Operator" — it
has **two roles in two different domains**:

| §23 role                   | §23 domain                       |
| -------------------------- | -------------------------------- |
| Press/Stamping Operator    | Forming & Fabrication            |
| Machine Operator (General) | Production Support & Supervision |

The Aug-9 sheet merged them into a single row. That is why row 15's `proposed_domain` is
flagged.

**Colliding alias surface:** `machine operator` · `press ka kaam` · `machine chalana` ·
`moulding machine`. A worker saying _"machine operator hun"_ has no deterministic
destination today.

|         | Option                                                                                                                                        | What it costs later                                                                                                                                                         |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **(a)** | Strike "injection moulding" from Press/Machine Operator's attributes. Press/Machine Op = **metal forming only**; all moulding goes to row 17. | Cleanest. A press-shop worker who also runs a moulding machine needs two experience tags — which §21 already supports (_"every work experience is its own tagged record"_). |
| **(b)** | Split row 15 back into two roles per §23: Press/Stamping Operator + Machine Operator (General).                                               | 22 roles instead of 21 (interacts with Question 1). More precision, more alias budget, and `Machine Operator (General)` is a magnet for un-resolvable phrases.              |
| **(c)** | Leave as-is.                                                                                                                                  | Guaranteed silent mis-mapping on the most generic phrase a worker can say.                                                                                                  |

**Engineering recommends (a).**

```
RVM verdict: .................................................................
```

---

### R4-b · Plastic Process / Quality Technician **vs** Quality Inspector

**The collision.** Row 21's attributes are _"Process setting · parameter optimisation ·
rejection control · **in-process QC**."_ Row 9 (Quality Inspector / QC) is the QC role.

Spec §A2 puts it sharply: under the locked model, Plastic Process / Quality Technician is
_just QC with `function = inspector` in the Plastics domain_. **Two `skill_id`s for one
coordinate** — which is precisely what §21's `Industry → Domain → Role → Skills[] +
function` coordinate is designed to prevent.

Note also that row 21's ladder (**Technician → Process Engineer**) is **entirely unmapped**
— neither rung is a locked `function` value. It is the only role in the sheet with no
mappable function at all.

**Colliding alias surface:** `quality check karna` · `plastic qc` · `inspection ka kaam` ·
`rejection control`.

|         | Option                                                                                                                           | What it costs later                                                                                                                                                                                                   |
| ------- | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **(a)** | **Collapse.** Row 21 becomes Quality Inspector with `domain = Plastics & Polymer`, `function = inspector`. One `skill_id` freed. | Matches the locked coordinate exactly. Loses "process setting / parameter optimisation," which is genuinely _not_ QC work — that half may need to attach to row 17 (Injection Moulding, `function = setter`) instead. |
| **(b)** | **Keep separate**, and strike "in-process QC" from row 21's attributes so the QC surface belongs to row 9 alone.                 | Preserves the process-engineering identity. Costs one `skill_id` permanently and needs domain-scoped disambiguation at resolution (§24 mandates this anyway).                                                         |
| **(c)** | Keep both with overlapping attributes.                                                                                           | The same worker resolves to row 9 or row 21 depending on phrasing. Immutable and unrecoverable.                                                                                                                       |

Section 3 of the taxonomy sheet independently recommends _"consider merging the plastics
cluster from five roles into three,"_ naming this role as the collapse candidate — which
points toward **(a)**.

**Engineering recommends (a).**

```
RVM verdict: .................................................................
```

---

### R4-c · Tool & Die Maker **vs** Mould / Die Maker (Plastics)

**This one is already live in code.** The colliding aliases are seeded today, at
[packages/db/data/job-domains/rvm-aliases.jsonl](../../packages/db/data/job-domains/rvm-aliases.jsonl)
lines 411–415:

```json
411 {"kind":"alias","job_domain_id":"jd_nco_7222_0200","text":"टूल मेकर","lang":"hi"}
412 {"kind":"alias","job_domain_id":"jd_nco_7222_0200","text":"tool room","lang":"en"}
413 {"kind":"alias","job_domain_id":"jd_nco_7222_0200","text":"टूल रूम","lang":"hi"}
414 {"kind":"alias","job_domain_id":"jd_nco_7222_0200","text":"die maker","lang":"en"}
415 {"kind":"alias","job_domain_id":"jd_nco_7222_0200","text":"डाई मेकर","lang":"hi"}
```

`jd_nco_7222_0200` is the **metal tool room**. So **every worker who says "die maker" or
"डाई मेकर" today resolves to Tool & Die Maker (row 14). Mould / Die Maker (Plastics)
(row 18) has no path at all.** This is not a hypothetical — it is the current behaviour
at HEAD.

**A second conflict sits on row 18's domain.** §23 places `Mould Maker` under **Tooling,
Die & Mould**. The Aug-9 sheet files it under **Section 1D, the plastics & rubber
cluster**. The locked table and the sheet disagree about where this role lives, which is
why row 18's `proposed_domain` is flagged.

**Colliding alias surface:** `die maker` · `डाई मेकर` · `die banane ka kaam` ·
`mould`/`mold` spelling variants · `tool room`.

|         | Option                                                                                                                                                                                                                                                                                 | What it costs later                                                                                                                                                                                                    |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **(a)** | Keep both roles. Make the bare aliases **domain-scoped** at resolution (§24 already mandates domain-scoped search): `die maker` + metal/press context → row 14; `die maker` + plastics/moulding context → row 18. Seed unambiguous aliases (`mould maker`, `mould fitting`) to row 18. | Correct but not free: an ambiguous phrase with **no** context must still go somewhere. Needs a stated tie-break rule, and that rule needs a golden fixture.                                                            |
| **(b)** | Merge into one role with `domain` distinguishing them.                                                                                                                                                                                                                                 | One `skill_id` freed, no collision possible. But the Skills[] genuinely differ — EDM/spark erosion, mould polishing, hot-runner work are not metal die work. Real precision loss in the tool room, which is the wedge. |
| **(c)** | Leave as-is.                                                                                                                                                                                                                                                                           | Row 18 stays unreachable. Every plastics mould maker is filed as a metal tool maker.                                                                                                                                   |

**Engineering recommends (a)** — and notes it is inseparable from **R2**: if both roles sit
in one `Tooling` family (R2 option a), the cost of a mis-resolution drops sharply, because
the two roles then score `0.90` against each other rather than `0.45`. **Answering R2 (a)
makes R4-c materially safer.**

```
RVM verdict: .................................................................
```

---

### R4-d · Reconcile 21 vs 22

The full arithmetic is in **Question 1** above — 1A(4) + 1B(1) + 1C(11) + 1D(5) = 21
rows against the sheet's summary of 22, with the discrepancy in the Phase-2 count
(17 rows, not 18). Restated here because §A2 folds it into R4 and because **role count
drives `skill_id` allocation**, which is immutable. Options inline so this block can be
signed on its own:

|         | Option                                                                                      | What it costs later                                                                                                                                                                         |
| ------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **(a)** | A 22nd role exists and was dropped from 1B/1C/1D when the sheet was compiled. **Name it.**  | It gets a row, a `skill_id`, an alias budget and a golden fixture. Cheapest to do now — retrofitting a role after seeding means a fixture set that silently never covered it.               |
| **(b)** | There are 21 roles; the summary line is an arithmetic slip.                                 | The ~2,100-alias budget in spec §A5 (which assumes 21) stands unchanged, and this worksheet's 21 rows are the complete set.                                                                 |
| **(c)** | Row 15 splits into two per §23 (Press/Stamping + Machine Operator General), which makes 22. | Resolves Q1 and **R4-a** with one answer — but see R4-a, where `Machine Operator (General)` becomes a magnet for un-resolvable phrases. Do not pick (c) here without also picking R4-a (b). |

```
RVM verdict: .................................................................

Signed for all of R4 (RVM): .......................  Date: .................
```

---

## R5 — `role_welder` / TAX-WELD-1

**Owner:** CEO · **Blocks:** whether Welder ships

### ⚠ The spec's statement of current state is out of date. Please read this before ruling.

Spec §A10 says: _"`role_welder` ruling is open and TAX-WELD-1 means welders are currently
unmatchable."_

**At HEAD, welders are matchable.** TAX-WELD-1 was fixed and shipped in PR #412 (commit
`41d0cb7`, recorded at
[docs/ai/profiling-parser-coverage.md](../ai/profiling-parser-coverage.md) line 64). The
original incident — a welder saying _"TIG aur MIG machine chala leta hun"_ producing
`role=None, trade=None, skill_ids=[]` — is closed. The fix and its guard live in
`apps/ai-service/app/profiling/signals.py` (`_assign_welding_role`), covered by
[apps/ai-service/tests/test_welding_gazetteer.py](../../apps/ai-service/tests/test_welding_gazetteer.py).

The spec's own caveat asks for this check: _"Confirm against HEAD before committing
dates."_ Flagging it rather than following it silently.

### What is actually still open

Two things, both from the TAX-WELD-1 header comment:

1. **`role_welder` / `dom_welding` were added to the CLOSED role whitelist and are
   explicitly _"Flagged for review."_** Adding to a closed enumerated set is an RVM/CEO
   act, not an engineering one.
2. **The Hinglish welding vernacular is deliberately NOT shipped.** The header states:
   _"ZERO unratified Hinglish/vernacular alias ships active… Any further vernacular
   ('welding karta hun', 'welding wala kaam', 'gas wali welding') needs RVM ratification
   (ADR-0030 §7 gate (d)) and is NOT here."_ Only `welding ka kaam` is ratified, via the
   2026-07-16 wedge packet.

|         | Option                                                                                                       | What it costs later                                                                                                         |
| ------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| **(a)** | Ratify `role_welder` + `dom_welding` into the closed set, **and** ratify the three named vernacular phrases. | Welder is fully live. Recall improves on the phrases workers actually use.                                                  |
| **(b)** | Ratify the id only; hold the vernacular for the main seeding pass.                                           | Welder ships, but a worker saying _"welding karta hun"_ still misses. Recall gap on one of the highest-ITI-supply trades.   |
| **(c)** | Reject `role_welder` as a role; Welder becomes skill-only.                                                   | The acceptance criterion _"non-null role + trade"_ becomes unreachable for welders. Effectively removes Welder from the 21. |

**Engineering recommends (a).** Note the measured cost of a _wrong_ welder assignment,
already quantified in the test file: scoring one worker against a VMC/turner job with
`roleId` null vs `role_welder` showed an absolute drop of **0.1647** — because
`scoreRole` returns `0.4` for a null role ("trade not stated yet") but `0.0` for a
non-matching one ("different trade"). **Filling a null wrongly is strictly worse than
leaving it null.** That is the standard any new vernacular must meet.

```
Signed (CEO): .......................  Date: .................
```

---

## R6 — Payer-app scope and named owner

**Owner:** CEO / Prakash · **Blocks:** all of Part B on Flutter

### The question

Two locked facts collide. (1) The locked client surfaces are the worker Flutter app plus a
**Company/Agency Next.js web app** — yet `apps/payer-app` exists in the repo anyway.
(2) **Flutter IAP is an open CEO ruling**: Apple/Google take 15–30% of any in-app
purchase, which on a ₹40 unlock is up to ₹12 — off the north-star metric itself. The
standing instruction is that **zero IAP products exist in Play Console / App Store
Connect**, and the build rules make creating one a full stop.

|         | Option                                                                                                                                                                                         | What it costs later                                                                                                                                                                            |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **(a)** | **Draft-only.** The Flutter payer app drafts, edits and submits for verification; it never purchases. A paid band shows _"Complete on web"_ and issues a handoff code into payer-web checkout. | Zero IAP products created. The web↔Flutter posting flow can be built **now**, regardless of how the IAP ruling lands. This is the Netflix/Spotify pattern — manage on mobile, purchase on web. |
| **(b)** | Full posting including purchase.                                                                                                                                                               | Creates an IAP product. **This is a full stop under the build rules** and pre-empts an open CEO ruling. Not available to engineering.                                                          |
| **(c)** | No payer-app posting at all.                                                                                                                                                                   | Cross-device continuity (spec §B2) loses its mobile half. `apps/payer-app` stays in the repo unowned and undefined.                                                                            |

**Engineering recommends (a).**

### The ownership gap — this needs a name, not a shrug

Single-owner-per-app is a locked convention. Rishi owns the worker app; Prakash owns
payer-web and the ops console. **No one is currently named as owner of `apps/payer-app`.**
Spec §B7 flags that making it a posting surface without an owner violates that locked
convention and lands on Prakash, _"who is already standing risk #1."_

Per the current standing instruction that all execution runs through Prakash,
engineering's suggested name is **Prakash** — but naming an app owner is a CEO act, so
nothing is written on the line below.

```
Named owner of apps/payer-app: ...............................................

Signed (CEO): .......................  Date: .................
```

---

## R7 — Attributes as a reordering facet, or display-only?

**Owner:** CEO / RVM · **Blocks:** employer list UX

### The question

The taxonomy sheet locks attributes as **display-only**: _"Role and skill drive visibility
and rank; controller, axes, certifications, instruments, machine make and tonnage are
shown to the employer to inform the ₹40 unlock decision — never scored, never ranked."_

Spec §A8 argues that is correct as far as it goes, but incomplete: **display-only alone
means a Fanuc-only shop pays ₹40 to discover a Siemens operator.** That is a direct hit on
the hero health metric.

|         | Option                                                                                                                                                                                     | What it costs later                                                                                                                                                                                                  |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **(a)** | **Facet.** `?facet=controller:fanuc` → _same candidate set, same count_; matching candidates lead; badge reads _"14 of 62 match Fanuc."_ Never scored, never ranked, never removes anyone. | Satisfies _"relevance sorts, never blocks"_ while giving the employer what they need **before** spending. Config-driven per role from the closed attribute whitelist.                                                |
| **(b)** | Pure display-only (status quo).                                                                                                                                                            | The employer discovers the mismatch **after** paying. Repeat-unlock rate and the hero metric both absorb it.                                                                                                         |
| **(c)** | Hard filter.                                                                                                                                                                               | Violates _"relevance sorts, never blocks."_ Also shrinks lists below the 70-candidate floor where the hot tag is already suppressed for small-pool honesty — a filtered list of 6 is worse than a sorted list of 62. |

**Engineering recommends (a).** It is the only option that changes **order** without
changing **membership**, which is the line the locked principle actually draws.

```
Signed (CEO / RVM): .......................  Date: .................
```

---

# Part 4 — What engineering did NOT decide

Recorded so nobody downstream mistakes a proposal for a ruling.

- **No domain, family, function or collar tier was decided.** Every cell in Part 1 is a
  proposal; every `?` marks a judgement that is explicitly RVM's.
- **No new `function` value was invented.** Only `setter_programmer` appears, it comes
  from spec §A1, and it is marked invalid until R1 is signed.
- **No unmappable rung was force-fitted.** 15 rung groups are listed as unmapped rather
  than assigned a plausible-looking value.
- **No `skill_id` was allocated, renamed or deprecated.** R1 and R4 are one-way doors on
  identifiers and remain open.
- **No migration was written or run.** R1's `function` / `collar_tier` columns and §D
  step 2's `matching_catalog` table are downstream of these signatures.
- **The 21 vs 22 count was not resolved** — it is asked, with the arithmetic shown.

## Once this worksheet is signed

Per spec Part D, the ordered next steps are:

1. **R1–R7 closed** (this document).
2. **`matching_catalog` table** — one migration. Adjacency, families, function/collar
   multipliers and per-role attribute whitelists become **published config**, so taxonomy
   churn is a data publish with RVM sign-off rather than a deploy. Spec calls this _"the
   highest-leverage single change."_
3. **Shared tier resolver** + golden fixtures across all roles + `engine_version` bump.

Alias seeding (~2,100 total; ~105 role aliases from this worksheet) runs in parallel from
step 1 and is **on the critical path for anything to match at all**. It is RVM-corpus
work, not engineering work, and it is the single largest non-code dependency.
