# Trade Content Ratification Packet — 9 trades for RVM sign-off

> **HUMAN GATE — DRAFTED, PENDING RVM. NOT FINAL / NOT APPROVED.**
> Everything in this packet is **drafted by engineering** and **transcribed
> faithfully** from the source `.ts` files for RVM to read and ratify
> trade-by-trade. No trade in here is "final", "approved", or "signed off" until a
> named RVM reviewer records a **PASS** verdict against it (§4). Until then the
> content is *live as the Phase-1 default* but **provisional** — any RVM correction
> supersedes it. RVM ratification is a human judgement call on CNC/VMC trade
> accuracy; engineering cannot self-certify it.

**This is HANDOFF + GATE packaging, not new authoring.** The text below is copied
verbatim from the two source files (§6); nothing here is paraphrased, invented, or
re-worded. If a value reads oddly, it reads exactly that way in the source — flag
it to RVM rather than "fixing" it in this packet.

Assembled 2026-06-15. Owner of the gate: **RVM (CNC/VMC subject-matter review)**.
Owner of the drafts: Prakash / engineering.

This packet covers **9 of the 15 alpha trades** — the subset routed to RVM for this
sitting. The full 15-trade tracking matrix and per-role checklist live in the
companion register
[`trade-content-ratification.md`](./trade-content-ratification.md); update both in
the same sitting so they do not drift.

---

## 1. What RVM's PASS gates

RVM's **PASS** verdict against a trade is the gate. It is the single signal that
flips that trade's content from *provisional default* to *production-ready*.

- A PASS is a human judgement on **trade accuracy** for CNC/VMC and the rest of the
  alpha trade set. Green CI tests prove *presence and shape* only — **not** that the
  vocabulary, questions, or safety guidance are correct. Accuracy is exactly what
  this gate is for.
- A **CHANGES** verdict means the trade stays provisional; engineering applies the
  requested edits in the source files (§6), then the trade comes back for re-review.
- **Partial ratification is allowed.** RVM may PASS some trades and leave others
  pending in the same sitting. Each row is independent.

---

## 2. What ratification unlocks

Once a trade's row in the §4 checklist carries an **RVM PASS** (named reviewer +
date):

- **That trade's content becomes production-ready.** Its resume copy and interview
  kit may be used in **real worker resumes and real interview kits** — not just as a
  provisional default.
- **The alpha device verification may exercise that trade.** When all 9 trades in
  this packet are PASSed, alpha device verification may exercise **all 9 trades**
  end-to-end.

Until a trade is PASSed, it remains the **provisional Phase-1 default**: it renders
live (so the worker journey is unblocked), but it is explicitly *not* vouched-for,
and any RVM correction supersedes it. Because ratification is trade-by-trade, a
PASS on one trade unlocks only that trade — the others stay provisional until their
own PASS lands.

---

## 3. How to read each trade section

Each of the 9 sections below has two subsections — **Resume content** (from
`TRADE_CONTENT`) and **Interview kit** (from `INTERVIEW_KITS`) — rendered as
readable lists/tables.

