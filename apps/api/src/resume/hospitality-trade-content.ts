/**
 * Per-trade resume content — HOSPITALITY vertical (PRD: hospitality-vertical-prd.md).
 *
 * DRAFTED, PENDING RVM — NOT LIVE. Mirrors the manufacturing `trade-content.ts`
 * pattern EXACTLY: same {@link TradeContent} interface, same rules (deterministic,
 * static, reviewed copy — NO LLM; PII-free, per-trade vocabulary not per-worker
 * claims). Kept in a SEPARATE module so the manufacturing content/tests are wholly
 * unaffected and this draft vertical is gated until per-trade RVM PASS
 * (docs/registers/hospitality-trade-content-ratification.md). It is intentionally
 * NOT wired into the live `getTradeContent`/`resolveTradeContent` resolver.
 *
 * Field-semantics mapping for hospitality (PRD §5 — field NAMES stay identical for
 * structural parity; their content adapts): `machine_tools` → service/kitchen
 * EQUIPMENT; `inspection_tools` → service TOOLS/CHECKS; `safety_points` →
 * HYGIENE + SAFETY. Template vars: `{{role}}`, `{{years}}` (renderer-filled).
 *
 * Versioning: trade_key ids are STABLE (the `hosp_` prefix namespaces the vertical).
 */
import type { TradeContent } from "./trade-content";

const C = (t: TradeContent): TradeContent => t;

