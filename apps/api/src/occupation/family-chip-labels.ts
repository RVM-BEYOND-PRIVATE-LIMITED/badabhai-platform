/**
 * THE LATIN-SCRIPT FAMILY LABEL (#1679) — what a worker is shown for an occupation family, in the
 * script every other line of the interview is written in.
 *
 * THE RULING. Display script is Latin: romanized Hinglish, the register of every served pack
 * string, the "Kuch aur" escape and every persona line. Devanagari is for read-aloud (the #896
 * sidecar in `question-tts-text.ts`) and for recognition, not for display. Owner ruling,
 * 2026-09-24; recorded in `docs/specs/persona-system-v3.2.md`.
 *
 * WHY THIS MAP EXISTS. `profiling_family.label_hi` is Devanagari for every family, and it was the
 * chip label for 2,915 of 3,515 reachable occupations, measured over the committed corpus: those
 * occupations own no alias except their English NCO title, so the family label is what they fall
 * to. The chip becomes the worker's answer of record verbatim, and the same label is echoed back
 * on the trust pill and settles `primary_trade` when the model gave none. A policy applied only to
 * the alias step would have fixed 39 occupations and left 83% of them in Devanagari.
 *
 * A LABEL HERE IS ALSO ROUTING EVIDENCE. The pinned label joins the haystack `routeToTradeForm`
 * reads (`trade-form-router.ts`), both to route and to veto, and that router's terms are mostly
 * Latin — so these labels are evidence in a way the Devanagari ones mostly were not. Putting
 * "turning" into `fam_machining`'s label would hand the turner form to every occupation that falls
 * back to it, on the pin alone. `family-chip-labels.test.ts` pins where every label routes; a
 * wording change that moves a route fails there, and is a routing decision, not a copy edit.
 *
 * WHY HERE AND NOT A `profiling_family` COLUMN. The occupation index loads family labels at boot.
 * A new column read by that loader would fail every snapshot build on a database where the
 * migration has not been applied by hand yet, and a failed first build leaves retrieval with NO
 * index. This is the same trade the Devanagari sidecar made the other way round: an authored
 * script twin, committed beside the code that serves it, and held complete by a test.
 *
 * HOW EACH LABEL WAS WRITTEN. As a transliteration of the family's `label_hi`: the same words, in
 * Latin letters, spelled the way the alias corpus spells them (`dukan`, `gaadi`, `mistri`), with
 * English loanwords in their English spelling and acronyms in capitals. There are two deliberate
 * departures:
 *
 *   - `fam_universal` is "General", NOT a transliteration of सामान्य. The worker app hides exactly
 *     two strings on the trust pill, "सामान्य" and "General" (`kUniversalOccupationLabels` in
 *     `apps/worker-app/lib/core/api/occupation_label.dart`); any other spelling would put the word
 *     "General" on the pill as if it were a trade. Hidden there, it is still SHOWN as a
 *     disambiguation chip and still settles `trade`, exactly as सामान्य did before. The pairing is
 *     held from both sides: `family-chip-labels.test.ts` reads the Dart, and
 *     `occupation_label_test.dart` pins "General" as hidden.
 *   - `fam_security` is "security guard", not "suraksha guard". That is what a guard calls the job
 *     (it is an authored alias; the Hindi is a translation of it).
 *
 * DRAFTED, NOT RATIFIED, like the pack vocabulary: nobody from these trades has read the list yet.
 * See `docs/registers/trade-content-ratification.md`.
 *
 * WHEN YOU ADD A FAMILY to `packages/db/data/question-packs/_families.jsonl`, add its label here.
 * `family-chip-labels.test.ts` fails until you do. If you change a family's `label_hi`, check its
 * label here still says the same thing: the test can see that a label exists, not what it means.
 *
 * PRIVACY: public reference labels only.
 */
