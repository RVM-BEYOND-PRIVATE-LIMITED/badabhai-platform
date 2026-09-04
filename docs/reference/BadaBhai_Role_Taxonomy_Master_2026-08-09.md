> **NOT AN AUTHORITY. Historical snapshot. ADR-0036 (Accepted 2026-07-31) supersedes parts of
> this. Verify every claim against HEAD and against `docs/decisions/` before acting on it.**
>
> **Provenance.** Committed 2026-09-04 from `BadaBhai_Role_Taxonomy_Master.pdf` (compiled
> 2026-08-09), which was never in the repository. It is the third document
> `docs/reference/BadaBhai_MVP_Matching_and_Posting_Execution_Spec_2026-09-01.md` names under
> "Grounded in", and the source of the role list, the level ladders and the adjacency reasoning
> that the phase briefs were written from.
>
> **Converted, not re-typed.** Text is extracted from the PDF in layout mode: the tables below
> keep their original column alignment as fixed-width text inside ```` ```text ```` blocks rather
> than being re-cut into Markdown tables. No cell was retyped, so no cell boundary was guessed.
> `<!-- PDF page N of 9 -->` markers keep every line traceable to a page of the original.
>
> **KNOWN-SUPERSEDED CLAIMS:**
>
> 1. **The "level ladder" column conflates two separate locked axes.** §1A gives CNC Turner as
>    *Operator → Setter → Setter-cum-Programmer → Programmer*, which is the **function** enum at
>    one collar tier. §1C gives Welder as *Helper → Welder → Certified Welder*, which is
>    **collar tier** plus a certification attribute. One string, two axes. A CNC Setter and a CNC
>    Operator are the same tier and different function; a Helper Welder and a Certified Welder are
>    the same function and different tier. Decompose to `(function, collar_tier)` before using any
>    ladder in this sheet — the execution spec's §A1 says the same thing at more length.
> 2. **The role count is wrong, and the correct answer is now ruled.** "How to read this" says
>    "the 22 roles already in our plan (4 launch + 18 Phase 2)" and the §1D footer repeats "Total
>    already planned: 22 roles". Counting the rows in §1A–§1D gives **21** — 4 + 1 + 11 + 5; the
>    Phase 2 half is 17, not 18. The owner ruled **21** on 2026-09-04, on R4-d option (a): a row is
>    not split to make a number match, because that fits the taxonomy to the summary rather than to
>    the trade.
>    **Note the paper trail is incomplete.** That ruling is recorded in the phase briefs on PR
>    #1416; the signature line under R4 in `docs/decisions/RVM_TAXONOMY_WORKSHEET_2026-09.md`
>    ("Signed for all of R4 (RVM)") is **still blank on `main`**. Per `docs/agent/BUILD_RULES.md`
>    an unsigned worksheet ruling is a HALT, so an agent reading only the worksheet will still
>    halt on R4 until that line is filled in.
> 3. **Section 2's relevancy scores are research, not a plan.** They are explicitly "roles NOT in
>    our plan", scored against 2025–26 vacancy research. Nothing in Section 2 is committed work.
>
> Where this document and a signed ADR disagree, **the ADR wins.** Where it and the code at HEAD
> disagree about what exists, **the code is the fact.**

---

<!-- PDF page 1 of 9 -->

BadaBhai — Industrial Role Taxonomy: Master Sheet

Every industrial role considered for the platform — what we have planned (Phase 1 & 2), and what research says we are missing, with relevancy
scores. Compiled 2026-08-09 from the locked trade canon plus 2025–26 India skill-gap and vacancy research. Confidential.

How to read this. Section 1 = the 22 roles already in our plan (4 launch + 18 Phase 2), restructured so that level (Operator → Setter →
Setter-cum-Programmer → Programmer) is a selectable attribute, not a separate role. Section 2 = roles NOT in our plan, each scored 1–10 on relevancy to
BadaBhai specifically. Section 3 = deprioritisation candidates inside our own list. Section 4 = the recommended final structure.

Relevancy score = a blend of four things: hiring volume / unfilled vacancies in India · severity of the skill gap · concentration in our three belts
(Delhi-NCR/Faridabad, Pune, Ahmedabad-Gujarat) · and machining adjacency (how close the role sits to the CNC/tool-room wedge we are launching with
— this is weighted heaviest, because adjacency means the same employers, the same estates, the same telecaller list).

## Section 1 — Roles ALREADY in our plan

Status legend: P1 = Phase 1 launch wedge (deep alias seeding, jobs sold against these) · P2 = Phase 2 built trade (vocabulary pack, resume + waitlist, no
cold rejection).

### 1A · Phase 1 — The launch wedge (4 roles, collapsed from the original 7)

```text
          Role                             Level ladder (selectable)                  Attributes (display-only)                            Note

  P1      CNC Turner                       Operator → Setter →                        Controller (Fanuc / Siemens / Haas / Mitsubishi) ·   Absorbs the old “CNC Turner/Operator” + “CNC
                                           Setter-cum-Programmer →                    live tooling · bar feeder · materials                Setter-Operator” + “CNC Programmer” — level is
                                           Programmer                                                                                      now a chip, not a role.

  P1      CNC Machining Centre             Operator → Setter →                        VMC / HMC · 3 / 4 / 5-axis · controller · pallet &   Absorbs the old “VMC Operator” + “HMC
          Operator                         Setter-cum-Programmer →                    tombstone work                                       Operator”. Machine type is an attribute, not two
                                           Programmer                                                                                      roles.

  P1      CNC Grinding Operator            Operator → Setter →                        Cylindrical / surface / centreless · CNC vs          Unchanged from the original 7. Scarce skill, strong
                                           Setter-cum-Programmer                      conventional                                         tool-room adjacency.

  P1      CAM Programmer                   Junior → Programmer → Senior               Mastercam / EdgeCAM / NX / PowerMill /               Stays a separate role — it is a desk role, not a
                                           Programmer                                 SolidCAM · post-processors · CAD model handling      machine role.
