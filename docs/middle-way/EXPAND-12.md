# Middle Way — EXPAND plan (P6): Grinding/CAM aliases + 12 remaining live trades

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
  bridges). PENDING MANUAL STEP: Divyanshu to run `db:seed:match:vocabulary` on
  staging + prod (same pattern as P4) — until then the new id exists in code only.
  Unblocks E3 + E17.
- **E1 — Pack slot-2 option alignment (v1 GAP).** §8 slot-2 machine lists
  (turn-mill / live tool / C-axis / twin spindle / sliding head / swiss / VTL;
  VMC 4th-axis / rotary / 5-axis / HMC variants) have NO matching pack options
  (`turning_machine`, `milling_machine` carry only the generic types). Typed
  variants re-ask with chips today (pinned in `section8-alias-resolution.test.ts`).
  Decide per trade: add options (pack version bump + seed + snapshot regen + TTS
  re-render, §8.4) or keep chips-only. Do Turner+VMC first — the DoD table names them.
- **E2 — Controller spellings (v1 GAP).** Typed `Sinumerik`, `M70`, `Mazatrol`, `TNC`
  match no controller chip (`Fanuc`/`Siemens`/`Mitsubishi`/`Haas`/`Mazak`/
  `Heidenhain` only). Same treatment as E1: capture synonyms or new chips.
  Needs owner/lexicon ratification for anything that looks like an alias
  (TAX-0 gate d reasoning from P4 — see handover).

## 1. Grinding + CAM aliases (v1 remainder — do first)

- **E4 — Grinding starter ✅ CODE DONE (`feat/mw-e4-grinding-aliases`, PR next).**
  Ladder stops at setter-cum-Programmer: `helper, operator, setter,
setter_programmer, supervisor` — NO `programmer` rung (wheels are dressed, not
  programmed; pinned: "Programmer" claims no rung). Role `levelTerms` += rung
  phrases (Turner P4 mirror, minus programmer phrases); machine terms for
  cylindrical/surface/centreless/internal variants; 6 rvm-aliases rows on the
  grinding domain. Measured in review: "X grinding" phrases route alone (carry
  the occupation word); typed variants re-ask with chips (E1 pack work, pinned
  as GAP). PENDING MANUAL STEP: Divyanshu `db:seed:domains` → normalize →
  verify on staging + prod (new alias rows exist in code only until then).
- **E5 — CAM starter (no §8 sheet; role file + pack are the source).**
  Ladder is Junior/Programmer/Senior (`junior_programmer, programmer,
senior_programmer`; P5 crosswalk already handles). Role `levelTerms` += rung
  phrases; software rows (Mastercam/PowerMill/NX/CATIA/Creo) already route —
  extend the §8.4 software/work-area mapping (SolidWorks/Creo/NX/CATIA/Inventor/
  Fusion 360/Solid Edge; sheet-metal/plastic/fixture work areas).

## 2. The 12 trades (one PR each, in this order — machining-adjacent first)

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