export const FAMILY_CHIP_LABELS: Readonly<Record<string, string>> = Object.freeze({
  fam_universal: "General",
  fam_welding: "welding",
  fam_machining: "kharad aur CNC",
  fam_cnc_turning: "turning aur kharad",
  fam_vmc_milling: "milling aur VMC",
  fam_cnc_grinding: "grinding aur ghisai",
  fam_cam_programming: "part programming",
  fam_cad_drafting: "CAD aur drafting",
  fam_draughting: "drafting aur naksha",
  fam_fitting: "fitter aur maintenance",
  fam_toolmaking: "tool aur die making",
  fam_auto_mechanic: "gaadi mechanic",
  fam_ac_refrigeration: "AC aur fridge",
  fam_electrical: "bijli ka kaam",
  fam_lineman: "lineman",
  fam_electronics: "electronics aur mobile repair",
  fam_plumbing: "plumber ka kaam",
  fam_masonry: "raj mistri",
  fam_carpentry: "badhai ka kaam",
  fam_furniture: "furniture aur body building",
  fam_painting: "painter ka kaam",
  fam_construction_other: "safedi aur scaffolding",
  fam_construction_helper: "beldar",
  fam_concrete: "concrete aur mixer",
  fam_earthmoving: "JCB aur machine",
  fam_tailoring: "darzi ka kaam",
  fam_sewing_machine: "silai machine",
  fam_weaving: "bunkar aur kaleen",
  fam_cobbler: "mochi ka kaam",
  fam_driving_light: "gaadi chalana",
  fam_driving_heavy: "truck chalana",
  fam_cart: "rickshaw aur thela",
  fam_cooking: "khana banana",
  fam_baking: "bakery ka kaam",
  fam_waiter: "waiter ka kaam",
  fam_domestic: "gharelu kaam",
  fam_cleaning: "safai ka kaam",
  fam_waste: "kachra aur safai",
  fam_security: "security guard",
  fam_retail: "dukan ka kaam",
  fam_fuel_station: "petrol pump",
  fam_beauty: "beauty parlour",
  fam_farming: "kheti ka kaam",
  fam_dairy: "dairy ka kaam",
  fam_assembly: "assembly ka kaam",
  fam_packing: "packing ka kaam",
  fam_loading: "loading aur godam",
  fam_metal_processing: "bhatti aur rolling mill",
  fam_travel_service: "yatra seva",
  fam_bar_service: "bar seva",
  fam_hair_styling: "baal katna",
  fam_building_supervision: "building dekhrekh",
  fam_other_personal_service: "anya niji seva",
  fam_street_sales: "rehdi bikri",
  fam_shop_supervision: "dukan dekhrekh",
  fam_cashier: "cashier",
  fam_other_sales: "anya bikri",
  fam_child_care: "bachchon ki dekhbhal",
  fam_health_care_assist: "swasthya sahayak",
  fam_protective_service: "suraksha seva",
  fam_crop_growing: "fasal ugana",
  fam_animal_rearing: "pashupalan",
  fam_mixed_farming: "mishrit kheti",
  fam_forestry: "jungle ka kaam",
  fam_fishery: "machhli palan",
  fam_subsistence_crop: "apne liye kheti",
  fam_subsistence_livestock: "apne liye pashupalan",
  fam_subsistence_mixed: "apne liye mishrit kheti",
  fam_subsistence_fishing: "apne liye machhli pakadna",
  fam_building_frame: "dhanche ka kaam",
  fam_building_finishing: "finishing ka kaam",
  fam_structure_cleaning: "dhanche ki safai",
  fam_sheet_metal: "chadar aur dhancha",
  fam_blacksmithing: "lohar ka kaam",
  fam_machinery_repair: "machine marammat",
  fam_handicraft: "hastshilp",
  fam_printing: "chhapai ka kaam",
  fam_electrical_equipment: "bijli upkaran",
  fam_electronics_install: "electronics lagana",
  fam_food_processing: "khadya prasanskaran",
  fam_wood_treating: "lakdi ka kaam",
  fam_garment_trades: "kapda aur chamda",
  fam_other_craft: "anya karigari",
  fam_mining_plant: "khanan plant",
  fam_metal_plant: "dhatu plant",
  fam_chemical_plant: "rasayan plant",
  fam_rubber_plastic: "rubber aur plastic",
  fam_textile_machines: "kapda machine",
  fam_wood_plant: "lakdi plant",
  fam_other_plant: "anya machine",
  fam_assemblers_other: "assembly ka kaam",
  fam_rail_operation: "rail ka kaam",
  fam_delivery_driving: "delivery",
  fam_bus_driving: "bus chalana",
  fam_mobile_plant: "chalti machine",
  fam_ship_crew: "naav ka kaam",
  fam_cleaning_helpers: "safai sahayak",
  fam_hand_cleaning: "gaadi aur sheesha safai",
  fam_farm_labour: "khet mazdoori",
  fam_construction_labour: "nirmaan mazdoori",
  fam_manufacturing_labour: "factory mazdoori",
  fam_transport_labour: "dhulai mazdoori",
  fam_food_prep_assist: "rasoi sahayak",
  fam_street_service: "sadak seva",
  fam_street_vending: "pheri lagana",
  fam_refuse_work: "kachra chhantai",
  fam_other_elementary: "anya sadharan kaam",
  fam_conventional_machining: "manual machine aur machine shop",
  fam_tool_die_making: "tool room aur die maker",
  fam_welding_trade: "welding aur jodai",
  fam_powder_coating: "powder coating aur spray painting",
  // Batch 2 part two. The Latin reading of the family's `label_hi` ("शीट मेटल फैब्रिकेशन").
  fam_sheet_metal_fab: "sheet metal fabrication",
  // Batch 2 part two. The Latin reading of `label_hi` ("इंडस्ट्रियल इलेक्ट्रीशियन"), spelled as the
  // ratified alias spells it. It carries the occupation term, so it is routing evidence.
  fam_industrial_electrician: "industrial electrician",
  // Batch 2 part two. The Latin reading of the family's `label_hi` ("पावर प्रेस और स्टैम्पिंग") —
  // the tranche's two ratified phrases, "power press" and "stamping", joined as the others are.
  fam_press_operation: "power press aur stamping",
  // The Latin reading of `label_hi` ("असेंबली लाइन"), and deliberately NOT the "assembly ka kaam"
  // the two generic assembly families share: "assembly line" is this role's occupation term, so
  // the label routes its pin to the form (pinned in the test), and theirs does not.
  fam_assembly_line: "assembly line",
  // The Latin reading of `label_hi` ("फिटिंग का काम"). Distinct from the generic `fam_fitting`
  // ("fitter aur maintenance") on purpose: that label carries the maintenance technician's veto
  // word and must keep NOT routing, while this one names the trade and — pinned to fam_fitter,
  // which corroborates the bare "fitting" — routes to its form.
  fam_fitter: "fitting ka kaam",
  // Batch 2 part two. The Latin reading of `label_hi` ("क्वालिटी कंट्रोल और इंस्पेक्शन"), spelled as
  // the tranche's own alias "quality control" is.
  fam_quality_inspection: "quality control aur inspection",
});