```

### 1B · Phase 2 — Design & drafting

<!-- PDF page 2 of 9 -->

```text
         Role                                  Level ladder                                     Attributes                                                    Note

P2       CAD Designer /                        Draughtsman → CAD Designer →                     AutoCAD / SolidWorks / CATIA / Creo / NX / Fusion             RVM’s core student profile — highest-volume warm
         Draughtsman                           Design Engineer                                  · 2D drafting vs 3D modelling vs assembly ·                   supply we own. Freshers are first-class here
                                                                                                GD&T; · sheet-metal & mould design modules                    (“Fresher” is a status chip, not an absence).
```

<!-- PDF page 3 of 9 -->

### 1C · Phase 2 — Metal fabrication, assembly & maintenance

```text
           Role                                       Level ladder                                          Attributes

  P2       Conventional Machinist                     Helper → Operator → Skilled                           Lathe / milling / drilling / boring · manual measurement

  P2       Welder                                     Helper → Welder → Certified Welder                    MIG / TIG / Arc / Spot / Gas · certification · material & thickness

  P2       Fitter                                     Helper → Fitter → Senior Fitter                       Mechanical / assembly / maintenance fitting · blueprint reading

  P2       Quality Inspector / QC                     Inspector → QC Engineer                               Vernier / micrometer / height gauge / CMM · GD&T; · documentation & reporting

  P2       Sheet Metal Worker                         Helper → Operator → Skilled                           Laser / plasma cutting · press brake · punching · fabrication

  P2       Assembly Line Worker                       Helper → Operator → Skilled                           Sub-assembly · final assembly · testing · torque tools

  P2       Maintenance Technician                     Helper → Technician → Senior Technician               Mechanical / electrical / hydraulic / pneumatic · preventive vs breakdown

  P2       Industrial Electrician                     Helper → Electrician → Senior                         Panel wiring · PLC exposure · motor & drive work · licence

  P2       Tool & Die Maker                           Trainee → Tool Maker → Senior                         Tool room · die making · jigs & fixtures · grinding & fitting

  P2       Press / Machine Operator                   Helper → Operator → Setter                            Power press · injection moulding · general machine operation · tonnage

  P2       Painter / Powder Coating                   Helper → Operator → Skilled                           Spray · powder coating · surface prep · booth work