**Template variables.** Some resume fields contain `{{role}}`, `{{years}}`, or
`{{primary_machine}}`. These are **not literal text** — the resume renderer
substitutes them at render time from the individual worker's confirmed profile
facts (`{{role}}` = the role title, `{{years}}` = years of experience,
`{{primary_machine}}` = the worker's primary machine). A fresher (no years) gets a
`fresher_phrases` summary instead of the experienced `summary_template`. The
vocabulary lists (`core_skills`, `machine_tools`, `inspection_tools`, `keywords`)
are a **trade vocabulary for ATS keywords and interview kits — not a per-worker
claim**; the renderer only ever shows the skills/machines a worker actually
selected.

**Documents to carry.** In the source, every kit's `documents_to_carry` starts from
a shared `COMMON_DOCS` baseline (expanded in full below). Some kits append extra
items — where they do, it is called out in that trade's section.

`COMMON_DOCS` (shared baseline, expanded):

1. Aadhaar card (original + photocopy)
2. ITI / Diploma certificates and marksheets
3. Experience / relieving letters (if any)
4. 2 passport-size photographs
5. Updated resume (BadaBhai resume printout)

---

## 4. Ratification checklist — one row per trade

**All verdict cells start EMPTY.** A trade is ratified only when its row carries an
explicit **PASS** in the RVM verdict column, with a reviewer name and date. Use
**CHANGES** (and fill "Changes requested") to send a trade back.

| Trade | Resume OK? | Kit OK? | RVM verdict (PASS / CHANGES) | Changes requested | Reviewer | Date |
| ----- | ---------- | ------- | ---------------------------- | ----------------- | -------- | ---- |
| CNC/VMC Setter (`cnc_vmc_setter`) | [ ] | [ ] |  |  |  |  |
| CNC Programmer (`cnc_programmer`) | [ ] | [ ] |  |  |  |  |
| VMC Programmer (`vmc_programmer`) | [ ] | [ ] |  |  |  |  |
| SolidWorks Designer (`solidworks_designer`) | [ ] | [ ] |  |  |  |  |
| AutoCAD Draftsman (`autocad_draftsman`) | [ ] | [ ] |  |  |  |  |
| Tool Room Technician (`tool_room_technician`) | [ ] | [ ] |  |  |  |  |
| Machine Operator (`machine_operator`) | [ ] | [ ] |  |  |  |  |
| Assembly Technician (`assembly_technician`) | [ ] | [ ] |  |  |  |  |
| Fitter (`fitter`) | [ ] | [ ] |  |  |  |  |

---

## 5. "Review harder" flags

These call out trades that warrant extra RVM scrutiny. They are **pointed asks, not
blockers** — and engineering has **not** changed any content to address them.

**Flag A — `machine_operator` is intentionally GENERIC.** Both its resume row and
its kit are deliberately broad and **machine-agnostic** — it is the catch-all
production-machine role, not a specific CNC/VMC seat. Its kit is the **least
trade-specific** of the nine (e.g. common questions ask "Which machines have you
operated? (conventional / CNC / drilling / grinding)" rather than naming a specific
machine). This is by design, not a gap. **RVM to confirm** the generic framing is
acceptable for this role and that nothing should be sharpened into a specific
machine context.

**Flag B — `autocad_draftsman` display-name spelling.** The `display_name` is
**"AutoCAD Draftsman"** — transcribed verbatim from `trade-content.ts`. **RVM to
confirm** whether the American **"Draftsman"** is correct or the British
**"Draughtsman"** is preferred. Note: `trade-content.ts` is the single source of the
display name and the kit mirrors it, so any rename must be made in
`trade-content.ts` first (out of scope for this packet — record the decision and
hand it to engineering).

**Thin / review-harder-on-transcription flags.** As the content was transcribed,
the following were noted as **comparatively thin or generic** and worth a harder
look. They are not asserted to be wrong — only flagged for RVM's closer judgement.

- **`machine_operator` (resume + kit) — thinnest of the nine.** The
  `inspection_tools` are only "Vernier caliper", "Measuring tape / scale", "Go/No-Go
  gauges", `safety_points` are two generic lines, and the kit's
  drawing/measurement questions stay at "read a basic work instruction or simple
  drawing" level. Consistent with Flag A (generic by design), but RVM should confirm
  this floor is acceptable for a real shop placement and not under-specified.
- **`autocad_draftsman` (resume) — light measurement/safety footing.** Its
  `inspection_tools` are only "Vernier caliper" and "Measuring tape / scale", and
  `safety_points` are desk-work lines ("Ergonomic workstation practices", "Accurate
  file/revision management") rather than shop-floor safety. Plausible for a drafting
  desk role, but RVM should confirm the framing fits how the role is actually hired
  in CNC/VMC shops.
- **`solidworks_designer` (resume) — desk-role safety framing.** `safety_points` are
  "Ergonomic workstation practices" and "Disciplined file/revision backups" — i.e.
  no shop-floor safety. Reasonable for a design seat; flagged so RVM consciously
  signs off the "safety = workstation discipline" interpretation rather than it
  passing unexamined.
- **General note for the programmer trades (`cnc_programmer`, `vmc_programmer`).**
  `core_skills` reference CAM software generically ("CAM software (Mastercam / Fusion
  / etc.)") and `cnc_programmer`'s `inspection_tools` include "CMM (basic
  awareness)". RVM to confirm the named tools and the "basic awareness" qualifier
  match how these roles are actually expected to perform.

No content was edited to resolve any of the above — they are surfaced for RVM, per
the gate.

---

## 6. Per-trade content (×9)

> Source of truth, copied verbatim:
> - Resume → [`apps/api/src/resume/trade-content.ts`](../../apps/api/src/resume/trade-content.ts) (`TRADE_CONTENT`)
> - Interview kit → [`apps/api/src/interview-kit/interview-kit-content.ts`](../../apps/api/src/interview-kit/interview-kit-content.ts) (`INTERVIEW_KITS`)

---

## 1. CNC/VMC Setter (`cnc_vmc_setter`)

### Resume content

| Field | Value |
| ----- | ----- |
| `display_name` | CNC/VMC Setter |
| `headline_template` | `{{role}}` *(template var — filled from profile at render time)* |
| `summary_template` | CNC/VMC Setter with `{{years}}` of experience in machine setting, tooling, and first-piece approval on `{{primary_machine}}`. *(template vars — filled from profile at render time)* |

**core_skills**
- Machine setting (CNC & VMC)
- Tooling selection & tool life management
- Fixture setup and alignment
- Program editing and offset correction
- First-piece inspection & approval

**machine_tools**
- CNC Lathe
- VMC
- Tool presetter
- Fixtures & vices

**inspection_tools**
- Micrometer
- Vernier caliper
- Bore gauge
- Dial indicator
- Slip gauges

**responsibilities**
- Set up CNC/VMC machines: tooling, offsets, fixtures, and program proving
- Approve first piece and hand over to operators for production
- Troubleshoot dimensional and surface-finish issues during runs
- Optimise cycle time and tool life to improve productivity

**safety_points**
- Lock-out / safe-setting practices before tooling changes
- PPE and machine-guard compliance
- Correct handling of cutting tools and inserts

**experience_phrases**
- Reduced setup time through standardised tooling
- Resolved tolerance issues at first-piece stage

**fresher_phrases**
- Operator progressing into a setting role; trained on tooling and offsets
- Diploma/ITI holder seeking a CNC/VMC setter opportunity

**certification_phrases**
- ITI (Machinist / Turner)
- CNC setting training certificate

**keywords:** setter, CNC, VMC, setting, tooling, first piece

### Interview kit

**overview**
A CNC/VMC Setter interview checks whether you can set machines independently:
tooling, offsets, fixtures, program proving, and first-piece approval before handing
over to operators. Expect questions on tool life, troubleshooting runs, and quality.

**common_questions**
- Which CNC and VMC machines have you set independently?
- Walk through your full setting sequence for a new job.
- How do you select tooling and manage tool life?
- How do you approve the first piece before production?
- How do you troubleshoot a dimensional or surface-finish issue during a run?

**practical_questions**
- How do you set work and tool offsets on a fresh setup?
- How do you mount and align a fixture for repeatability?
- How do you edit a program to correct an out-of-tolerance dimension?

**safety_questions**
- What safe-setting / lock-out practices do you follow before tooling changes?
- How do you handle cutting tools and inserts safely?
- What PPE and machine guards do you use during setup?

**drawing_measurement_questions**
- How do you read a drawing to plan the setting sequence?
- How do you use slip gauges and a dial indicator during setup?
- How do you verify a critical dimension on the first piece?

**skill_checklist**
- Machine setting (CNC & VMC)
- Tooling selection & tool-life management
- Fixture setup & alignment
- Program editing & offset correction
- First-piece inspection & approval

**revise_before**
- Full setting sequence (tooling, offsets, fixtures, proving)
- First-piece approval steps
- Tool-life and tooling selection basics
- Program editing and offset correction

**documents_to_carry:** `COMMON_DOCS` (the 5 shared baseline items in §3).

**common_mistakes**
- Saying you set machines when you only operated them
- Skipping the first-piece approval step
- Vague on tooling selection and tool life

**hinglish_note**
Tip: Setting ka pura sequence — tooling, offset, fixture, proving — step-by-step
samjhana. Sirf operate kiya hai to setting ka jhootha claim mat karna. First piece
approval aur safe-setting practice ki baat confident hoke bolna.

---

## 2. CNC Programmer (`cnc_programmer`)

### Resume content

| Field | Value |
| ----- | ----- |
| `display_name` | CNC Programmer |
| `headline_template` | `{{role}}` *(template var — filled from profile at render time)* |
| `summary_template` | CNC Programmer with `{{years}}` of experience writing and proving programs for turning/milling on `{{primary_machine}}`. *(template vars — filled from profile at render time)* |

**core_skills**
- G & M code programming
- CAM software (Mastercam / Fusion / etc.)
- Process planning & tooling selection
- GD&T interpretation
- Program proving and optimisation

**machine_tools**
- CNC Lathe
- CNC Milling / VMC
- Tool presetter

**inspection_tools**
- Micrometer
- Vernier caliper
- CMM (basic awareness)

**responsibilities**
- Develop CNC programs from drawings/models using G-code and CAM
- Plan operations, select tooling, and define cutting parameters
- Prove out programs on machine and optimise cycle time
- Document setup sheets and support operators/setters

**safety_points**
- Safe dry-run and single-block proving practices
- Awareness of collision/over-travel risks during proving

**experience_phrases**
- Cut cycle time through optimised tool paths
- Standardised setup sheets across part families

**fresher_phrases**
- Diploma/engineering graduate trained in CNC programming and CAM
- Seeking a first CNC programming role; strong on G-code and drawing reading

**certification_phrases**
- Diploma in Mechanical / Tool & Die
- CAM software training certificate

**keywords:** CNC, programmer, G-code, CAM, Mastercam, process planning

### Interview kit

**overview**
A CNC Programmer interview checks how you turn a drawing or model into a proven
program: process planning, tooling, G-code/CAM, and on-machine proving. Be ready to
explain post-processors, tool paths, and cycle-time optimisation.

**common_questions**
- Which CAM software have you used? (Mastercam / Fusion / etc.)
- How do you write and edit a program using G-code and M-code?
- How do you plan operations and select tooling from a drawing?
- What is a post-processor and why does it matter?
- How do you prove out a new program on the machine?

**practical_questions**
- How do you generate a tool path in CAM and verify it before posting?
- How do you set cutting parameters (speed, feed, depth) for a material?
- How do you optimise a program to reduce cycle time?

**safety_questions**
- How do you safely prove a program (dry run, single block)?
- How do you avoid collision and over-travel during proving?
- What do you check before letting an operator run your program?

**drawing_measurement_questions**
- How do you interpret GD&T to decide machining strategy?
- How do you read a model/drawing to extract programming features?
- How do you confirm a programmed dimension matches the part?

**skill_checklist**
- G & M code programming
- CAM software & tool-path generation
- Process planning & tooling selection
- Post-processor / setup sheets
- Program proving & cycle-time optimisation

**revise_before**
- G-code / M-code and CAM workflow
- Post-processor and setup-sheet basics
- Tool-path strategies and cutting parameters
- Safe program proving (dry run, single block)

**documents_to_carry:** `COMMON_DOCS` (the 5 shared baseline items in §3).

**common_mistakes**
- Listing CAM software you have only seen, not used
- Weak on post-processors and setup sheets
- Not mentioning safe proving (dry run / single block)

**hinglish_note**
Tip: Jo CAM software actually use kiya hai wahi batana. G-code, tool path aur
post-processor clearly samjhana. Program proving me dry run aur single block ki
safety baat zaroor bolna.

---

## 3. VMC Programmer (`vmc_programmer`)

### Resume content

| Field | Value |
| ----- | ----- |
| `display_name` | VMC Programmer |
| `headline_template` | `{{role}}` *(template var — filled from profile at render time)* |
| `summary_template` | VMC Programmer with `{{years}}` of experience programming and proving milling jobs on `{{primary_machine}}`. *(template vars — filled from profile at render time)* |

**core_skills**
- VMC programming (G & M codes)
- CAM software for milling
- Fixture and process planning
- Multi-tool setup definition
- Program optimisation

**machine_tools**
- Vertical Machining Center (VMC)
- Tool presetter
- Fixtures

**inspection_tools**
- Micrometer
- Height gauge
- Dial indicator

**responsibilities**
- Write and prove VMC programs from 2D/3D drawings and models
- Define tooling, fixtures, and cutting parameters for milling jobs
- Optimise tool paths to reduce cycle time and tool wear
- Prepare setup documentation for setters/operators

**safety_points**
- Safe program proving (dry run, single block)
- Collision and over-travel awareness during setup

**experience_phrases**
- Improved surface finish through optimised milling strategies
- Reduced setup errors with clear documentation

**fresher_phrases**
- Diploma/engineering graduate trained in VMC/milling programming
- Seeking a first VMC programming role; confident with CAM and drawings

**certification_phrases**
- Diploma in Mechanical
- CAM (milling) training certificate

**keywords:** VMC, programmer, milling, CAM, G-code, tool path

### Interview kit

**overview**
A VMC Programmer interview focuses on milling: writing and proving programs from
2D/3D drawings, defining fixtures and multi-tool setups, and optimising tool paths.
Be ready for CAM, G-code, and post-processor questions for milling.

**common_questions**
- Which CAM software do you use for milling programs?
- How do you write and prove a VMC program with G-code and M-code?
- How do you plan fixtures and a multi-tool setup for a milling job?
- What is a post-processor and how does it suit your VMC control?
- How do you optimise milling tool paths to reduce cycle time and tool wear?

**practical_questions**
- How do you build a milling tool path in CAM and verify it before posting?
- How do you set cutting parameters for a milling operation?
- How do you correct a program when a milled feature is oversize?

**safety_questions**
- How do you safely prove a milling program (dry run, single block)?
- How do you guard against collision and over-travel during setup?
- What do you confirm before handing the program to a setter/operator?

**drawing_measurement_questions**
- How do you read a milling drawing with multiple datums to plan operations?
- How do you interpret GD&T to choose a milling strategy?
- How do you confirm a programmed milled dimension on the first piece?

**skill_checklist**
- VMC / milling programming (G & M codes)
- CAM software & tool-path generation
- Fixture & multi-tool setup planning
- Post-processor / setup documentation
- Tool-path & cycle-time optimisation

**revise_before**
- Milling CAM workflow and G-code basics
- Post-processor for your VMC control
- Multi-tool setup and fixture planning
- Safe program proving (dry run, single block)

**documents_to_carry:** `COMMON_DOCS` (the 5 shared baseline items in §3).

**common_mistakes**
- Confusing turning programming with milling specifics
- Listing CAM software you have not actually used
- Not mentioning safe proving and collision awareness

**hinglish_note**
Tip: Milling-specific CAM aur tool path ki baat clearly karna. Multi-tool setup aur
fixture planning samjhana. Program proving me dry run, single block aur collision
safety ka dhyan zaroor mention karna.

---

## 4. SolidWorks Designer (`solidworks_designer`)

### Resume content

| Field | Value |
| ----- | ----- |
| `display_name` | SolidWorks Designer |
| `headline_template` | `{{role}}` *(template var — filled from profile at render time)* |
| `summary_template` | SolidWorks Designer with `{{years}}` of experience in 3D modelling, assemblies, and drawings. *(template var — filled from profile at render time)* |

**core_skills**
- SolidWorks part & assembly modelling
- Drawing detailing & GD&T
- Sheet metal / weldments (as applicable)
- Design for manufacturing
- Revision & configuration management

**machine_tools**
- CAD workstation (SolidWorks)

**inspection_tools**
- Vernier caliper
- Micrometer

**responsibilities**
- Model parts and assemblies in SolidWorks from inputs/specifications
- Produce manufacturing drawings with correct GD&T and tolerances
- Manage configurations and design revisions
- Support manufacturing with DFM feedback

**safety_points**
- Ergonomic workstation practices
- Disciplined file/revision backups

**experience_phrases**
- Built reusable, well-structured SolidWorks models
- Reduced drawing errors through standard templates

**fresher_phrases**
- Trained in SolidWorks modelling, assemblies, and drawings
- Seeking a first SolidWorks design role

**certification_phrases**
- SolidWorks (CSWA/CSWP) certification
- Diploma in Mechanical / Design

**keywords:** SolidWorks, 3D, modelling, assembly, drawing, design

### Interview kit

**overview**
A SolidWorks Designer interview checks parametric modelling, assemblies, drawing
detailing, and design-for-manufacturing. Be ready to discuss part/assembly
structure, configurations, GD&T, and how you keep models robust and easy to revise.

**common_questions**
- How do you build a robust parametric part model in SolidWorks?
- How do you create and mate a multi-part assembly?
- How do you produce a manufacturing drawing with correct GD&T?
- How do you use configurations and design tables?
- How do you manage revisions and design intent?

**practical_questions**
- Walk through modelling a bracket and detailing its drawing.
- How do you create a BOM from an assembly?
- How do you check mating parts for interference and fit?

**safety_questions**
- How do you back up and version-control your design files?
- How do you keep model structure clean so others can revise it?
- How do you maintain ergonomic workstation habits?

**drawing_measurement_questions**
- How do you apply a datum reference frame and position tolerance?
- What is the difference between bilateral and unilateral tolerance?
- How do you dimension a hole pattern and fits correctly?

**skill_checklist**
- SolidWorks parametric part modelling
- Assembly modelling & mates
- Drawing detailing & GD&T
- Configurations / design tables
- Revision & design-intent management

**revise_before**
- Parametric modelling and feature order (design intent)
- Assembly mates and interference checks
- GD&T and drawing detailing standards
- Configurations and BOM creation

**documents_to_carry:** `COMMON_DOCS` (the 5 shared baseline items in §3) **plus**
"Design portfolio / sample drawings (if available)".

**common_mistakes**
- Modelling without thinking about design intent / easy revisions
- Weak on GD&T and drawing detailing
- Saying you know features you have not actually used

**hinglish_note**
Tip: Parametric modelling aur design intent (feature order) clearly samjhana.
Assembly mates aur GD&T ke basics revise karke jana. Ho sake to apne sample
SolidWorks drawings dikhane ke liye le jana.

---

## 5. AutoCAD Draftsman (`autocad_draftsman`)

> **See Flag B (§5):** display name "AutoCAD Draftsman" transcribed verbatim — RVM
> to confirm Draftsman vs Draughtsman.

### Resume content

| Field | Value |
| ----- | ----- |
| `display_name` | AutoCAD Draftsman |
| `headline_template` | `{{role}}` *(template var — filled from profile at render time)* |
| `summary_template` | AutoCAD Draftsman with `{{years}}` of experience preparing accurate 2D drawings and layouts. *(template var — filled from profile at render time)* |

**core_skills**
- 2D drafting in AutoCAD
- Dimensioning & drawing standards
- GD&T basics
- Layout and detailing
- Drawing revision control

**machine_tools**
- CAD workstation (AutoCAD)
- Plotter

**inspection_tools**
- Vernier caliper
- Measuring tape / scale

**responsibilities**
- Prepare and update 2D drawings, layouts, and detailing in AutoCAD
- Apply dimensioning and drawing standards correctly
- Incorporate revisions and maintain drawing registers
- Coordinate with design/production teams

**safety_points**
- Ergonomic workstation practices
- Accurate file/revision management

**experience_phrases**
- Produced clean, standard-compliant drawings
- Maintained accurate drawing registers

**fresher_phrases**
- Trained in AutoCAD 2D drafting and detailing
- Seeking a first draftsman role

**certification_phrases**
- AutoCAD certification
- ITI/Diploma (Draughtsman Mechanical)

**keywords:** AutoCAD, draftsman, drafting, 2D, detailing, layout

### Interview kit

**overview**
An AutoCAD Draftsman interview checks 2D drafting accuracy, dimensioning and drawing
standards, GD&T basics, and layout/detailing discipline. Be ready to show how you
produce clean, standard-compliant drawings and manage revisions.

**common_questions**
- How long have you worked on 2D drafting in AutoCAD?
- How do you set up layers, dimension styles, and templates?
- How do you apply dimensioning and drawing standards correctly?
- How do you prepare a layout and detail views?
- How do you incorporate revisions and maintain a drawing register?

**practical_questions**
- How would you draft and detail a simple part drawing from a sketch?
- How do you use layers, blocks, and xrefs to keep a drawing organised?
- How do you scale and plot a drawing to the correct sheet size?

**safety_questions**
- How do you back up and manage drawing files and revisions?
- How do you avoid errors when reusing or updating old drawings?
- How do you maintain ergonomic workstation habits?

**drawing_measurement_questions**
- What are GD&T basics and how do you place them on a 2D drawing?
- What is the difference between bilateral and unilateral tolerance?
- How do you dimension correctly to avoid ambiguity?

**skill_checklist**
- 2D drafting in AutoCAD
- Dimensioning & drawing standards
- GD&T basics
- Layouts & detailing
- Drawing revision control

**revise_before**
- AutoCAD layers, dimension styles, blocks, and xrefs
- Dimensioning and drawing standards
- GD&T basics on 2D drawings
- Plotting/scaling and revision control

**documents_to_carry:** `COMMON_DOCS` (the 5 shared baseline items in §3) **plus**
"Sample drawings / portfolio (if available)".

**common_mistakes**
- Sloppy or ambiguous dimensioning
- Not using layers/standards, leading to messy drawings
- Weak on GD&T basics

**hinglish_note**
Tip: Layers, dimension style aur drawing standards ka clean use dikhana.
Dimensioning bina confusion ke karna aana chahiye. GD&T basics revise karke jana aur
ho sake to apne sample drawings le jana.

---

## 6. Tool Room Technician (`tool_room_technician`)

### Resume content

| Field | Value |
| ----- | ----- |
| `display_name` | Tool Room Technician |
| `headline_template` | `{{role}}` *(template var — filled from profile at render time)* |
| `summary_template` | Tool Room Technician with `{{years}}` of experience in tooling, jigs, fixtures, and precision machining. *(template var — filled from profile at render time)* |

**core_skills**
- Tool, jig & fixture making
- Grinding & precision machining
- Die/mould maintenance (as applicable)
- Fitting & assembly
- Precision measurement

**machine_tools**
- Surface grinder
- Cylindrical grinder
- Milling/lathe
- EDM (as applicable)

**inspection_tools**
- Micrometer
- Slip gauges
- Height gauge
- Dial indicator
- Sine bar

**responsibilities**
- Manufacture and repair jigs, fixtures, and tooling to tight tolerance
- Perform precision grinding and fitting operations
- Maintain dies/moulds and tool-room equipment
- Inspect tooling using precision instruments

**safety_points**
- Safe grinding-wheel handling and guarding
- PPE and precision-tool care

**experience_phrases**
- Produced precision tooling to tight tolerances
- Extended tool/die life through good maintenance

**fresher_phrases**
- ITI (Tool & Die Maker) seeking a first tool-room role
- Trained in grinding, fitting, and precision measurement

**certification_phrases**
- ITI (Tool & Die Maker)
- Tool-room training certificate

**keywords:** tool room, jig, fixture, die, grinding, precision

### Interview kit

**overview**
A Tool Room Technician interview checks precision: making and repairing jigs,
fixtures, and dies, grinding and fitting to tight tolerance, and accurate
measurement. Be ready to explain how you hold close tolerances and care for
tool-room equipment.

**common_questions**
- What jigs, fixtures, or dies have you made or repaired?
- Which grinding machines have you used (surface / cylindrical)?
- How do you hold a tight tolerance during precision machining?
- How do you do fitting and assembly of tooling?
- How do you maintain dies/moulds and tool-room equipment?

**practical_questions**
- How would you grind a component to a close tolerance?
- How do you set up a job using a sine bar and slip gauges?
- How do you fit and align mating parts of a fixture?

**safety_questions**
- How do you safely handle and dress a grinding wheel?
- What guarding and PPE do you use during grinding?
- How do you care for precision instruments and tooling?

**drawing_measurement_questions**
- How do you use slip gauges and a sine bar to set/check an angle?
- How do you measure with a micrometer and height gauge to close tolerance?
- How do you read a tooling/fixture drawing with tight tolerances?

**skill_checklist**
- Tool, jig & fixture making
- Grinding & precision machining
- Die/mould maintenance
- Fitting & assembly
- Precision measurement (slip gauges, sine bar)

**revise_before**
- Grinding setup and close-tolerance work
- Slip gauges, sine bar, and precision measurement
- Jig/fixture/die fundamentals
- Grinding-wheel safety and tool care

**documents_to_carry:** `COMMON_DOCS` (the 5 shared baseline items in §3).

**common_mistakes**
- Vague about the tolerances you can actually hold
- Not mentioning grinding-wheel safety
- Weak on precision-measurement instruments

**hinglish_note**
Tip: Jo jig/fixture/die banaya ya repair kiya hai uske examples ready rakhna. Tight
tolerance kaise hold karte ho aur slip gauge/sine bar ka use samjhana. Grinding
wheel ki safety ki baat zaroor bolna.

---

## 7. Machine Operator (`machine_operator`)

> **See Flag A (§5):** intentionally GENERIC / machine-agnostic — RVM to confirm the
> generic framing is acceptable. Also flagged as the **thinnest** of the nine.

### Resume content

| Field | Value |
| ----- | ----- |
| `display_name` | Machine Operator |
| `headline_template` | `{{role}}` *(template var — filled from profile at render time)* |
| `summary_template` | Machine Operator with `{{years}}` of experience operating production machines on `{{primary_machine}}`. *(template vars — filled from profile at render time)* |

**core_skills**
- Machine operation
- Reading work instructions
- Basic measurement & quality checks
- Production record keeping
- Shop-floor discipline (5S)

**machine_tools**
- Conventional/CNC machines
- Drilling/grinding machines

**inspection_tools**
- Vernier caliper
- Measuring tape / scale
- Go/No-Go gauges

**responsibilities**
- Operate machines as per work instructions to meet production targets
- Perform basic quality checks and report deviations
- Maintain output records and a clean, safe workstation
- Assist with loading, unloading, and material handling

**safety_points**
- PPE compliance and machine-guard awareness
- Safe material handling and housekeeping (5S)

**experience_phrases**
- Met production targets consistently
- Maintained good housekeeping and safety record

**fresher_phrases**
- Seeking a first machine-operator role; willing to learn
- Trained in basic machine operation and safety

**certification_phrases**
- ITI (any trade)
- Machine-operation training

**keywords:** machine, operator, production, operation, 5S

### Interview kit

**overview**
A Machine Operator interview checks whether you can run a production machine to work
instructions, do basic quality checks, keep output records, and follow safety and
housekeeping. Be ready for simple measurement and 5S questions.

**common_questions**
- Which machines have you operated? (conventional / CNC / drilling / grinding)
- How do you follow work instructions to run a job?
- How do you do basic quality checks on a part?
- What do you do when you notice a deviation or defect?
- How do you maintain production output records?

**practical_questions**
- Walk through starting a job from work instructions.
- How do you load and unload a job safely?
- How do you use a Go/No-Go gauge or vernier for a basic check?

**safety_questions**
- What PPE do you wear and which machine guards do you check?
- How do you handle material safely and keep a clean workstation (5S)?
- What do you do if the machine behaves abnormally?

**drawing_measurement_questions**
- How do you read a basic work instruction or simple drawing?
- How do you use a vernier caliper or measuring scale?
- How do you use a Go/No-Go gauge to accept or reject a part?

**skill_checklist**
- Machine operation
- Reading work instructions
- Basic measurement & quality checks
- Production record keeping
- Shop-floor discipline (5S)

**revise_before**
- Basic machine operation and loading/unloading
- Vernier caliper and Go/No-Go gauge usage
- Reading work instructions
- PPE, machine guarding, and 5S

**documents_to_carry:** `COMMON_DOCS` (the 5 shared baseline items in §3).

**common_mistakes**
- Saying you ran a machine you have not actually operated
- Not mentioning quality checks or reporting deviations
- Forgetting PPE / housekeeping (5S)

**hinglish_note**
Tip: Jo machine chala chuke ho sirf wahi bolna. Basic quality check aur deviation
report karna aana chahiye. PPE, machine guard aur 5S housekeeping ki baat confident
hoke bolna.

---

## 8. Assembly Technician (`assembly_technician`)

### Resume content

| Field | Value |
| ----- | ----- |
| `display_name` | Assembly Technician |
| `headline_template` | `{{role}}` *(template var — filled from profile at render time)* |
| `summary_template` | Assembly Technician with `{{years}}` of experience in mechanical assembly and fitment to specification. *(template var — filled from profile at render time)* |

**core_skills**
- Mechanical assembly & fitment
- Reading assembly drawings/BOM
- Use of hand & power tools
- Torque & fastening standards
- In-process quality checks

**machine_tools**
- Assembly fixtures
- Torque wrenches
- Hand & power tools

**inspection_tools**
- Vernier caliper
- Torque wrench
- Go/No-Go gauges

**responsibilities**
- Assemble components/sub-assemblies per drawings and BOM
- Apply correct torque and fastening standards
- Perform fitment and functional checks during assembly
- Report defects and maintain assembly records

**safety_points**
- Safe use of tools and lifting aids
- PPE compliance and ergonomic practices

**experience_phrases**
- Maintained quality and pace on the assembly line
- Reduced fitment errors through careful checking

**fresher_phrases**
- ITI/fresher seeking a first assembly role
- Trained in mechanical assembly and tool usage

**certification_phrases**
- ITI (Fitter / Mechanic)
- Assembly training certificate

**keywords:** assembly, fitment, technician, BOM, torque, sub-assembly

### Interview kit

**overview**
An Assembly Technician interview checks mechanical assembly and fitment to
specification: reading assembly drawings/BOM, correct torque and fastening, fitment
checks, and defect reporting. Be ready for hand/power tool and torque questions.

**common_questions**
- What kind of mechanical assembly and sub-assembly work have you done?
- How do you read an assembly drawing and BOM?
- How do you apply correct torque and fastening standards?
- How do you check fitment during assembly?
- How do you report defects and maintain assembly records?

**practical_questions**
- Walk through assembling a sub-assembly from a drawing and BOM.
- How do you set and use a torque wrench correctly?
- How do you verify fitment when two parts do not seat properly?

**safety_questions**
- How do you use hand and power tools and lifting aids safely?
- What PPE and ergonomic practices do you follow on the line?
- How do you handle components to avoid damage during assembly?

**drawing_measurement_questions**
- How do you read an assembly drawing and identify fastener/torque callouts?
- How do you use a torque wrench and a Go/No-Go gauge?
- How do you check a fitment dimension with a vernier caliper?

**skill_checklist**
- Mechanical assembly & fitment
- Reading assembly drawings / BOM
- Use of hand & power tools
- Torque & fastening standards
- In-process quality checks

**revise_before**
- Assembly drawing and BOM reading
- Torque and fastening standards
- Hand/power tool usage and safety
- Fitment and in-process quality checks

**documents_to_carry:** `COMMON_DOCS` (the 5 shared baseline items in §3).

**common_mistakes**
- Not applying correct torque / fastening standards
- Skipping fitment and in-process checks
- Weak on reading the assembly drawing / BOM

**hinglish_note**
Tip: Assembly drawing aur BOM padhna aana chahiye. Sahi torque aur fastening ka
dhyan rakhna — torque wrench ka use samjhana. Tool aur lifting ki safety ki baat
zaroor bolna.

---

## 9. Fitter (`fitter`)

### Resume content

| Field | Value |
| ----- | ----- |
| `display_name` | Fitter |
| `headline_template` | `{{role}}` *(template var — filled from profile at render time)* |
| `summary_template` | Fitter with `{{years}}` of experience in mechanical fitting, assembly, and maintenance. *(template var — filled from profile at render time)* |

**core_skills**
- Mechanical fitting & assembly
- Reading drawings
- Filing, drilling, tapping
- Alignment & fitment
- Use of hand & measuring tools

**machine_tools**
- Bench/vice
- Drilling machine
- Hand & power tools

**inspection_tools**
- Vernier caliper
- Micrometer
- Try square
- Feeler gauge

**responsibilities**
- Carry out fitting, assembly, and alignment as per drawings
- Perform filing, drilling, tapping, and finishing operations
- Assist in installation and maintenance of equipment
- Check fitment with measuring tools and correct as needed

**safety_points**
- Safe use of hand and power tools
- PPE compliance and good housekeeping

**experience_phrases**
- Delivered accurate fitting and assembly work
- Supported smooth installation and maintenance

**fresher_phrases**
- ITI (Fitter) seeking a first fitting role
- Trained in fitting, drilling, and assembly fundamentals

**certification_phrases**
- ITI (Fitter)
- Apprenticeship (NCVT/SCVT)

**keywords:** fitter, fitting, assembly, maintenance, ITI, mechanical

### Interview kit

**overview**
A Fitter interview checks bench and fitting skills: filing, drilling, tapping,
alignment and fitment to drawing, and use of hand and measuring tools. Be ready for
practical bench-work questions and tool-safety questions.

**common_questions**
- What fitting, assembly, and alignment work have you done?
- How do you do filing, drilling, and tapping operations?
- How do you read a drawing and check fitment?
- How do you align mating parts or assemblies?
- What hand and measuring tools do you use regularly?

**practical_questions**
- Walk through filing a surface flat and checking it with a try square.
- How do you drill and tap a hole to the correct size?
- How do you align two parts and check the fit?

**safety_questions**
- How do you safely use hand and power tools at the bench?
- What PPE do you wear and how do you keep good housekeeping?
- How do you handle sharp edges and swarf safely?

**drawing_measurement_questions**
- How do you read a drawing to plan a fitting job?
- How do you use a try square, feeler gauge, and vernier caliper?
- How do you check flatness or a clearance during fitting?

**skill_checklist**
- Mechanical fitting & assembly
- Reading drawings
- Filing, drilling, tapping
- Alignment & fitment
- Use of hand & measuring tools

**revise_before**
- Bench work: filing, drilling, tapping
- Alignment and fitment checks
- Try square, feeler gauge, and vernier usage
- Hand/power tool safety and housekeeping

**documents_to_carry:** `COMMON_DOCS` (the 5 shared baseline items in §3).

**common_mistakes**
- Vague on actual bench-work skills (filing, tapping, alignment)
- Not mentioning measuring-tool checks for fitment
- Forgetting tool safety and housekeeping

**hinglish_note**
Tip: Bench work — filing, drilling, tapping aur alignment — practically samjhana.
Try square aur feeler gauge se fitment check karna aana chahiye. Hand aur power tool
ki safety ki baat zaroor bolna.

---

## Cross-references

- Companion tracking register (full 15-trade matrix + per-role checklist):
  [`trade-content-ratification.md`](./trade-content-ratification.md). Keep this
  packet and that register in sync — record each RVM PASS/CHANGES verdict in both.
- Resume content source:
  [`apps/api/src/resume/trade-content.ts`](../../apps/api/src/resume/trade-content.ts)
  (`TRADE_CONTENT`; also the single source of every trade's `display_name`).
- Interview-kit content source:
  [`apps/api/src/interview-kit/interview-kit-content.ts`](../../apps/api/src/interview-kit/interview-kit-content.ts)
  (`INTERVIEW_KITS`; `COMMON_DOCS` baseline; `REQUIRED_KIT_TRADE_KEYS`).
- Tech debt: [TD24a](./tech-debt-register.md) — per-trade content is curated static
  copy (no LLM); this packet is part of its content-review gate.
- Content invariant: per-trade content is **deterministic, static, reviewed copy —
  no LLM**, and PII-free (per-trade, never per-worker).
