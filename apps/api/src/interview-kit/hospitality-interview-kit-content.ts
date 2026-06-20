/**
 * Per-trade interview kit content — HOSPITALITY vertical (PRD: hospitality-vertical-prd.md).
 *
 * DRAFTED, PENDING RVM — NOT LIVE. Mirrors the manufacturing `interview-kit-content.ts`
 * pattern EXACTLY: same {@link InterviewKitContent} interface, same rules
 * (deterministic, static, reviewed copy — NO LLM; PII-free, per-trade). Kept in a
 * SEPARATE module so the manufacturing kits/tests are unaffected and this draft
 * vertical is gated until per-trade RVM PASS. Not wired into the live resolver.
 *
 * Field-semantics mapping (PRD §5): `drawing_measurement_questions` →
 * standards/measurement questions (portion control, recipe/spec adherence, billing
 * accuracy, room-readiness standards); `safety_questions` → hygiene + safety.
 */
import type { InterviewKitContent } from "./interview-kit-content";

/** Documents almost every hospitality interview asks for (shared baseline). */
const HOSP_COMMON_DOCS = [
  "Aadhaar card (original + photocopy)",
  "Hospitality diploma / certificates and marksheets (if any)",
  "Experience / relieving letters (if any)",
  "2 passport-size photographs",
  "Updated resume (BadaBhai resume printout)",
] as const;

export { HOSP_COMMON_DOCS };

const K = (k: InterviewKitContent): InterviewKitContent => k;

