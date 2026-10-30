# Level ladders — stored for development (per owner: keep everything in one place)

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

Code: `["Operator", "Setter", "Setter-cum-Programmer"]` — stops here, no Programmer rung (wheels dressed, not programmed).
Spec: no ladder given — reuse Turner shape minus programmer: `helper, operator, setter, setter_programmer, supervisor`.
P1 decision needed: confirm no `programmer` key for grinding.

## CAM (`mskill_cam_programmer` / `cam_programmer` / `qp_cam_programming`)

Code: `["Junior Programmer", "Programmer", "Senior Programmer"]`
Spec: no ladder given — use code ladder as `trainee→junior, programmer, senior`.
Keys: `junior_programmer, programmer, senior_programmer`. Higher tier: Programmer+.

## Price tier (spec §4.1, hook only, ₹40 live)

Lower: Helper, Operator, null (+ CAD trainee/draughtsman/modeller equivalents).
Higher: Setter and above (+ Senior/Lead equivalents).
