# Level ladders — stored for development (per owner: keep everything in one place)

> **Since CEO pack v2 (23 Nov 2026) the one place is `TRADE_CATALOGUE`**
> (`packages/taxonomy/src/trade-catalogue.ts`). It holds every ladder of the 60 trades,
> including the 18 desk ladders, with each trade's confirmed and higher-price rung. The rung
> keys, labels, confirm questions and per-trade price tiers are in
> `packages/taxonomy/src/trade-levels.ts` (`TRADE_LEVEL_PACKS`, `TRADE_LEVEL_CONFIRM_ITEMS`).
> The consistency test holds the two files together. The sections below are the history of
> the first trades and are not kept up to date.
>
> Pack v2 added four rung keys (#3000), appended so stored answers keep rendering:
>
> | key                | used by                                     | confirmed                     | price  |
> | ------------------ | ------------------------------------------- | ----------------------------- | ------ |
> | `engineer`         | the desk ladders (engineer rows)            | only through its own question | Higher |
> | `senior_engineer`  | the desk ladders                            | by rule                       | Higher |
> | `executive`        | Stores (T53) and Dispatch (T55), entry rung | only through its own question | Lower  |
> | `senior_executive` | Stores and Dispatch                         | by rule                       | Higher |
>
> A sheet's own tier row (`tierOverrides`) wins over this shared rule for that trade.

Source: code `levelLadder` + spec §8 ladders. Code ladders are form truth today; spec extends with Helper/Trainee + Supervisor. P1 will store `trade_level` keys (lowercase, e.g. `setter_programmer`).

## Turner (`mskill_cnc_turner` / `cnc_turner` / `qp_cnc_turning`)

Code: `["Operator", "Setter", "Setter-cum-Programmer", "Programmer"]`
Spec §8.1: `helper, operator, setter, setter_programmer, programmer, supervisor`
- helper: load/unload, deburr — signal: helper, trainee, loading-unloading
- operator: proven program, wear offset — signal: machine chalata hoon, production karta hoon
- setter: work holding, offsets, first piece — signal: setting karta hoon, job lagata hoon
- setter_programmer: + edit at control — signal: program edit karta hoon
- programmer: new program from drawing — signal: drawing se program banata hoon, Mastercam
- supervisor: 5-20 machines + people — signal: in-charge, line chalata hoon

## VMC (`mskill_vmc_operator` / `vmc_milling` / `qp_vmc_milling`)

Code: `["Operator", "Setter", "Setter-cum-Programmer", "Programmer"]`
Spec §8.2: `helper, operator, setter, setter_programmer, programmer, supervisor`
Signals: zero lagata hoon / G54 → setter; Mastercam/PowerMill/NX → programmer; Heidenhain → controller.

## Grinding (`mskill_cnc_grinding_operator` / `cnc_grinding` / `qp_cnc_grinding`)

Code: `["Trainee", "Operator", "Setter", "Setter-cum-Programmer", "Supervisor"]` — no Programmer rung (wheels dressed, not programmed).
CEO Launch Plan Pack v1, sheet 15 (RULED 2026-11-02; shipped as `qp_cnc_grinding@6`, Phase 2 #2): `trainee, operator, setter, setter_programmer, supervisor`. Confirmed from `setter`; Higher from `setter`.
Decided: no `programmer` key for grinding (sheet 15). The sheet's one separating question ("Wheel change, dressing aur naya job setting aap karte ho?") is asked of setter and setter_programmer (owner ruling 2026-11-03); supervisor by rule. Stored `helper` (@1–@5) still renders.

## CAM (`mskill_cam_programmer` / `cam_programmer` / `qp_cam_programming`)

Code: `["Junior Programmer", "Programmer", "Senior Programmer"]`
Spec: no ladder given — use code ladder as `trainee→junior, programmer, senior`.
Keys: `junior_programmer, programmer, senior_programmer`. Higher tier: Programmer+.

## Sheet metal (`mskill_sheet_metal_worker` / `sheet_metal_worker` / `qp_sheet_metal_fab`)

Code: `["Helper", "Operator", "Skilled", "Senior", "Programmer", "Supervisor"]`
CEO Launch Plan Pack v1, sheet 10 (shipped as `qp_sheet_metal_fab@2`): one chip "Senior / Programmer" stored `senior`.
#2753 item 1 (`qp_sheet_metal_fab@3`; owner question 5 default: a level, not a trade): `helper, operator, skilled, senior, programmer, supervisor`. Programmer sits above senior and below supervisor: the @2 rung's separating question ("Nesting / press-brake program khud banate ho?") is the programmer's evidence. Confirmed from `skilled`; Higher from `skilled`. That question is asked of senior and programmer (standing owner rule 2026-11-03); supervisor by rule. Stored @2 `senior` answers stay valid and print "Senior". The posting ladder carries the same split (`trainee … senior, programmer, supervisor`).

## Price tier (spec §4.1, hook only, ₹40 live)

Lower: Helper, Operator, null (+ CAD trainee/draughtsman/modeller equivalents).
Higher: Setter and above (+ Senior/Lead equivalents).