```

### 1D · Phase 2 — Plastics & rubber cluster

```text
           Role                                       Level ladder                                          Attributes

  P2       Injection Moulding Operator                Operator → Setter → Setter-cum-Process                Machine make (Ferromatik / Windsor / Haitian / Toshiba) · tonnage · materials
                                                      Technician                                            (ABS/PP/PC/Nylon) · robot take-out

  P2       Mould / Die Maker (Plastics)               Trainee → Mould Maker → Senior                        Mould fitting · polishing · EDM / spark erosion · mould type (2-plate / 3-plate / hot runner)

  P2       Blow Moulding / Extrusion                  Helper → Operator → Setter                            Blow moulding · pipe / sheet / film extrusion · blown film · machine make
```

Operator

```text
  P2       Rubber Moulding /                          Helper → Operator → Setter                            Compression / transfer / injection rubber · mixing mill & kneader · product type
```

Compression Operator

```text
  P2       Plastic Process / Quality                  Technician → Process Engineer                         Process setting · parameter optimisation · rejection control · in-process QC
```

Technician
Total already planned: 22 roles — 4 in the Phase 1 launch wedge, 18 in Phase 2.

<!-- PDF page 4 of 9 -->

## Section 2 — Roles NOT in our plan, with relevancy scores

Scoring guide. 9–10 = add now · 7–8 = add soon / staged · ≤6 = separate vertical or skip. Adjacency is weighted heaviest: a role in the same tool
room as our wedge is worth more to us than a bigger role in a different industry, because it reuses the same employers, the same industrial estates and the
same telecaller list.

### 2A · Score 9–10 — Add now (wedge-adjacent, severe shortage)

```text
Scor     Role                                   Cluster                      Machining       Why this score — evidence & reasoning
  e                                                                          adjacency

 10      CNC Wire-Cut / EDM                     Machining-adjacent            Very High      The most surprising omission in our own list — wire-cut and sinker EDM sit inside the same tool room
         Operator                               specialist                                   as our CNC roles, on the same shop floor, employed by the same customers. Live vacancies across
```

Delhi-NCR (Jahangirpuri, Sonipat), Pune and Chennai; typically ITI-qualified; ₹9–15K/month junior rising
to programmer level. Zero new geography, zero new buyer — it is a wedge extension, not a
diversification.

```text
  9      PLC / SCADA / Industrial               Automation &                     High        Every modernising machine shop, press shop and assembly line now runs PLC-controlled equipment, and
         Automation Technician                  electrical                                   CNC shops increasingly integrate automation cells — so this sits directly beside our wedge. ~495 live
```

“PLC SCADA” openings in a single Glassdoor snapshot (Sept 2025); freshers ~₹20K/month, experienced
far higher. India installed a record 8,510 industrial robots in 2023, up 59% YoY (IFR World Robotics
2024), with automotive installs up 139%. Industry sources repeatedly cite a shortage of experienced
automation specialists. Present in all three belts.

```text
  9      Heat-Treatment Technician              Foundry & heat                   High        Directly serves tool rooms and machining shops — tool steels, gears and dies must be hardened,
         / Furnace Operator                     treatment                                    tempered or carburised, so this role is a mandatory downstream step for our own customers’ parts.
```

Niche, scarce, and almost never trained at ITI scale. Small supply, guaranteed demand wherever tool
rooms exist.

### 2B · Score 7–8 — Add soon (volume & liquidity, or high-growth bets)

```text
Scor     Role                                   Cluster                      Machining       Why this score — evidence & reasoning
  e                                                                          adjacency

  8      Production Supervisor /                Production support             Medium        Taggd’s India Decoding Jobs 2026 explicitly names supervisor shortages as a cause of prolonged
         Line Leader                                                                         manufacturing hiring cycles. ~₹21K/month for shop-floor supervisors (Indeed India), far higher with
```

experience. Strategic value beyond volume: it is the natural career ladder for our own CNC
candidates — an up-level role that keeps a worker on the platform for a decade instead of one
placement.

```text
  8      Forklift / Material-Handling           Material handling             Low-Med        One of TeamLease’s fastest-growing blue-collar roles (material handler +10.0% in the FY25–26 Primer,
         Operator                                                                            from 1,308 companies across 23 sectors). ₹15–25K/month; ~₹19.5K average (Indeed India). Enormous