export const HOSPITALITY_TRADE_CONTENT: readonly TradeContent[] = [
  C({
    trade_key: "hosp_steward_waiter",
    display_name: "Steward / Waiter",
    headline_template: "{{role}}",
    summary_template:
      "Steward / Waiter with {{years}} of food & beverage service experience. Strong on guest service, order taking, and table etiquette with attention to hygiene and speed.",
    core_skills: [
      "Food & beverage service (table / room)",
      "Order taking and KOT punching",
      "Table laying and cover setup",
      "Menu and dish knowledge",
      "Guest handling and upselling",
    ],
    machine_tools: ["POS / billing terminal", "Service tray and trolley", "Crockery, cutlery & glassware", "Chafing dishes"],
    inspection_tools: ["Order pad / KOT", "Table setup checklist", "Cleanliness / mise-en-place check"],
    responsibilities: [
      "Greet and seat guests and present the menu",
      "Take and relay orders accurately and serve food and beverages",
      "Lay tables, maintain mise-en-place, and clear and reset covers",
      "Handle billing and guest queries courteously",
    ],
    safety_points: [
      "Personal hygiene and grooming standards",
      "Safe carrying of hot dishes and handling of breakage",
      "Food safety and allergen awareness while serving",
    ],
    experience_phrases: [
      "Handled busy service shifts while maintaining service standards",
      "Built rapport with guests and supported upselling",
    ],
    fresher_phrases: [
      "Hospitality-trained Steward / Waiter seeking a first F&B service role",
      "Trained in table service, order taking, and guest etiquette; eager to learn on the floor",
    ],
    certification_phrases: ["Diploma / certificate in Food & Beverage Service", "Hospitality / hotel management certificate"],
    keywords: ["waiter", "steward", "F&B service", "restaurant", "guest service", "hospitality"],
  }),
  C({
    trade_key: "hosp_commis_cook",
    display_name: "Commis Chef / Cook",
    headline_template: "{{role}}",
    summary_template:
      "Commis Chef / Cook with {{years}} of kitchen experience in food preparation and cooking. Reliable on mise-en-place, recipe adherence, and kitchen hygiene.",
    core_skills: [
      "Food preparation and mise-en-place",
      "Cooking to standard recipes and portion control",
      "Knife skills and basic cuts",
      "Station setup and stock rotation (FIFO)",
      "Kitchen hygiene (HACCP basics)",
    ],
    machine_tools: ["Cooking range / burners", "Oven and salamander", "Deep fryer", "Food processor / mixer", "Refrigeration / cold storage"],
    inspection_tools: ["Standard recipe / spec card", "Food thermometer", "Portion scale", "Temperature / hygiene log"],
    responsibilities: [
      "Prepare ingredients and complete mise-en-place before service",
      "Cook dishes to standard recipes and maintain portion control",
      "Keep the station clean and stock rotated (FIFO)",
      "Support senior chefs during service and plating",
    ],
    safety_points: [
      "Food safety and HACCP — storage temperatures and labelling",
      "Safe knife handling and hot-surface / fryer safety",
      "Personal hygiene, handwashing, and cross-contamination control",
    ],
    experience_phrases: [
      "Maintained mise-en-place and consistent dish quality under pressure",
      "Followed standard recipes and reduced wastage",
    ],
    fresher_phrases: [
      "Culinary-trained Commis Chef / Cook seeking a first kitchen role",
      "Trained in food preparation, basic cooking, and kitchen hygiene; keen to learn the line",
    ],
    certification_phrases: ["Diploma / certificate in Culinary Arts / Cookery", "Food safety (HACCP / FoSTaC) awareness"],
    keywords: ["cook", "commis", "chef", "kitchen", "food preparation", "cookery"],
  }),
  C({
    trade_key: "hosp_room_attendant",
    display_name: "Room Attendant (Housekeeping)",
    headline_template: "{{role}}",
    summary_template:
      "Room Attendant with {{years}} of housekeeping experience in guest-room cleaning and presentation. Strong on standards, speed, and guest-room readiness.",
    core_skills: [
      "Guest-room cleaning and bed making",
      "Bathroom cleaning and sanitisation",
      "Linen and amenity replenishment",
      "Room status reporting",
      "Use of cleaning chemicals and equipment",
    ],
    machine_tools: ["Housekeeping cart", "Vacuum cleaner", "Cleaning chemicals & caddy", "Linen and amenity stock"],
    inspection_tools: ["Room cleaning checklist", "Room status report", "Supervisor inspection / snag list"],
    responsibilities: [
      "Clean and prepare guest rooms to brand standard",
      "Make beds, replenish linen, toiletries, and amenities",
      "Clean and sanitise bathrooms and report maintenance issues",
      "Update room status and hand over lost-and-found items",
    ],
    safety_points: [
      "Safe handling and storage of cleaning chemicals",
      "Slip / trip prevention and wet-floor caution",
      "Guest privacy, security, and lost-and-found discipline",
    ],
    experience_phrases: [
      "Maintained room-readiness targets to inspection standard",
      "Handled guest requests promptly and discreetly",
    ],
    fresher_phrases: [
      "Housekeeping-trained Room Attendant seeking a first hotel role",
      "Trained in room cleaning, bed making, and hygiene standards; reliable and quick",
    ],
    certification_phrases: ["Diploma / certificate in Housekeeping Operations", "Hospitality / hotel management certificate"],
    keywords: ["room attendant", "housekeeping", "cleaning", "hotel", "rooms division", "hospitality"],
  }),
  C({
    trade_key: "hosp_front_office",
    display_name: "Front Office Associate",
    headline_template: "{{role}}",
    summary_template:
      "Front Office Associate with {{years}} of reception and guest-service experience. Strong on check-in/out, guest handling, and front-desk coordination.",
    core_skills: [
      "Guest check-in and check-out",
      "Reservations and front-desk handling",
      "Property management system (PMS) operation",
      "Guest queries and complaint handling",
      "Billing and cash / card handling",
    ],
    machine_tools: ["Front-desk PMS terminal", "Telephone / EPABX", "Card / payment machine", "Key-card encoder"],
    inspection_tools: ["Arrival / departure list", "Front-desk shift checklist", "Guest feedback log"],
    responsibilities: [
      "Welcome guests and complete check-in and check-out",
      "Manage reservations and room allocation on the PMS",
      "Handle guest queries, requests, and complaints courteously",
      "Process billing and coordinate with housekeeping and other departments",
    ],
    safety_points: [
      "Guest data privacy and confidentiality",
      "Cash-handling discipline and secure key-card control",
      "Emergency and guest-safety procedure awareness",
    ],
    experience_phrases: [
      "Delivered smooth check-in/out during high-occupancy periods",
      "Resolved guest issues to maintain satisfaction scores",
    ],
    fresher_phrases: [
      "Hospitality-trained Front Office Associate seeking a first reception role",
      "Trained in front-desk operations, PMS basics, and guest etiquette; confident communicator",
    ],
    certification_phrases: ["Diploma / certificate in Front Office Operations", "Hospitality / hotel management certificate"],
    keywords: ["front office", "reception", "front desk", "guest service", "PMS", "hospitality"],
  }),
  C({
    trade_key: "hosp_fnb_captain",
    display_name: "F&B Captain",
    headline_template: "{{role}}",
    summary_template:
      "F&B Captain with {{years}} of food & beverage service experience leading a service section. Strong on guest experience, team coordination, and service standards.",
    core_skills: [
      "Section / station supervision",
      "Guest experience and complaint handling",
      "Order coordination with kitchen and bar",
      "Service standards and SOP adherence",
      "Billing oversight and upselling",
    ],
    machine_tools: ["POS / billing terminal", "Service station and trolley", "Crockery, cutlery & glassware"],
    inspection_tools: ["Reservation / section plan", "Service mise-en-place checklist", "Guest feedback log"],
    responsibilities: [
      "Lead a service section and brief and guide stewards/waiters",
      "Take orders, coordinate with kitchen and bar, and ensure timely service",
      "Handle guest requests and complaints and maintain service standards",
      "Oversee billing, table turnover, and section mise-en-place",
    ],
    safety_points: [
      "Team grooming and personal-hygiene standards",
      "Food safety, allergen handling, and safe service practices",
      "Spill / breakage management and guest safety",
    ],
    experience_phrases: [
      "Led a service section to consistent guest-satisfaction standards",
      "Coordinated team and kitchen for smooth service flow",
    ],
    fresher_phrases: [
      "Service-trained F&B professional stepping up to a Captain role",
      "Trained in F&B service and section coordination; ready to lead a small team",
    ],
    certification_phrases: ["Diploma / certificate in Food & Beverage Service", "Hospitality / hotel management certificate"],
    keywords: ["F&B captain", "service captain", "restaurant", "supervisor", "guest experience", "hospitality"],
  }),
  C({
    trade_key: "hosp_bartender",
    display_name: "Bartender",
    headline_template: "{{role}}",
    summary_template:
      "Bartender with {{years}} of bar-service experience in drink preparation and guest service. Strong on recipes, bar hygiene, and responsible service.",
    core_skills: [
      "Cocktail and beverage preparation",
      "Bar setup and mise-en-place",
      "Recipe and measure (peg) accuracy",
      "Stock control and bar inventory",
      "Guest service and upselling",
    ],
    machine_tools: ["Cocktail shaker and bar tools", "Blender / juicer", "Ice machine", "Refrigeration / chiller", "POS / billing terminal"],
    inspection_tools: ["Drink recipe / spec card", "Peg measure / jigger", "Bar inventory / consumption log"],
    responsibilities: [
      "Prepare cocktails and beverages to standard recipes and measures",
      "Set up and maintain the bar and mise-en-place",
      "Serve guests, take orders, and handle billing",
      "Manage bar stock, garnish prep, and consumption records",
    ],
    safety_points: [
      "Responsible service of alcohol and age verification",
      "Bar hygiene and safe glassware / breakage handling",
      "Safe handling of ice, blenders, and sharp tools",
    ],
    experience_phrases: [
      "Maintained drink consistency and speed during busy bar service",
      "Managed bar stock with minimal variance",
    ],
    fresher_phrases: [
      "Bar-trained Bartender seeking a first bar-service role",
      "Trained in beverage preparation, bar setup, and hygiene; confident with guests",
    ],
    certification_phrases: ["Certificate in Bartending / Bar Operations", "Food & beverage service certificate"],
    keywords: ["bartender", "bar", "cocktails", "beverage service", "mixology", "hospitality"],
  }),
  C({
    trade_key: "hosp_kitchen_steward",
    display_name: "Kitchen Steward (Utility)",
    headline_template: "{{role}}",
    summary_template:
      "Kitchen Steward with {{years}} of kitchen-utility experience in dishwashing, cleaning, and kitchen support. Reliable on hygiene, speed, and equipment care.",
    core_skills: [
      "Dishwashing and pot-washing",
      "Kitchen and equipment cleaning",
      "Waste segregation and disposal",
      "Cleaning-chemical handling and dilution",
      "Kitchen support and stacking",
    ],
    machine_tools: ["Dishwashing machine", "Sinks and pot-wash area", "Cleaning chemicals & equipment", "Waste-segregation bins"],
    inspection_tools: ["Cleaning schedule / checklist", "Chemical dilution chart", "Hygiene / temperature log"],
    responsibilities: [
      "Wash crockery, cutlery, glassware, and kitchen utensils",
      "Clean kitchen surfaces, floors, and equipment to hygiene standard",
      "Segregate and dispose of waste correctly",
      "Support the kitchen team with stacking and movement of stock",
    ],
    safety_points: [
      "Safe handling, dilution, and storage of cleaning chemicals",
      "Slip / trip prevention and wet-floor caution",
      "Hygiene, handwashing, and cross-contamination control",
    ],
    experience_phrases: [
      "Kept the wash area and kitchen to hygiene standard during busy service",
      "Handled equipment and chemicals safely with no incidents",
    ],
    fresher_phrases: [
      "Reliable Kitchen Steward seeking a first kitchen-utility role",
      "Trained in dishwashing, cleaning, and kitchen hygiene; hardworking and punctual",
    ],
    certification_phrases: ["Food safety / hygiene awareness (FoSTaC)", "Kitchen / stewarding training certificate"],
    keywords: ["kitchen steward", "stewarding", "dishwashing", "utility", "kitchen hygiene", "hospitality"],
  }),
  C({
    trade_key: "hosp_banquet_server",
    display_name: "Banquet Server",
    headline_template: "{{role}}",
    summary_template:
      "Banquet Server with {{years}} of banquet and catering service experience. Strong on event setup, large-volume service, and guest etiquette.",
    core_skills: [
      "Banquet and event table setup",
      "Buffet and plated service",
      "Large-volume food & beverage service",
      "Event mise-en-place and breakdown",
      "Guest handling and coordination",
    ],
    machine_tools: ["Chafing dishes and buffet setup", "Service trays and trolleys", "Crockery, cutlery & glassware", "Banquet tables and linen"],
    inspection_tools: ["Banquet event order (BEO) / function sheet", "Setup checklist", "Buffet replenishment / hygiene check"],
    responsibilities: [
      "Set up banquet halls, buffets, and tables per the function sheet",
      "Serve food and beverages for events (buffet and plated)",
      "Replenish buffets and maintain presentation during the event",
      "Clear and break down the setup after the event",
    ],
    safety_points: [
      "Safe carrying of heavy trays and hot chafing equipment",
      "Food safety and buffet temperature / hygiene control",
      "Crowd, spill, and guest-safety awareness at events",
    ],
    experience_phrases: [
      "Served large banquets and events while maintaining standards",
      "Worked as a team to set up and turn around events on time",
    ],
    fresher_phrases: [
      "Service-trained Banquet Server seeking a first events role",
      "Trained in banquet setup and service; energetic team player for busy events",
    ],
    certification_phrases: ["Diploma / certificate in Food & Beverage Service", "Hospitality / catering certificate"],
    keywords: ["banquet server", "banquet", "catering", "events", "F&B service", "hospitality"],
  }),
  C({
    trade_key: "hosp_barista",
    display_name: "Barista",
    headline_template: "{{role}}",
    summary_template:
      "Barista with {{years}} of café experience in coffee preparation and guest service. Strong on espresso standards, milk texturing, and counter hygiene.",
    core_skills: [
      "Espresso and coffee preparation",
      "Milk steaming and latte art basics",
      "Grinder calibration and dosing",
      "Café counter and POS handling",
      "Beverage recipe and portion consistency",
    ],
    machine_tools: ["Espresso machine", "Coffee grinder", "Blender", "Refrigeration / chiller", "POS / billing terminal"],
    inspection_tools: ["Beverage recipe / spec card", "Shot timer and scale", "Counter cleaning / hygiene checklist"],
    responsibilities: [
      "Prepare espresso-based and other beverages to standard recipes",
      "Steam and texture milk and maintain drink consistency",
      "Operate the café counter, take orders, and handle billing",
      "Clean and maintain the machine, grinder, and counter hygiene",
    ],
    safety_points: [
      "Hot-surface, steam, and machine safety",
      "Food safety, milk handling, and counter hygiene",
      "Safe handling of cleaning chemicals for machine backflush",
    ],
    experience_phrases: [
      "Maintained drink quality and speed during peak café hours",
      "Kept the machine and counter to hygiene and quality standard",
    ],
    fresher_phrases: [
      "Café-trained Barista seeking a first coffee-service role",
      "Trained in espresso preparation, milk texturing, and counter service; friendly and quick",
    ],
    certification_phrases: ["Barista / coffee-craft certificate", "Food & beverage service certificate"],
    keywords: ["barista", "coffee", "espresso", "cafe", "beverage service", "hospitality"],
  }),
];

/**
 * Required hospitality trades (DRAFTED, pending RVM). Parallels manufacturing's
 * `REQUIRED_TRADE_KEYS`; the presence/shape tests assert all are present. Kept
 * SEPARATE from the manufacturing list so manufacturing acceptance is unaffected.
 */
export const REQUIRED_HOSP_TRADE_KEYS = [
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

const BY_KEY = new Map(HOSPITALITY_TRADE_CONTENT.map((t) => [t.trade_key, t]));

/** Look up hospitality trade content by its stable trade_key (draft vertical). */
export function getHospitalityTradeContent(tradeKey: string): TradeContent | undefined {
  return BY_KEY.get(tradeKey);
}