export const HOSPITALITY_INTERVIEW_KITS: readonly InterviewKitContent[] = [
  K({
    trade_key: "hosp_steward_waiter",
    display_name: "Steward / Waiter",
    overview:
      "A Steward / Waiter interview checks whether you can serve guests well, take orders correctly, lay a table, and keep hygiene and speed during service. Expect basic service questions, a few practical ones, and hygiene/safety questions.",
    common_questions: [
      "What is the correct sequence of service at a table?",
      "How do you take an order and punch a KOT?",
      "How do you handle a guest complaint about food or service?",
      "What is the difference between a la carte and buffet service?",
      "How do you upsell a dish or beverage politely?",
    ],
    practical_questions: [
      "Lay a basic cover for a table — what goes where?",
      "How do you carry and serve hot plates safely?",
      "How do you clear and reset a table between guests?",
    ],
    safety_questions: [
      "What personal hygiene and grooming standards do you follow?",
      "How do you serve a guest with a food allergy?",
      "What do you do if you drop or break crockery during service?",
    ],
    drawing_measurement_questions: [
      "How do you ensure the bill matches what the guest ordered?",
      "How do you check that a dish is served at the right portion and temperature?",
      "How do you confirm a table is set to the correct standard before service?",
    ],
    skill_checklist: [
      "Food & beverage service sequence",
      "Order taking and KOT",
      "Table laying and cover setup",
      "Guest handling and complaint resolution",
      "Hygiene and grooming",
    ],
    revise_before: [
      "Sequence of service and table etiquette",
      "Cover setup (cutlery, crockery, glassware placement)",
      "Common menu terms and dish knowledge",
      "How to handle complaints calmly",
    ],
    documents_to_carry: HOSP_COMMON_DOCS,
    common_mistakes: [
      "Saying you know service styles you have not actually done",
      "Forgetting to mention hygiene and grooming",
      "Not listening fully to the guest's order",
    ],
    hinglish_note:
      "Tip: Guest se hamesha politely aur smile ke saath baat karna. Order dhyan se lena aur repeat karke confirm karna. Hygiene aur grooming ki baat zaroor bolna.",
  }),
  K({
    trade_key: "hosp_commis_cook",
    display_name: "Commis Chef / Cook",
    overview:
      "A Commis Chef / Cook interview checks your food preparation, basic cooking, recipe and portion knowledge, and kitchen hygiene. Expect basic questions, practical cooking questions, and food-safety questions.",
    common_questions: [
      "What is mise-en-place and why is it important?",
      "Which sections (stations) of the kitchen have you worked in?",
      "How do you follow a standard recipe and keep portions consistent?",
      "What is FIFO and how do you rotate stock?",
      "How do you support the chef during a busy service?",
    ],
    practical_questions: [
      "Show the basic knife cuts you know (julienne, dice, etc.).",
      "How would you prepare and set up your station before service?",
      "How do you check if cooked food is ready and safe to serve?",
    ],
    safety_questions: [
      "What are the correct storage temperatures for raw and cooked food?",
      "How do you prevent cross-contamination in the kitchen?",
      "How do you handle hot surfaces, oil, and the fryer safely?",
    ],
    drawing_measurement_questions: [
      "How do you measure portions to a recipe spec card?",
      "How do you use a food thermometer to check cooking temperature?",
      "How do you weigh and scale ingredients for consistency?",
    ],
    skill_checklist: [
      "Mise-en-place and station setup",
      "Standard recipes and portion control",
      "Knife skills and basic cooking",
      "Stock rotation (FIFO)",
      "Food safety / HACCP basics",
    ],
    revise_before: [
      "Food storage temperatures and HACCP basics",
      "Standard recipe and portion control",
      "Basic knife cuts and cooking methods",
      "Cross-contamination prevention",
    ],
    documents_to_carry: HOSP_COMMON_DOCS,
    common_mistakes: [
      "Claiming a station or dish you have not actually cooked",
      "Forgetting food-safety and storage temperatures",
      "Not mentioning mise-en-place and FIFO",
    ],
    hinglish_note:
      "Tip: Jo station aur dishes aapne banayi hain sirf wahi bolna. Food safety aur storage temperature ki baat confident hoke karna. Mise-en-place aur hygiene ka dhyan zaroor mention karna.",
  }),
  K({
    trade_key: "hosp_room_attendant",
    display_name: "Room Attendant (Housekeeping)",
    overview:
      "A Room Attendant interview checks whether you can clean and prepare guest rooms to standard, handle linen and amenities, and follow hygiene and safety. Expect basic questions, practical cleaning questions, and safety questions.",
    common_questions: [
      "What is the correct sequence for cleaning a guest room?",
      "How do you make a bed to hotel standard?",
      "How do you handle a Do-Not-Disturb or occupied room?",
      "What room statuses do you report and how?",
      "What do you do with lost-and-found items?",
    ],
    practical_questions: [
      "Show how you would clean and sanitise a bathroom.",
      "How do you stock and organise your housekeeping cart?",
      "How do you clean a room quickly without missing standards?",
    ],
    safety_questions: [
      "How do you handle and store cleaning chemicals safely?",
      "How do you prevent slips and falls while cleaning?",
      "How do you protect guest privacy and room security?",
    ],
    drawing_measurement_questions: [
      "How do you check a room is fully ready against the cleaning checklist?",
      "What standard do you follow for bed making and linen presentation?",
      "How do you confirm amenities are replenished to the correct count?",
    ],
    skill_checklist: [
      "Guest-room cleaning sequence",
      "Bed making and linen handling",
      "Bathroom sanitisation",
      "Room status reporting",
      "Chemical handling and safety",
    ],
    revise_before: [
      "Room cleaning sequence and standards",
      "Bed-making steps",
      "Cleaning-chemical safety and dilution",
      "Room status codes",
    ],
    documents_to_carry: HOSP_COMMON_DOCS,
    common_mistakes: [
      "Skipping steps in the cleaning checklist",
      "Forgetting chemical-safety and slip prevention",
      "Not respecting guest privacy and security",
    ],
    hinglish_note:
      "Tip: Room cleaning ka sequence aur checklist achhe se yaad rakhna. Chemicals safely use karna aur guest ki privacy ka dhyan rakhna. Kaam fast ke saath standard maintain karna.",
  }),
  K({
    trade_key: "hosp_front_office",
    display_name: "Front Office Associate",
    overview:
      "A Front Office Associate interview checks your guest handling, check-in/out, PMS basics, and complaint handling. Expect communication-focused questions, practical front-desk questions, and safety/privacy questions.",
    common_questions: [
      "Walk me through the check-in and check-out process.",
      "How do you handle a guest complaint at the desk?",
      "What is a PMS and which ones have you used?",
      "How do you handle a walk-in when the hotel is nearly full?",
      "How do you coordinate with housekeeping for room readiness?",
    ],
    practical_questions: [
      "A guest's room is not ready at check-in — what do you do?",
      "How do you handle a billing dispute at check-out?",
      "How do you take and confirm a reservation?",
    ],
    safety_questions: [
      "How do you protect guest data and confidentiality?",
      "How do you handle cash and card payments securely?",
      "What do you do during a fire alarm or emergency at the desk?",
    ],
    drawing_measurement_questions: [
      "How do you ensure a guest bill is accurate before check-out?",
      "How do you verify room allocation against the arrival list?",
      "How do you confirm a reservation's dates, rate, and room type are correct?",
    ],
    skill_checklist: [
      "Check-in / check-out process",
      "PMS operation basics",
      "Guest communication and complaint handling",
      "Billing and cash/card handling",
      "Data privacy and security",
    ],
    revise_before: [
      "Check-in/out steps and PMS basics",
      "Complaint-handling approach (listen, empathise, resolve)",
      "Billing and payment handling",
      "Guest-data privacy rules",
    ],
    documents_to_carry: HOSP_COMMON_DOCS,
    common_mistakes: [
      "Weak or unclear communication with the guest",
      "Mishandling a billing or reservation detail",
      "Forgetting guest-data privacy and security",
    ],
    hinglish_note:
      "Tip: Front desk par communication clear aur polite honi chahiye. Check-in/out aur PMS ke steps confident hoke batao. Guest ki privacy aur billing accuracy ka dhyan rakhna.",
  }),
  K({
    trade_key: "hosp_fnb_captain",
    display_name: "F&B Captain",
    overview:
      "An F&B Captain interview checks whether you can lead a service section, manage guest experience, coordinate with kitchen and bar, and uphold standards. Expect service-leadership questions, practical coordination questions, and hygiene/safety questions.",
    common_questions: [
      "How do you brief and lead your service team before a shift?",
      "How do you handle a difficult guest or a service complaint?",
      "How do you coordinate orders between the table, kitchen, and bar?",
      "How do you manage table turnover during a busy service?",
      "How do you ensure service standards and SOPs are followed?",
    ],
    practical_questions: [
      "A table's order is delayed in the kitchen — how do you manage the guest?",
      "How do you plan a section's mise-en-place before service?",
      "How do you handle a billing error in front of a guest?",
    ],
    safety_questions: [
      "How do you ensure your team's grooming and hygiene standards?",
      "How do you handle food-allergy requests across the section?",
      "How do you manage a spill or breakage safely during service?",
    ],
    drawing_measurement_questions: [
      "How do you check a section's bills are accurate at settlement?",
      "How do you ensure dishes meet portion and presentation standards?",
      "How do you confirm the section is set to standard before guests arrive?",
    ],
    skill_checklist: [
      "Section supervision and team briefing",
      "Guest experience and complaint handling",
      "Kitchen/bar coordination",
      "Service standards and SOPs",
      "Billing oversight",
    ],
    revise_before: [
      "Service standards and SOPs",
      "Team coordination and briefing",
      "Complaint handling and guest recovery",
      "Section mise-en-place planning",
    ],
    documents_to_carry: HOSP_COMMON_DOCS,
    common_mistakes: [
      "Not taking ownership of the section's standards",
      "Poor coordination with kitchen and bar",
      "Weak handling of guest complaints",
    ],
    hinglish_note:
      "Tip: Captain ka kaam team ko lead karna aur guest ka experience smooth rakhna hai. Kitchen aur bar ke saath coordination achhi honi chahiye. Standards aur complaint handling par confident raho.",
  }),
  K({
    trade_key: "hosp_bartender",
    display_name: "Bartender",
    overview:
      "A Bartender interview checks your drink preparation, recipe and measure accuracy, bar setup, and responsible service. Expect beverage questions, practical preparation questions, and hygiene/safety questions.",
    common_questions: [
      "Which cocktails and beverages can you prepare?",
      "How do you set up and maintain your bar (mise-en-place)?",
      "How do you keep drink recipes and measures consistent?",
      "How do you manage bar stock and reduce variance?",
      "How do you handle an intoxicated or underage guest?",
    ],
    practical_questions: [
      "Explain the steps to prepare a common cocktail to recipe.",
      "How do you set up the bar before service?",
      "How do you measure a peg accurately and consistently?",
    ],
    safety_questions: [
      "How do you practise responsible service of alcohol?",
      "How do you handle glassware and breakage safely?",
      "How do you keep the bar hygienic and clean during service?",
    ],
    drawing_measurement_questions: [
      "How do you measure a peg/spirit to the correct quantity?",
      "How do you follow a cocktail recipe's exact proportions?",
      "How do you reconcile bar consumption against sales at closing?",
    ],
    skill_checklist: [
      "Cocktail and beverage preparation",
      "Bar setup and mise-en-place",
      "Recipe and measure accuracy",
      "Stock control",
      "Responsible service and hygiene",
    ],
    revise_before: [
      "Common cocktail recipes and measures",
      "Bar setup and mise-en-place",
      "Responsible service of alcohol",
      "Bar hygiene standards",
    ],
    documents_to_carry: HOSP_COMMON_DOCS,
    common_mistakes: [
      "Claiming cocktails you cannot actually prepare",
      "Inconsistent measures and recipes",
      "Forgetting responsible service and bar hygiene",
    ],
    hinglish_note:
      "Tip: Jo drinks aap bana sakte ho sirf wahi bolna. Peg aur recipe ka measure hamesha accurate rakhna. Responsible service aur bar hygiene ki baat zaroor karna.",
  }),
  K({
    trade_key: "hosp_kitchen_steward",
    display_name: "Kitchen Steward (Utility)",
    overview:
      "A Kitchen Steward interview checks whether you can wash and clean to hygiene standard, handle chemicals and equipment safely, and support the kitchen. Expect basic questions, practical cleaning questions, and hygiene/safety questions.",
    common_questions: [
      "What is the correct way to wash crockery and utensils?",
      "How do you operate and load a dishwashing machine?",
      "How do you segregate kitchen waste?",
      "How do you keep the wash area clean during busy service?",
      "How do you support the kitchen team during peak hours?",
    ],
    practical_questions: [
      "How do you clean a greasy pot or burnt utensil?",
      "How do you set up the dishwashing area at the start of a shift?",
      "How do you dilute and use a cleaning chemical correctly?",
    ],
    safety_questions: [
      "How do you handle and store cleaning chemicals safely?",
      "How do you prevent slips on a wet kitchen floor?",
      "How do you avoid cross-contamination while cleaning?",
    ],
    drawing_measurement_questions: [
      "How do you dilute a chemical to the correct ratio?",
      "How do you check cleaned items meet the hygiene standard?",
      "How do you follow the cleaning schedule and checklist?",
    ],
    skill_checklist: [
      "Dishwashing and pot-washing",
      "Equipment and area cleaning",
      "Waste segregation",
      "Chemical handling and dilution",
      "Kitchen support",
    ],
    revise_before: [
      "Cleaning sequence and hygiene standards",
      "Chemical dilution and safety",
      "Waste segregation rules",
      "Dishwashing machine operation",
    ],
    documents_to_carry: HOSP_COMMON_DOCS,
    common_mistakes: [
      "Using chemicals without correct dilution or PPE",
      "Forgetting slip prevention and wet-floor signs",
      "Not keeping the wash area organised during service",
    ],
    hinglish_note:
      "Tip: Cleaning ka sequence aur chemical dilution sahi rakhna. Wet floor par slip se bachna aur safety ka dhyan rakhna. Mehnat aur hygiene dono important hain.",
  }),
  K({
    trade_key: "hosp_banquet_server",
    display_name: "Banquet Server",
    overview:
      "A Banquet Server interview checks whether you can set up events, serve large volumes (buffet and plated), and follow the function sheet and hygiene. Expect service questions, practical setup questions, and safety questions.",
    common_questions: [
      "What is a banquet event order (BEO) / function sheet and how do you use it?",
      "What is the difference between buffet and plated banquet service?",
      "How do you set up a banquet hall and buffet?",
      "How do you serve a large number of guests on time?",
      "How do you replenish a buffet during an event?",
    ],
    practical_questions: [
      "Set up a banquet table and buffet line — what is the sequence?",
      "How do you carry and serve multiple plates safely?",
      "How do you break down and reset after an event?",
    ],
    safety_questions: [
      "How do you carry heavy trays and hot chafing equipment safely?",
      "How do you keep buffet food at safe temperatures?",
      "How do you manage spills and guest safety at a crowded event?",
    ],
    drawing_measurement_questions: [
      "How do you set up against the function sheet's headcount and layout?",
      "How do you keep buffet portions and presentation consistent?",
      "How do you check chafing-dish food temperatures during the event?",
    ],
    skill_checklist: [
      "Banquet and buffet setup",
      "Plated and buffet service",
      "Function-sheet reading",
      "Event mise-en-place and breakdown",
      "Hygiene and safety",
    ],
    revise_before: [
      "Banquet setup sequence",
      "Buffet temperature and hygiene control",
      "Function sheet / BEO basics",
      "Safe carrying of trays and chafing equipment",
    ],
    documents_to_carry: HOSP_COMMON_DOCS,
    common_mistakes: [
      "Not following the function sheet for setup",
      "Letting buffet food fall out of safe temperature",
      "Unsafe carrying of heavy or hot items",
    ],
    hinglish_note:
      "Tip: Function sheet ke hisaab se setup karna aur time par service dena. Buffet ka temperature aur hygiene maintain rakhna. Heavy aur hot items safely carry karna.",
  }),
  K({
    trade_key: "hosp_barista",
    display_name: "Barista",
    overview:
      "A Barista interview checks your coffee preparation, espresso and milk skills, machine handling, and counter hygiene. Expect beverage questions, practical preparation questions, and hygiene/safety questions.",
    common_questions: [
      "Walk me through preparing an espresso and a cappuccino.",
      "How do you steam and texture milk?",
      "How do you calibrate the grinder and dose for a shot?",
      "How do you keep drink quality consistent during a rush?",
      "How do you handle a guest who is unhappy with their coffee?",
    ],
    practical_questions: [
      "Pull a shot and explain what a good extraction looks like.",
      "How do you clean and backflush the espresso machine?",
      "How do you set up the café counter before opening?",
    ],
    safety_questions: [
      "How do you work safely around hot surfaces and steam?",
      "How do you keep milk and the counter food-safe?",
      "How do you handle cleaning chemicals for machine cleaning?",
    ],
    drawing_measurement_questions: [
      "How do you weigh the dose and time the shot for consistency?",
      "How do you follow a beverage recipe's exact proportions?",
      "How do you check the grind and adjust for a correct extraction?",
    ],
    skill_checklist: [
      "Espresso and coffee preparation",
      "Milk steaming and texturing",
      "Grinder calibration and dosing",
      "Counter and POS handling",
      "Machine cleaning and hygiene",
    ],
    revise_before: [
      "Espresso and milk basics",
      "Grinder dosing and shot timing",
      "Machine cleaning and backflush",
      "Counter hygiene standards",
    ],
    documents_to_carry: HOSP_COMMON_DOCS,
    common_mistakes: [
      "Claiming machine skills you have not used",
      "Inconsistent dose and shot timing",
      "Forgetting machine cleaning and counter hygiene",
    ],
    hinglish_note:
      "Tip: Espresso aur milk texturing confident hoke dikhana. Dose aur shot timing consistent rakhna. Machine cleaning aur counter hygiene ki baat zaroor karna.",
  }),
];

/**
 * Required hospitality kit trades (DRAFTED, pending RVM). Parallels manufacturing's
 * `REQUIRED_KIT_TRADE_KEYS`; tests assert all are present. Kept SEPARATE so
 * manufacturing acceptance is unaffected.
 */
export const REQUIRED_HOSP_KIT_TRADE_KEYS = [
  "hosp_steward_waiter",
  "hosp_commis_cook",
  "hosp_room_attendant",
  "hosp_front_office",
  "hosp_fnb_captain",
  "hosp_bartender",
  "hosp_kitchen_steward",
  "hosp_banquet_server",
  "hosp_barista",
] as const;

const BY_KEY = new Map(HOSPITALITY_INTERVIEW_KITS.map((k) => [k.trade_key, k]));

/** Look up a hospitality interview kit by its stable trade_key (draft vertical). */
export function getHospitalityInterviewKit(tradeKey: string): InterviewKitContent | undefined {
  return BY_KEY.get(tradeKey);
}