```

requisition volume in every factory and warehouse in all three belts, and the licence requirement creates
a genuine skill gate. Our single highest-liquidity support role — fast fills, frequent repeats.

<!-- PDF page 5 of 9 -->

```text
Scor     Role                                     Cluster                       Machining        Why this score — evidence & reasoning
  e                                                                             adjacency

  8      Foundry / Casting Worker                 Foundry & heat                 Med-High        India has ~4,500–5,000 foundries, mostly MSME across ~17 clusters — the world’s second-largest
         (moulder, furnace,                       treatment                                      castings producer — employing ~500,000 directly and ~1.5M indirectly (IIF). Castings are machined
         die-casting)                                                                            downstream, so these employers are literally our customers’ neighbours. Furnace operator
```

~₹22.4K/month; die-casting adverts ₹27–30K. Rajkot-Gujarat and Pune are major clusters — exact belt
fit.

```text
  8      EHS / Safety Officer                     Production support             Low-Med         Structural, regulation-driven deficit: the National Safety Council estimates India has under 100,000
```

certified safety officers for a 500M+ workforce, and NEBOSH India registrations grew 40% (2021–24).
Manufacturing pay ₹26–55K/month; freshers ₹18–28K. Mandated by the Factories Act — every plant
must have one, which makes demand evergreen and non-discretionary.

```text
  7      Robotics / Mechatronics                  Automation &                      High         Distinct from the graduate “robotics engineer” — this is the shop-floor technician who tends, teaches
         Technician                               electrical                                     and maintains robotic weld and pick-place cells. India’s industrial-robotics market is projected to grow
```

~15.9% CAGR (2026–34, IMARC). Auto-sector sources note courses in mechatronics, automation and
robotics “remain scarce, while there is a shortage of qualified trainers.” Pairs naturally with PLC/SCADA
— build both or neither.

```text
  7      Electroplating /                         Foundry & surface               Medium         Surface finishing of machined and pressed parts — another mandatory downstream step for our
         Surface-Treatment /                      treatment                                      customers’ output. Present across all three belts, heavily MSME. Lower profile than foundry, but same
         Anodising Operator                                                                      logic: the part leaves the CNC machine and goes here.

  7      EV Battery Pack / Module                 EV / new-age                    Medium         EV jobs projected ~25% CAGR to 2030 with 500,000+ EV-specific roles required; under 3% of India’s
         Assembly Technician                                                                     automotive workforce has any EV exposure and only about a third of EV job categories overlap with
```

ICE skills (OMI Foundation). TeamLease ranks EV & EV Infrastructure the #1 sector for pay growth
(+11.3%). Build-out concentrated in Gujarat, Pune (Chakan/Talegaon) and NCR — our exact belts.
Scored 7 not 9 only because volume is still ramping.

```text
  7      Motor Winding / EV                       EV / new-age                    Medium         Same driver as above; ACMA’s DG names “battery systems, power electronics and embedded software”
         Powertrain Assembly                                                                     as the acute gap areas, noting the issue is “not only availability of talent, but also the speed at which
         Technician                                                                              workers can be reskilled and deployed at scale.” Add alongside battery assembly, not separately.

  7      Forging / Press-Forge                    Foundry & heat                  Medium         Auto-component forging shops are dense in NCR and Pune and feed the same machining supply chain.
         Operator                                 treatment                                      Solid adjacency, moderate volume — add when foundry capacity is built, not before.
```

<!-- PDF page 6 of 9 -->

### 2C · Score 4–6 — Separate vertical, or optional breadth

```text
Scor     Role                                  Cluster                     Machining       Why this score — evidence & reasoning
  e                                                                        adjacency

  6      Store / Inventory /                   Production support              Low         Ubiquitous and high-churn, so it fills fast and repeats often — good platform liquidity, weak
         Warehouse Keeper                                                                  differentiation. Add for breadth once the core is live; it will never be a reason an employer chooses us.

  6      HVAC / Refrigeration                  Machining-adjacent            Low-Med       ~₹22K/month (PayScale/Indeed India), with one industry source citing +18% YoY demand. Genuinely
         Technician                            (loose)                                     high volume — but the buyer is often a service contractor or building operator, not our factory owner.
```

Optional breadth only.

```text
  5      Boiler Operator                       Process industry                Low         Licensed under state Boiler Acts, so demand is evergreen and gated — but concentrated in process and
