# Middle Way — EXPAND plan (P6): Grinding/CAM aliases + 12 remaining live trades

> SUPERSEDED FOR ORDER (2026-11-02): the CEO Launch Plan Pack v1 replaces the
> E6–E17 queue below with its §4 build order (Track A retag first, then Track B).
> The per-trade recipe (§3) and the DONE records (E0–E2, E4, E5) stand; E-items
> below are kept as history. Reconciliation of the pack's ID/key conflicts rides
> `feat/mw-reconcile-pack-v1`.

v1 shipped C1–C6 on 4 trades (Turner, VMC, Grinding, CAM). Turner + VMC are fully
loaded (P2 gates, P3 required+stop, P4 §8 aliases, P5 display+price hook).
Grinding/CAM miss their P4 alias starter; the other 12 live trades miss everything
past their v1 level question (where one exists).

This doc is the per-trade recipe plus the itemised gap list. One trade = one PR,
same branch/gate discipline as P1–P5 (`feat/mw-ex-*`, gates green, squash-merge).

## 0. Preconditions (do once, before any trade)

- **E0 — CAD Q3 second half.** ✅ CODE DONE (`feat/mw-e0-3d-designer`, PR #2485):
  `mskill_3d_designer` minted as an active match skill; `mskill_designer` relabeled
  to "2D CAD Draughtsman"; pair added (sorted first); `skill_3d_modeling` →
  `[mskill_3d_designer]`; everything else unchanged (generic occupation, role/seed
  bridges). ✅ SEEDED on production (`db:seed:match:vocabulary`, verify PASS).
  Unblocks E3 + E17.
- **E1 — Pack slot-2 option alignment ✅ CODE DONE (`feat/mw-e1-pack-options`, PR next).**
  Three @4 packs: Turner += turn-mill/live-tool/C-axis/twin-spindle chips + VTL/
  Swiss /-relabels; VMC = HMC+VMC /-relabels ONLY (deviation from scope: no new
  axis chips — `axis_capability` already captures 4-axis/rotary/5-axis, a second
  chip would duplicate semantics); Grinding = 4 grinding-first relabels (E4 GAP
  closed). Resume map += 4 Turner values. Snapshot + served-text regen in-commit.
  ✅ SEEDED on production (`db:seed:packs`, verify PASS). TTS re-render rides #701.
- **E2 — Controller spellings ✅ CODE DONE (`feat/mw-e2-controller-spellings`, PR next).**
  Three @5 packs: /-synonym labels on existing chips (Sinumerik→Siemens, M70→
  Mitsubishi, Mazatrol→Mazak on Turner; +TNC→Heidenhain on VMC; Sinumerik+M70 on
  Grinding) — owner-ratified product-line equivalences, no new values, snapshot
  untouched, resume map untouched, handover routing-quiet unchanged. Deviation
  from scoped placement: NO Mazatrol on VMC (that pack carries no Mazak chip;
  adding one is unratified). ✅ SEEDED on production (`db:seed:packs`, verify PASS).
  FOLLOW-UP (CEO pack, 2026-11-02): Mazatrol becomes its own chip value in the
  Track A Turner retag — the E2 synonym is intentionally short-lived.

## 1. Grinding + CAM aliases (v1 remainder — do first)

- **E4 — Grinding starter ✅ CODE DONE (`feat/mw-e4-grinding-aliases`, PR next).**
  Ladder stops at setter-cum-Programmer: `helper, operator, setter,
setter_programmer, supervisor` — NO `programmer` rung (wheels are dressed, not
  programmed; pinned: "Programmer" claims no rung). Role `levelTerms` += rung
  phrases (Turner P4 mirror, minus programmer phrases); machine terms for
  cylindrical/surface/centreless/internal variants; 6 rvm-aliases rows on the
  grinding domain. Measured in review: "X grinding" phrases route alone (carry
  the occupation word); typed variants re-ask with chips (E1 pack work, pinned
  as GAP). ✅ SEEDED on production (`db:seed:domains` + normalize +
  `db:verify:domains` all PASS, 527/527 curated rvm aliases).
- **E5 — CAM starter ✅ CODE DONE (`feat/mw-e5-cam-aliases`, PR next).** Ladder is
  Junior/Programmer/Senior (`junior_programmer, programmer,
senior_programmer`; P5 crosswalk already handles). Role `levelTerms` += rung
  phrases (junior/programmer/senior hoon + toolpath banata hoon); 2 rvm-aliases
  rows on the CAM domain (`toolpath`, `tool path` — the latter pre-empts a cart
  misroute, same mechanism as `post processor`). Measured in review:
  NX/CATIA/Creo/Inventor/Fusion/Solid Edge (+2-token forms) resolve nowhere and
  stay OUT (bare forms swallow live skeletons; needs ratified surface — future
  E-item). No work-area aliases (generic words, rival trades). ✅ SEEDED on
  production (`db:seed:domains` + normalize + `db:verify:domains` all PASS).

## 2. The 12 trades (one PR each, in this order — machining-adjacent first)

> TRACK A #1 — TURNER RETAG ✅ CODE DONE (`feat/mw-turner-retag`, PR #2508, merged).
> `qp_cnc_turning@6` live on production (seeded + verified post-merge).
>
> TRACK A #2 — VMC/HMC RETAG ✅ CODE DONE (`feat/mw-vmc-retag`, PR next).
> `qp_vmc_milling@6`: Easy/Medium/Advanced tiers; 6-band experience; Helper/
> Trainee chip; sheet-2 machine/controller sets (+conventional_mill/+bed_mill/
> +spm kept history chips; +Fagor/Syntec); materials unified to Turner set;
> tolerance +0.005/H7; industry +SPM/EMS; 4 separating confirm items wired
> into `tradeLevelEntriesForPackAnswers`. Engine: VMC Easy = Q1–Q5 close (same
> shape as Turner). Deviations in the @6 review_note. ✅ Seeds after merge
> (`db:seed:packs` + verify by Divyanshu).
>
> TRACK A #3 — CAM/CNC PROGRAMMER RETAG ✅ CODE DONE (`feat/mw-cam-retag`, PR #2512, merged).
> `qp_cam_programming@4` live on production (seeded + verified post-merge).
>
> TRACK A #4 — 3D CAD DESIGNER (NEW BUILD) ✅ CODE DONE (`feat/mw-3d-designer`, PR next).
> New `jd_rvm_3d_cad_designer` domain (first RVM-minted) + `fam_cad_design_3d` +
> `qp_cad_design_3d@1`: Easy/Medium/Advanced tiers; 6-band experience;
> sheet-4 level ladder (Trainee/Designer/Senior Designer/Lead/Supervisor);
> sheet-4 software + work-area sets (Medium); Advanced depth/tolerance/industry
> rows; 3 separating confirm items (senior/lead/supervisor). 3D-meaning aliases
> moved off `jd_nco_3118_0401` (retired there, re-added here); `cad`/`cad
> operator`/`autocad` stay on drafting. Role `role_cad_designer_3d` + bridge;
> formless descriptor (chat-only, no form kind); `TRADE_FORM_KINDS_ALL` now 22
> with migrations 0139 (job_postings/jobs role_kind) + 0140 (wri role kinds).
> Deviations in the @1 review_note. ✅ Seeds after merge (`db:migrate` 0139+0140
> then `db:seed:packs` + verify by Divyanshu).
>
> TRACK A #5 — 2D DRAUGHTSMAN RETAG ✅ CODE DONE (`feat/mw-2d-draughtsman`, PR #2514, merged).
> `qp_cad_drafting@2` live on production (seeded + verified post-merge):
> Easy/Medium/Advanced tiers; 6-band experience; sheet-5 level ladder
> (Trainee/Draughtsman/Senior Draughtsman/Lead/Head, mandatory); sheet-5
> software set (+AutoCAD Mechanical/DraftSight/ZWCAD/BricsCAD) + NEW
> drawing-subject row (Medium); depth rows retagged Advanced + NEW 3D-to-2D
> row; 3 separating confirms; per-pack Draughtsman labels. Deviations in the
> @2 review_note.
>
> TRACK B #1 — FITTER RETAG ✅ CODE DONE (`feat/mw-fitter-retag`, PR #2517, merged).
> `qp_fitter@2` live on production (seeded + verified post-merge):
> Easy/Medium/Advanced tiers; 6-band experience; sheet-6 level ladder
> (Helper/Fitter/Skilled/Senior/Supervisor, mandatory); 2 separating confirms;
> work-type extended (pipe/structural/die-press); equipment retagged Medium;
> sector retagged Medium (+SPM/fabrication/pumps); depth rows retagged
> Advanced (+height gauge); hard rows gated years OR rung. Union extension:
> `fitter` (Lower) + `senior_fitter` (Higher, confirmed). Deviations in the
> @2 review_note.
>
> TRACK B #2 — ELECTRICIAN RETAG ✅ CODE DONE (`feat/mw-electrician-retag`, PR #2518, merged).
> `qp_industrial_electrician@2` live on production (seeded + verified post-merge):
> Easy/Medium/Advanced tiers; 6-band experience; sheet-7 level ladder
> (Helper/Electrician/Senior/Supervisor, mandatory; stored `senior` IS the
> sheet's senior_technician rung) + 1 separating confirm (senior self/other;
> supervisor by rule); work-type extended (factory/HT-LT/solar/generator);
> equipment retagged Medium (+5 chips); panel-motor/instrument/drawing/licence
> rows retagged Advanced (+thermal camera); hard rows gated years OR rung.
> Union extension: `electrician` (Lower). Alias: `panel wireman` -> 7412.0200.
> Deviations in the @2 review_note.
>
> TRACK B #3 — WELDER RETAG (in progress, `feat/mw-welder-retag`).
> `qp_welding_trade@2`: sheet-8 ladder (Helper/Welder/Skilled/Senior/
> Supervisor, mandatory; stored `certified_welder` aliases to skilled) + 2
> separating confirms (skilled + senior self/other; supervisor by rule);
> process is a REQUIRED Medium chip (+robotic/gas-brazing/submerged);
> equipment retagged Medium; position/instrument/drawing/inspection retagged
> Advanced (+pipe 6G, +thermal camera); NEW certificate row (Advanced); hard
> rows gated years OR rung. Union extension: `welder` (Lower) only; no alias
> (digits forbidden in alias text — bare `6G` stays routing-quiet).
> Deviations in the @2 review_note.
> `qp_industrial_electrician@2` pattern repeated: sheet-8 ladder
> (Helper/Welder/Skilled/Senior/Supervisor, mandatory; stored
> `certified_welder` aliases to skilled) + 2 separating confirms (skilled +
> senior self/other; supervisor by rule); process is a REQUIRED Medium chip
> (+robotic/gas-brazing/submerged); equipment retagged Medium; position/
> instrument/drawing/inspection retagged Advanced (+pipe 6G, +thermal camera);
> NEW certificate row (Advanced); hard rows gated years OR rung. Union
> extension: `welder` (Lower) only. Alias: bare `6g` -> 7212.0200. Deviations
> in the @2 review_note.
> `qp_industrial_electrician@2`: sheet-7 ladder
> (Helper/Electrician/Senior/Supervisor, mandatory; stored `senior` IS the
> sheet's senior_technician rung) + 1 separating confirm (senior self/other;
> supervisor by rule); 6-band experience; work-type extended
> (factory/HT-LT/solar/generator); equipment retagged Medium (+5 chips);
> panel-motor/instrument/drawing/licence rows retagged Advanced (+thermal
> camera); hard rows gated years OR rung. Union extension: `electrician`
> (Lower). Alias: `panel wireman` -> 7412.0200. Deviations in the @2
> review_note.
> `qp_fitter@2`: sheet-6 ladder (Helper/Fitter/Skilled/Senior/Supervisor,
> mandatory, confirmed from skilled) + 2 separating confirms (skilled
> self/other, senior team count; supervisor by rule); 6-band experience;
> work-type extended (pipe/structural/die-press); equipment retagged Medium;
> sector retagged Medium (+SPM/fabrication/pumps); hand-skill/instrument/
> drawing rows retagged Advanced (+height gauge); hard rows gated years OR
> rung. Union extension: `fitter` (Lower) + `senior_fitter` (Higher,
> confirmed). Deviations in the @2 review_note.

| #   | Trade (kind)                                      | Pack                           | Level Q today                       | Notes                                                                                                                                                                     |
| --- | ------------------------------------------------- | ------------------------------ | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E6  | Conventional Machinist (`conventional_machinist`) | `qp_conventional_machining` v1 | `machining_level` (not mandatory)   | Shares `lathe`/`kharad` machine terms with Turner BY VALUE (do not break); `Turner` vs `Machinist` routing boundary is the P4 comment in `conventional-machinist.role.ts` |
| E7  | Fitter (`fitter`)                                 | `qp_fitter` v1                 | `fitter_level` (not mandatory)      | Rungs `helper/fitter/senior_fitter` — union extension (see §3)                                                                                                            |
| E8  | Welder (`welder`)                                 | `qp_welding_trade` v1          | `welder_level` (not mandatory)      | Rungs `helper/welder/certified_welder` — union extension; labels already Hinglish (`Helper, madad karta hoon`)                                                            |
| E9  | Tool & Die Maker (`tool_die_maker`)               | `qp_tool_die_making` v1        | `toolroom_level` (not mandatory)    | Rungs `trainee/tool maker/senior`; `mould ka kaam`/`die ka kaam` currently route NOWHERE (pinned) — keep or map to industry optional, owner call                          |
| E10 | Press Operator (`press_operator`)                 | `qp_press_operation` v1        | `press_level` (not mandatory)       | Rungs `helper/operator/setter`                                                                                                                                            |
| E11 | Sheet Metal Worker (`sheet_metal_worker`)         | `qp_sheet_metal_fab` v1        | `sheet_metal_level` (not mandatory) | Rungs `helper/operator/skilled`                                                                                                                                           |
| E12 | Quality Inspector (`quality_inspector`)           | `qp_quality_inspection` v1     | `inspection_level` (not mandatory)  | Rungs `inspector/qc engineer` — non-ladder shape; needs ladder ruling before gates                                                                                        |
| E13 | Assembly Line Worker (`assembly_line_worker`)     | `qp_assembly_line` v1          | `assembly_level` (not mandatory)    | Rungs `helper/operator/skilled`                                                                                                                                           |
| E14 | Painter / Powder Coating (`painter_coating`)      | `qp_powder_coating` v1         | `coating_level` (not mandatory)     | Rungs `helper/operator/skilled`                                                                                                                                           |
| E15 | Maintenance Technician (`maintenance_technician`) | `qp_maintenance_tech` v1       | `maintenance_level` (not mandatory) | Rungs `helper/technician/senior technician`                                                                                                                               |
| E16 | Industrial Electrician (`industrial_electrician`) | `qp_industrial_electrician` v1 | `electrician_level` (not mandatory) | Rungs `helper/electrician/senior`                                                                                                                                         |
| E17 | 2D CAD Draughtsman (`cad_draughtsman`)            | `qp_cad_drafting` v1           | NONE — no level question            | Needs E0 first, then a NEW level item from spec §8.3 ladder (`trainee/draughtsman/senior_draughtsman/lead_checker`)                                                       |

## 3. Per-trade recipe (repeat P1–P5 at small scale)

1. **Pack v+1** (P2/P3 pattern): level question (new for CAD; mandatory for all),
   machine-or-slot-5-detail mandatory, required-8 = the v1 8-slot shape,
   `years OR level` ask*if gates on the trade's depth sections. New version file
   (`qp*<trade>@<n>.json`), `\_published-versions.jsonl`+ deprecate-in-place per
the v2/v3 convention;`db:seed:packs` by Divyanshu.
2. **Role terms** (P4 pattern): occupation/machine/level additions, additive-only,
   no shared occupation term across enabled roles (`role-registry.test.ts`
   enforces), level terms corroborate-only, controller spellings stay OUT of
   router terms (E2 covers capture).
3. **rvm-aliases.jsonl** rows (P4 pattern): trade/machine phrases only; particle-
   wrapped variants and digits need no rows (normaliser folds / validator
   forbids); Divyanshu seeds (`db:seed:domains` → normalize → verify), embed
   follows for vectors.
4. **Crosswalk** (P5 pattern): `TRADE_LEVEL_PACKS` entry (pack → mskill + level
   key) + `TRADE_LEVEL_LABELS` entries. Rungs outside the current union need a
   **union extension** in `trade-levels.ts` + confirmed-set placement per ladder:
   `skilled, fitter, senior_fitter, welder, certified_welder, tool maker, senior,
inspector, qc engineer, trainee, senior ...` — each ladder's separating rung
   decides confirmed membership (Setter-and-above rule generalised).
5. **Snapshot + goldens**: `pack-keys.snapshot.json` regen (same commit);
   TTS reply-closure mirror + ai-service twin if copy changes; TTS re-render for
   new voice-form clips stays the SEPARATE voice-form step (#701).
6. **DoD row**: extend `section8-alias-resolution.test.ts` routing + rung tables
   for the trade's §8-equivalent rows; extend the P4 reachability block for new
   alias rows. Rank/visibility/append-only tests are trade-agnostic (no per-trade
   work).

## 4. What is deliberately NOT in any trade PR

- No A/B/C/D tiers, no multipliers, no per-skill months, no function/collar
  columns (spec §9, parked).
- No rank or reach change: level stays display-only (the P6 rank guards fail the
  build otherwise).
- No key renames, ever (append-only snapshot test fails the build).
- No `mskill_cnc_setter_operator` / `mskill_cnc_programmer` resurrection (Q2:
  permanent, never assign new workers).
- ₹40 flat stays live until the CEO rules on §4.1 pricing (tier is logged, not charged).