```

heavy industry rather than machining. Niche add at best.

```text
  5      SMT Line Operator                     Electronics / EMS               Low         Huge policy-backed volume (see box below) but EMS-specific skills, EMS-specific geography (Noida, Sri
```

City, Gujarat) and no overlap with our machining buyer. ₹18.6K/month (Indeed India). Only pursue as a
deliberate separate vertical.

```text
  5      PCB Assembly / Electronics            Electronics / EMS               Low         No dedicated India benchmark exists — resolves to generic “assembly operator” (₹15.1K/month, Indeed
         Assembly Operator                                                                 India). Same vertical logic as SMT.

  4      Soldering / Rework                    Electronics / EMS               Low         Median ~₹15.5K/month on a very small Glassdoor sample (n=4). Thin data, low adjacency, low pay —
         Technician                                                                        lowest priority of everything researched.
```

On the electronics/EMS cluster — why big numbers still scored low. India’s electronics production grew roughly six-fold from ₹1.9 lakh crore
(2014-15) to ₹11.3 lakh crore (2024-25), and the ₹22,919 crore Electronics Components Manufacturing Scheme is projected to add ~91,600 direct jobs
(Invest India). A TeamLease projection suggests electronics could generate 12 million jobs by 2027. These are the largest raw numbers in the entire
research — and they still score 4–5 for us, because relevancy is not the same as size. An SMT operator in a Noida electronics park shares no employer, no
estate, no skill vocabulary and no telecaller with a VMC setter in Faridabad. Chasing it would mean building a second company. Treat EMS as a deliberate
future vertical with its own trigger: a named anchor customer (Dixon, Kaynes, Amber, or a Tata Electronics supplier) asking for volume hiring. Note also that
these are forward-looking government and industry projections, not achieved employment.

<!-- PDF page 7 of 9 -->

## Section 3 — Deprioritisation candidates inside our own 22

The research flags one structural imbalance in our current plan: the plastics/rubber cluster is 5 of 22 roles — nearly a quarter of the taxonomy
serving one sector — while automation, foundry and material-handling, which dominate actual unfilled-vacancy data, have zero. These are candidates to
demote, not delete.

```text
Role (currently in plan)                     Recommendation             Reasoning

Rubber Moulding / Compression                Lowest priority            The narrowest niche in our list — concentrated in specific rubber-goods clusters with low pan-belt volume. Keep the
Operator                                                                vocabulary pack so nobody is turned away; do not invest in demand-side selling.

Blow Moulding / Extrusion Operator           Demote                     Packaging-specific and materially lower volume than injection moulding. Deprioritise behind Injection Moulding
```

Operator, which carries the polymer cluster.

```text
Plastic Process / Quality Technician         Consider collapsing        Consider merging the plastics cluster from five roles into three — Injection Moulding Operator, Mould/Die Maker, and
```

Plastic QC — and reallocating the freed slots to automation, foundry and EDM.

```text
Painter / Powder Coating                     Keep, rank lower           Genuine demand and real adjacency (it finishes our customers’ parts), but rank it below the automation and foundry
```

additions when allocating build effort.

The ITI supply signal — why the “big” trades are not where our margin is
ITIs run 95 engineering trades under DGT/MSDE, and ~81% of sanctioned seats are in engineering. The highest-volume, best-supplied trades are Fitter,
Electrician, Welder, Turner, Machinist and COPA — which overlaps directly with four roles already in our Phase 2 list. That means those are
commodity-supply trades: easy to fill, low scarcity, low differentiation, and therefore lower willingness to pay for access. The acute-shortage roles are the
ones ITIs under-produce — automation/mechatronics (trainers are scarce), EV and battery, heat-treatment, EDM/wire-cut, and foundry. Even in “commodity”
welding the mismatch is real at the certified end: the Indian Institute of Welding estimated a shortfall of 1.2 million welding professionals (2020), expected to
reach 1.35 million within three years. And ITI employability stood at 45.95% in the India Skills Report 2025 — graduation volume is not job-ready supply.
Implication for pricing and positioning: our value to an employer is highest exactly where ITI supply is thinnest.

<!-- PDF page 8 of 9 -->

## Section 4 — Recommended final structure

```text
   Stage          Intent                              Roles                                                           Rationale & escalation trigger

  STAGE 1         Add to the launch wedge now         CNC Wire-Cut / EDM Operator · PLC/SCADA                         All three extend the tool room itself — same employers, same estates, no new
                                                      Automation Technician · Heat-Treatment Technician               sales motion. Trigger to accelerate: if wire-cut/EDM and heat-treatment
```

requisitions from existing CNC employers exceed ~10% of their machining
postings, push supply-building for these two immediately.

```text
  STAGE 2         Add for volume and liquidity        Forklift / Material-Handling Operator · Production              These maximise repeat-hire liquidity and let us up-ladder existing CNC candidates
                                                      Supervisor / Line Leader · EHS Safety Officer ·                 into supervisory roles. Trigger: track fill-time — if support-role fill-time is under
                                                      Foundry / Casting Worker (lead with Gujarat-Rajkot              half of skilled-role fill-time, these are the cash-flow engine and marketing should
                                                      and Pune)                                                       weight toward them.

  STAGE 3         Growth bets                         Robotics / Mechatronics Technician · EV Battery Pack            Trigger: measurable EV or automation employer demand in the Pune / NCR /
                                                      Assembly · Motor Winding / EV Powertrain ·                      Gujarat pipeline — e.g. more than 5% of new employer sign-ups tagged EV or
                                                      Electroplating / Surface Treatment · Forging Operator           automation.

 VERTICAL         Evaluate independently — do         SMT Line Operator · PCB Assembly Operator ·                     Electronics/EMS is a separate company-shaped bet with its own geography and
                  not fold in                         Soldering Technician                                            buyer. Trigger: a named EMS/ODM anchor customer requesting volume hiring.

  DEMOTE          Reduce investment                   Rubber Moulding · Blow Moulding / Extrusion ·                   Keep vocabulary packs so no worker is turned away; stop investing demand-side
                                                      (collapse plastics cluster 5 → 3)                               effort.
```

What this does to the numbers
  Phase 1 grows from 4 to 7 roles — the four we planned plus wire-cut/EDM, PLC/SCADA and heat-treatment. All three additions are tool-room-adjacent,
so the telecaller list, the industrial estates and the employer relationships stay identical. No new go-to-market.
  Total taxonomy goes from 22 to roughly 31–33 roles across all stages — but the architecture absorbs it, because every role is the same shape: role +
level ladder + display-only attributes. The ladder is built once; each role simply declares which rungs apply.
  Attributes stay display-only under Matching V1. Role and skill drive visibility and rank; controller, axes, certifications, instruments, machine make
and tonnage are shown to the employer to inform the ₹40 unlock decision — never scored, never ranked.
  One open design fork for engineering: is “CNC Turner (Programmer)” a distinct skill_id from “CNC Turner (Operator)” for matching, or one skill
carrying a level attribute? This materially changes both reach and rank behaviour and needs a deliberate ruling — it should not be decided by default
inside a migration.

Caveats. Salary figures come from job aggregators (Indeed, Glassdoor, PayScale, SalaryExpert, WageIndicator) and vary widely by source, sample size and seniority —
model-based averages run higher than real entry-level shop-floor pay, and some samples are very small. Treat them as indicative bands, not verified payroll. Several demand
figures — ECMS job targets, 12 million electronics jobs by 2027, 500,000 EV jobs by 2030 — are forward-looking government and industry projections, not achieved employment.
India publishes no central per-role vacancy register, so demand is triangulated from hiring-intent surveys, aggregator openings and sector reports. The foundry shortage is
documented qualitatively (IIF, Technavio) without a precise numeric shortfall; the 1.2M welding figure is a 2020 IIW estimate. Per-trade ITI graduate counts from DGT/NCVT were
not retrievable and should be confirmed against official dashboards before external use. Adjacency ratings are analytical judgements based on task and tooling proximity to
CNC/tool-room work, not a formal skills-taxonomy mapping.

<!-- PDF page 9 of 9 -->

BadaBhai — Industrial Role Taxonomy Master Sheet · compiled 2026-08-09 · sources: NSDC, ManpowerGroup 2025 Talent Shortage Survey, TeamLease Jobs & Salaries Primer
FY25-26, Deloitte India Blue-Collar Workforce Trends 2025, Taggd India Decoding Jobs 2026, IFR World Robotics 2024, ACMA, Institute of Indian Foundrymen, OMI Foundation,
National Safety Council, India Skills Report 2025, Invest India / MeitY, DGT-MSDE. Confidential.
