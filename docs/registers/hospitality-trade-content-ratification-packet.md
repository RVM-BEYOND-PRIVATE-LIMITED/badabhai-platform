# Hospitality Trade Content Ratification Packet — 9 trades for RVM sign-off

> **HUMAN GATE — DRAFTED, PENDING RVM. NOT FINAL / NOT APPROVED / NOT LIVE.**
> Everything in this packet is **drafted by engineering** and **generated verbatim**
> from the source `.ts` files for RVM to read and ratify trade-by-trade. No trade is
> "final" or "approved" until a named RVM reviewer records a **PASS** verdict against
> it in the companion register's checklist. Unlike the manufacturing packet, this
> hospitality content is **NOT live as a default** — the second vertical renders
> nowhere live until per-trade RVM PASS (it is not wired into the live resolver and
> has no profiling/job surface yet).

**This is HANDOFF + GATE packaging, not new authoring claims of accuracy.** The text
below is generated directly from the two source files; nothing is paraphrased. RVM
ratification is a human judgement on **hospitality trade accuracy** (vocabulary,
realistic questions, natural Hinglish, hygiene/safety, resume copy) — green CI tests
prove **presence/shape only, not accuracy**.

Assembled 2026-06-18. Gate owner: **RVM (hospitality subject-matter review)**.
Drafts: ai-engineer / technical-writer / engineering.

Source files (generated from, keep in sync):
[hospitality-trade-content.ts](../../apps/api/src/resume/hospitality-trade-content.ts)
(`HOSPITALITY_TRADE_CONTENT`) ·
[hospitality-interview-kit-content.ts](../../apps/api/src/interview-kit/hospitality-interview-kit-content.ts)
(`HOSPITALITY_INTERVIEW_KITS`).

Tracking matrix + per-trade verdict checklist:
[hospitality-trade-content-ratification.md](./hospitality-trade-content-ratification.md)
(update both in the same sitting so they do not drift).

Field-semantics note (PRD §5): hospitality reuses the **exact** manufacturing
interfaces (no new fields, **no adjacency map**). `machine_tools` reads as service/
kitchen **equipment**, `inspection_tools` as service **tools/checks**, `safety_points`
/ `safety_questions` as **hygiene + safety**, `drawing_measurement_questions` as
**standards/measurement** questions.

---

## Per-trade content (×9) — generated verbatim from source

### 1. Steward / Waiter — `hosp_steward_waiter`

**Resume content** (`TradeContent`)

- **headline_template:** {{role}}
- **summary_template:** Steward / Waiter with {{years}} of food & beverage service experience. Strong on guest service, order taking, and table etiquette with attention to hygiene and speed.
- **core_skills:**
  - Food & beverage service (table / room)
  - Order taking and KOT punching
  - Table laying and cover setup
  - Menu and dish knowledge
  - Guest handling and upselling
- **machine_tools (equipment):**
  - POS / billing terminal
  - Service tray and trolley
  - Crockery, cutlery & glassware
  - Chafing dishes
- **inspection_tools (service tools/checks):**
  - Order pad / KOT
  - Table setup checklist
  - Cleanliness / mise-en-place check
- **responsibilities:**
  - Greet and seat guests and present the menu
  - Take and relay orders accurately and serve food and beverages
  - Lay tables, maintain mise-en-place, and clear and reset covers
  - Handle billing and guest queries courteously
- **safety_points (hygiene + safety):**
  - Personal hygiene and grooming standards
  - Safe carrying of hot dishes and handling of breakage
  - Food safety and allergen awareness while serving
- **experience_phrases:**
  - Handled busy service shifts while maintaining service standards
  - Built rapport with guests and supported upselling
- **fresher_phrases:**
  - Hospitality-trained Steward / Waiter seeking a first F&B service role
  - Trained in table service, order taking, and guest etiquette; eager to learn on the floor
- **certification_phrases:**
  - Diploma / certificate in Food & Beverage Service
  - Hospitality / hotel management certificate
- **keywords:** waiter, steward, F&B service, restaurant, guest service, hospitality

**Interview kit** (`InterviewKitContent`)

- **overview:** A Steward / Waiter interview checks whether you can serve guests well, take orders correctly, lay a table, and keep hygiene and speed during service. Expect basic service questions, a few practical ones, and hygiene/safety questions.
- **common_questions:**
  - What is the correct sequence of service at a table?
  - How do you take an order and punch a KOT?
  - How do you handle a guest complaint about food or service?
  - What is the difference between a la carte and buffet service?
  - How do you upsell a dish or beverage politely?
- **practical_questions:**
  - Lay a basic cover for a table — what goes where?
  - How do you carry and serve hot plates safely?
  - How do you clear and reset a table between guests?
- **safety_questions (hygiene + safety):**
  - What personal hygiene and grooming standards do you follow?
  - How do you serve a guest with a food allergy?
  - What do you do if you drop or break crockery during service?
- **drawing_measurement_questions (standards/measurement):**
  - How do you ensure the bill matches what the guest ordered?
  - How do you check that a dish is served at the right portion and temperature?
  - How do you confirm a table is set to the correct standard before service?
- **skill_checklist:**
  - Food & beverage service sequence
  - Order taking and KOT
  - Table laying and cover setup
  - Guest handling and complaint resolution
  - Hygiene and grooming
- **revise_before:**
  - Sequence of service and table etiquette
  - Cover setup (cutlery, crockery, glassware placement)
  - Common menu terms and dish knowledge
  - How to handle complaints calmly
- **documents_to_carry:**
  - Aadhaar card (original + photocopy)
  - Hospitality diploma / certificates and marksheets (if any)
  - Experience / relieving letters (if any)
  - 2 passport-size photographs
  - Updated resume (BadaBhai resume printout)
- **common_mistakes:**
  - Saying you know service styles you have not actually done
  - Forgetting to mention hygiene and grooming
  - Not listening fully to the guest's order
- **hinglish_note:** Tip: Guest se hamesha politely aur smile ke saath baat karna. Order dhyan se lena aur repeat karke confirm karna. Hygiene aur grooming ki baat zaroor bolna.

---

### 2. Commis Chef / Cook — `hosp_commis_cook`

**Resume content** (`TradeContent`)

- **headline_template:** {{role}}
- **summary_template:** Commis Chef / Cook with {{years}} of kitchen experience in food preparation and cooking. Reliable on mise-en-place, recipe adherence, and kitchen hygiene.
- **core_skills:**
  - Food preparation and mise-en-place
  - Cooking to standard recipes and portion control
  - Knife skills and basic cuts
  - Station setup and stock rotation (FIFO)
  - Kitchen hygiene (HACCP basics)
- **machine_tools (equipment):**
  - Cooking range / burners
  - Oven and salamander
  - Deep fryer
  - Food processor / mixer
  - Refrigeration / cold storage
- **inspection_tools (service tools/checks):**
  - Standard recipe / spec card
  - Food thermometer
  - Portion scale
  - Temperature / hygiene log
- **responsibilities:**
  - Prepare ingredients and complete mise-en-place before service
  - Cook dishes to standard recipes and maintain portion control
  - Keep the station clean and stock rotated (FIFO)
  - Support senior chefs during service and plating
- **safety_points (hygiene + safety):**
  - Food safety and HACCP — storage temperatures and labelling
  - Safe knife handling and hot-surface / fryer safety
  - Personal hygiene, handwashing, and cross-contamination control
- **experience_phrases:**
  - Maintained mise-en-place and consistent dish quality under pressure
  - Followed standard recipes and reduced wastage
- **fresher_phrases:**
  - Culinary-trained Commis Chef / Cook seeking a first kitchen role
  - Trained in food preparation, basic cooking, and kitchen hygiene; keen to learn the line
- **certification_phrases:**
  - Diploma / certificate in Culinary Arts / Cookery
  - Food safety (HACCP / FoSTaC) awareness
- **keywords:** cook, commis, chef, kitchen, food preparation, cookery

**Interview kit** (`InterviewKitContent`)

- **overview:** A Commis Chef / Cook interview checks your food preparation, basic cooking, recipe and portion knowledge, and kitchen hygiene. Expect basic questions, practical cooking questions, and food-safety questions.
- **common_questions:**
  - What is mise-en-place and why is it important?
  - Which sections (stations) of the kitchen have you worked in?
  - How do you follow a standard recipe and keep portions consistent?
  - What is FIFO and how do you rotate stock?
  - How do you support the chef during a busy service?
- **practical_questions:**
  - Show the basic knife cuts you know (julienne, dice, etc.).
  - How would you prepare and set up your station before service?
  - How do you check if cooked food is ready and safe to serve?
- **safety_questions (hygiene + safety):**
  - What are the correct storage temperatures for raw and cooked food?
  - How do you prevent cross-contamination in the kitchen?
  - How do you handle hot surfaces, oil, and the fryer safely?
- **drawing_measurement_questions (standards/measurement):**
  - How do you measure portions to a recipe spec card?
  - How do you use a food thermometer to check cooking temperature?
  - How do you weigh and scale ingredients for consistency?
- **skill_checklist:**
  - Mise-en-place and station setup
  - Standard recipes and portion control
  - Knife skills and basic cooking
  - Stock rotation (FIFO)
  - Food safety / HACCP basics
- **revise_before:**
  - Food storage temperatures and HACCP basics
  - Standard recipe and portion control
  - Basic knife cuts and cooking methods
  - Cross-contamination prevention
- **documents_to_carry:**
  - Aadhaar card (original + photocopy)
  - Hospitality diploma / certificates and marksheets (if any)
  - Experience / relieving letters (if any)
  - 2 passport-size photographs
  - Updated resume (BadaBhai resume printout)
- **common_mistakes:**
  - Claiming a station or dish you have not actually cooked
  - Forgetting food-safety and storage temperatures
  - Not mentioning mise-en-place and FIFO
- **hinglish_note:** Tip: Jo station aur dishes aapne banayi hain sirf wahi bolna. Food safety aur storage temperature ki baat confident hoke karna. Mise-en-place aur hygiene ka dhyan zaroor mention karna.

---

### 3. Room Attendant (Housekeeping) — `hosp_room_attendant`

**Resume content** (`TradeContent`)

- **headline_template:** {{role}}
- **summary_template:** Room Attendant with {{years}} of housekeeping experience in guest-room cleaning and presentation. Strong on standards, speed, and guest-room readiness.
- **core_skills:**
  - Guest-room cleaning and bed making
  - Bathroom cleaning and sanitisation
  - Linen and amenity replenishment
  - Room status reporting
  - Use of cleaning chemicals and equipment
- **machine_tools (equipment):**
  - Housekeeping cart
  - Vacuum cleaner
  - Cleaning chemicals & caddy
  - Linen and amenity stock
- **inspection_tools (service tools/checks):**
  - Room cleaning checklist
  - Room status report
  - Supervisor inspection / snag list
- **responsibilities:**
  - Clean and prepare guest rooms to brand standard
  - Make beds, replenish linen, toiletries, and amenities
  - Clean and sanitise bathrooms and report maintenance issues
  - Update room status and hand over lost-and-found items
- **safety_points (hygiene + safety):**
  - Safe handling and storage of cleaning chemicals
  - Slip / trip prevention and wet-floor caution
  - Guest privacy, security, and lost-and-found discipline
- **experience_phrases:**
  - Maintained room-readiness targets to inspection standard
  - Handled guest requests promptly and discreetly
- **fresher_phrases:**
  - Housekeeping-trained Room Attendant seeking a first hotel role
  - Trained in room cleaning, bed making, and hygiene standards; reliable and quick
- **certification_phrases:**
  - Diploma / certificate in Housekeeping Operations
  - Hospitality / hotel management certificate
- **keywords:** room attendant, housekeeping, cleaning, hotel, rooms division, hospitality

**Interview kit** (`InterviewKitContent`)

- **overview:** A Room Attendant interview checks whether you can clean and prepare guest rooms to standard, handle linen and amenities, and follow hygiene and safety. Expect basic questions, practical cleaning questions, and safety questions.
- **common_questions:**
  - What is the correct sequence for cleaning a guest room?
  - How do you make a bed to hotel standard?
  - How do you handle a Do-Not-Disturb or occupied room?
  - What room statuses do you report and how?
  - What do you do with lost-and-found items?
- **practical_questions:**
  - Show how you would clean and sanitise a bathroom.
  - How do you stock and organise your housekeeping cart?
  - How do you clean a room quickly without missing standards?
- **safety_questions (hygiene + safety):**
  - How do you handle and store cleaning chemicals safely?
  - How do you prevent slips and falls while cleaning?
  - How do you protect guest privacy and room security?
- **drawing_measurement_questions (standards/measurement):**
  - How do you check a room is fully ready against the cleaning checklist?
  - What standard do you follow for bed making and linen presentation?
  - How do you confirm amenities are replenished to the correct count?
- **skill_checklist:**
  - Guest-room cleaning sequence
  - Bed making and linen handling
  - Bathroom sanitisation
  - Room status reporting
  - Chemical handling and safety
- **revise_before:**
  - Room cleaning sequence and standards
  - Bed-making steps
  - Cleaning-chemical safety and dilution
  - Room status codes
- **documents_to_carry:**
  - Aadhaar card (original + photocopy)
  - Hospitality diploma / certificates and marksheets (if any)
  - Experience / relieving letters (if any)
  - 2 passport-size photographs
  - Updated resume (BadaBhai resume printout)
- **common_mistakes:**
  - Skipping steps in the cleaning checklist
  - Forgetting chemical-safety and slip prevention
  - Not respecting guest privacy and security
- **hinglish_note:** Tip: Room cleaning ka sequence aur checklist achhe se yaad rakhna. Chemicals safely use karna aur guest ki privacy ka dhyan rakhna. Kaam fast ke saath standard maintain karna.

---

### 4. Front Office Associate — `hosp_front_office`

**Resume content** (`TradeContent`)

- **headline_template:** {{role}}
- **summary_template:** Front Office Associate with {{years}} of reception and guest-service experience. Strong on check-in/out, guest handling, and front-desk coordination.
- **core_skills:**
  - Guest check-in and check-out
  - Reservations and front-desk handling
  - Property management system (PMS) operation
  - Guest queries and complaint handling
  - Billing and cash / card handling
- **machine_tools (equipment):**
  - Front-desk PMS terminal
  - Telephone / EPABX
  - Card / payment machine
  - Key-card encoder
- **inspection_tools (service tools/checks):**
  - Arrival / departure list
  - Front-desk shift checklist
  - Guest feedback log
- **responsibilities:**
  - Welcome guests and complete check-in and check-out
  - Manage reservations and room allocation on the PMS
  - Handle guest queries, requests, and complaints courteously
  - Process billing and coordinate with housekeeping and other departments
- **safety_points (hygiene + safety):**
  - Guest data privacy and confidentiality
  - Cash-handling discipline and secure key-card control
  - Emergency and guest-safety procedure awareness
- **experience_phrases:**
  - Delivered smooth check-in/out during high-occupancy periods
  - Resolved guest issues to maintain satisfaction scores
- **fresher_phrases:**
  - Hospitality-trained Front Office Associate seeking a first reception role
  - Trained in front-desk operations, PMS basics, and guest etiquette; confident communicator
- **certification_phrases:**
  - Diploma / certificate in Front Office Operations
  - Hospitality / hotel management certificate
- **keywords:** front office, reception, front desk, guest service, PMS, hospitality

**Interview kit** (`InterviewKitContent`)

- **overview:** A Front Office Associate interview checks your guest handling, check-in/out, PMS basics, and complaint handling. Expect communication-focused questions, practical front-desk questions, and safety/privacy questions.
- **common_questions:**
  - Walk me through the check-in and check-out process.
  - How do you handle a guest complaint at the desk?
  - What is a PMS and which ones have you used?
  - How do you handle a walk-in when the hotel is nearly full?
  - How do you coordinate with housekeeping for room readiness?
- **practical_questions:**
  - A guest's room is not ready at check-in — what do you do?
  - How do you handle a billing dispute at check-out?
  - How do you take and confirm a reservation?
- **safety_questions (hygiene + safety):**
  - How do you protect guest data and confidentiality?
  - How do you handle cash and card payments securely?
  - What do you do during a fire alarm or emergency at the desk?
- **drawing_measurement_questions (standards/measurement):**
  - How do you ensure a guest bill is accurate before check-out?
  - How do you verify room allocation against the arrival list?
  - How do you confirm a reservation's dates, rate, and room type are correct?
- **skill_checklist:**
  - Check-in / check-out process
  - PMS operation basics
  - Guest communication and complaint handling
  - Billing and cash/card handling
  - Data privacy and security
- **revise_before:**
  - Check-in/out steps and PMS basics
  - Complaint-handling approach (listen, empathise, resolve)
  - Billing and payment handling
  - Guest-data privacy rules
- **documents_to_carry:**
  - Aadhaar card (original + photocopy)
  - Hospitality diploma / certificates and marksheets (if any)
  - Experience / relieving letters (if any)
  - 2 passport-size photographs
  - Updated resume (BadaBhai resume printout)
- **common_mistakes:**
  - Weak or unclear communication with the guest
  - Mishandling a billing or reservation detail
  - Forgetting guest-data privacy and security
- **hinglish_note:** Tip: Front desk par communication clear aur polite honi chahiye. Check-in/out aur PMS ke steps confident hoke batao. Guest ki privacy aur billing accuracy ka dhyan rakhna.

---

### 5. F&B Captain — `hosp_fnb_captain`

**Resume content** (`TradeContent`)

- **headline_template:** {{role}}
- **summary_template:** F&B Captain with {{years}} of food & beverage service experience leading a service section. Strong on guest experience, team coordination, and service standards.
- **core_skills:**
  - Section / station supervision
  - Guest experience and complaint handling
  - Order coordination with kitchen and bar
  - Service standards and SOP adherence
  - Billing oversight and upselling
- **machine_tools (equipment):**
  - POS / billing terminal
  - Service station and trolley
  - Crockery, cutlery & glassware
- **inspection_tools (service tools/checks):**
  - Reservation / section plan
  - Service mise-en-place checklist
  - Guest feedback log
- **responsibilities:**
  - Lead a service section and brief and guide stewards/waiters
  - Take orders, coordinate with kitchen and bar, and ensure timely service
  - Handle guest requests and complaints and maintain service standards
  - Oversee billing, table turnover, and section mise-en-place
- **safety_points (hygiene + safety):**
  - Team grooming and personal-hygiene standards
  - Food safety, allergen handling, and safe service practices
  - Spill / breakage management and guest safety
- **experience_phrases:**
  - Led a service section to consistent guest-satisfaction standards
  - Coordinated team and kitchen for smooth service flow
- **fresher_phrases:**
  - Service-trained F&B professional stepping up to a Captain role
  - Trained in F&B service and section coordination; ready to lead a small team
- **certification_phrases:**
  - Diploma / certificate in Food & Beverage Service
  - Hospitality / hotel management certificate
- **keywords:** F&B captain, service captain, restaurant, supervisor, guest experience, hospitality

**Interview kit** (`InterviewKitContent`)

- **overview:** An F&B Captain interview checks whether you can lead a service section, manage guest experience, coordinate with kitchen and bar, and uphold standards. Expect service-leadership questions, practical coordination questions, and hygiene/safety questions.
- **common_questions:**
  - How do you brief and lead your service team before a shift?
  - How do you handle a difficult guest or a service complaint?
  - How do you coordinate orders between the table, kitchen, and bar?
  - How do you manage table turnover during a busy service?
  - How do you ensure service standards and SOPs are followed?
- **practical_questions:**
  - A table's order is delayed in the kitchen — how do you manage the guest?
  - How do you plan a section's mise-en-place before service?
  - How do you handle a billing error in front of a guest?
- **safety_questions (hygiene + safety):**
  - How do you ensure your team's grooming and hygiene standards?
  - How do you handle food-allergy requests across the section?
  - How do you manage a spill or breakage safely during service?
- **drawing_measurement_questions (standards/measurement):**
  - How do you check a section's bills are accurate at settlement?
  - How do you ensure dishes meet portion and presentation standards?
  - How do you confirm the section is set to standard before guests arrive?
- **skill_checklist:**
  - Section supervision and team briefing
  - Guest experience and complaint handling
  - Kitchen/bar coordination
  - Service standards and SOPs
  - Billing oversight
- **revise_before:**
  - Service standards and SOPs
  - Team coordination and briefing
  - Complaint handling and guest recovery
  - Section mise-en-place planning
- **documents_to_carry:**
  - Aadhaar card (original + photocopy)
  - Hospitality diploma / certificates and marksheets (if any)
  - Experience / relieving letters (if any)
  - 2 passport-size photographs
  - Updated resume (BadaBhai resume printout)
- **common_mistakes:**
  - Not taking ownership of the section's standards
  - Poor coordination with kitchen and bar
  - Weak handling of guest complaints
- **hinglish_note:** Tip: Captain ka kaam team ko lead karna aur guest ka experience smooth rakhna hai. Kitchen aur bar ke saath coordination achhi honi chahiye. Standards aur complaint handling par confident raho.

---

### 6. Bartender — `hosp_bartender`

**Resume content** (`TradeContent`)

- **headline_template:** {{role}}
- **summary_template:** Bartender with {{years}} of bar-service experience in drink preparation and guest service. Strong on recipes, bar hygiene, and responsible service.
- **core_skills:**
  - Cocktail and beverage preparation
  - Bar setup and mise-en-place
  - Recipe and measure (peg) accuracy
  - Stock control and bar inventory
  - Guest service and upselling
- **machine_tools (equipment):**
  - Cocktail shaker and bar tools
  - Blender / juicer
  - Ice machine
  - Refrigeration / chiller
  - POS / billing terminal
- **inspection_tools (service tools/checks):**
  - Drink recipe / spec card
  - Peg measure / jigger
  - Bar inventory / consumption log
- **responsibilities:**
  - Prepare cocktails and beverages to standard recipes and measures
  - Set up and maintain the bar and mise-en-place
  - Serve guests, take orders, and handle billing
  - Manage bar stock, garnish prep, and consumption records
- **safety_points (hygiene + safety):**
  - Responsible service of alcohol and age verification
  - Bar hygiene and safe glassware / breakage handling
  - Safe handling of ice, blenders, and sharp tools
- **experience_phrases:**
  - Maintained drink consistency and speed during busy bar service
  - Managed bar stock with minimal variance
- **fresher_phrases:**
  - Bar-trained Bartender seeking a first bar-service role
  - Trained in beverage preparation, bar setup, and hygiene; confident with guests
- **certification_phrases:**
  - Certificate in Bartending / Bar Operations
  - Food & beverage service certificate
- **keywords:** bartender, bar, cocktails, beverage service, mixology, hospitality

**Interview kit** (`InterviewKitContent`)

- **overview:** A Bartender interview checks your drink preparation, recipe and measure accuracy, bar setup, and responsible service. Expect beverage questions, practical preparation questions, and hygiene/safety questions.
- **common_questions:**
  - Which cocktails and beverages can you prepare?
  - How do you set up and maintain your bar (mise-en-place)?
  - How do you keep drink recipes and measures consistent?
  - How do you manage bar stock and reduce variance?
  - How do you handle an intoxicated or underage guest?
- **practical_questions:**
  - Explain the steps to prepare a common cocktail to recipe.
  - How do you set up the bar before service?
  - How do you measure a peg accurately and consistently?
- **safety_questions (hygiene + safety):**
  - How do you practise responsible service of alcohol?
  - How do you handle glassware and breakage safely?
  - How do you keep the bar hygienic and clean during service?
- **drawing_measurement_questions (standards/measurement):**
  - How do you measure a peg/spirit to the correct quantity?
  - How do you follow a cocktail recipe's exact proportions?
  - How do you reconcile bar consumption against sales at closing?
- **skill_checklist:**
  - Cocktail and beverage preparation
  - Bar setup and mise-en-place
  - Recipe and measure accuracy
  - Stock control
  - Responsible service and hygiene
- **revise_before:**
  - Common cocktail recipes and measures
  - Bar setup and mise-en-place
  - Responsible service of alcohol
  - Bar hygiene standards
- **documents_to_carry:**
  - Aadhaar card (original + photocopy)
  - Hospitality diploma / certificates and marksheets (if any)
  - Experience / relieving letters (if any)
  - 2 passport-size photographs
  - Updated resume (BadaBhai resume printout)
- **common_mistakes:**
  - Claiming cocktails you cannot actually prepare
  - Inconsistent measures and recipes
  - Forgetting responsible service and bar hygiene
- **hinglish_note:** Tip: Jo drinks aap bana sakte ho sirf wahi bolna. Peg aur recipe ka measure hamesha accurate rakhna. Responsible service aur bar hygiene ki baat zaroor karna.

---

### 7. Kitchen Steward (Utility) — `hosp_kitchen_steward`

**Resume content** (`TradeContent`)

- **headline_template:** {{role}}
- **summary_template:** Kitchen Steward with {{years}} of kitchen-utility experience in dishwashing, cleaning, and kitchen support. Reliable on hygiene, speed, and equipment care.
- **core_skills:**
  - Dishwashing and pot-washing
  - Kitchen and equipment cleaning
  - Waste segregation and disposal
  - Cleaning-chemical handling and dilution
  - Kitchen support and stacking
- **machine_tools (equipment):**
  - Dishwashing machine
  - Sinks and pot-wash area
  - Cleaning chemicals & equipment
  - Waste-segregation bins
- **inspection_tools (service tools/checks):**
  - Cleaning schedule / checklist
  - Chemical dilution chart
  - Hygiene / temperature log
- **responsibilities:**
  - Wash crockery, cutlery, glassware, and kitchen utensils
  - Clean kitchen surfaces, floors, and equipment to hygiene standard
  - Segregate and dispose of waste correctly
  - Support the kitchen team with stacking and movement of stock
- **safety_points (hygiene + safety):**
  - Safe handling, dilution, and storage of cleaning chemicals
  - Slip / trip prevention and wet-floor caution
  - Hygiene, handwashing, and cross-contamination control
- **experience_phrases:**
  - Kept the wash area and kitchen to hygiene standard during busy service
  - Handled equipment and chemicals safely with no incidents
- **fresher_phrases:**
  - Reliable Kitchen Steward seeking a first kitchen-utility role
  - Trained in dishwashing, cleaning, and kitchen hygiene; hardworking and punctual
- **certification_phrases:**
  - Food safety / hygiene awareness (FoSTaC)
  - Kitchen / stewarding training certificate
- **keywords:** kitchen steward, stewarding, dishwashing, utility, kitchen hygiene, hospitality

**Interview kit** (`InterviewKitContent`)

- **overview:** A Kitchen Steward interview checks whether you can wash and clean to hygiene standard, handle chemicals and equipment safely, and support the kitchen. Expect basic questions, practical cleaning questions, and hygiene/safety questions.
- **common_questions:**
  - What is the correct way to wash crockery and utensils?
  - How do you operate and load a dishwashing machine?
  - How do you segregate kitchen waste?
  - How do you keep the wash area clean during busy service?
  - How do you support the kitchen team during peak hours?
- **practical_questions:**
  - How do you clean a greasy pot or burnt utensil?
  - How do you set up the dishwashing area at the start of a shift?
  - How do you dilute and use a cleaning chemical correctly?
- **safety_questions (hygiene + safety):**
  - How do you handle and store cleaning chemicals safely?
  - How do you prevent slips on a wet kitchen floor?
  - How do you avoid cross-contamination while cleaning?
- **drawing_measurement_questions (standards/measurement):**
  - How do you dilute a chemical to the correct ratio?
  - How do you check cleaned items meet the hygiene standard?
  - How do you follow the cleaning schedule and checklist?
- **skill_checklist:**
  - Dishwashing and pot-washing
  - Equipment and area cleaning
  - Waste segregation
  - Chemical handling and dilution
  - Kitchen support
- **revise_before:**
  - Cleaning sequence and hygiene standards
  - Chemical dilution and safety
  - Waste segregation rules
  - Dishwashing machine operation
- **documents_to_carry:**
  - Aadhaar card (original + photocopy)
  - Hospitality diploma / certificates and marksheets (if any)
  - Experience / relieving letters (if any)
  - 2 passport-size photographs
  - Updated resume (BadaBhai resume printout)
- **common_mistakes:**
  - Using chemicals without correct dilution or PPE
  - Forgetting slip prevention and wet-floor signs
  - Not keeping the wash area organised during service
- **hinglish_note:** Tip: Cleaning ka sequence aur chemical dilution sahi rakhna. Wet floor par slip se bachna aur safety ka dhyan rakhna. Mehnat aur hygiene dono important hain.

---

### 8. Banquet Server — `hosp_banquet_server`

**Resume content** (`TradeContent`)

- **headline_template:** {{role}}
- **summary_template:** Banquet Server with {{years}} of banquet and catering service experience. Strong on event setup, large-volume service, and guest etiquette.
- **core_skills:**
  - Banquet and event table setup
  - Buffet and plated service
  - Large-volume food & beverage service
  - Event mise-en-place and breakdown
  - Guest handling and coordination
- **machine_tools (equipment):**
  - Chafing dishes and buffet setup
  - Service trays and trolleys
  - Crockery, cutlery & glassware
  - Banquet tables and linen
- **inspection_tools (service tools/checks):**
  - Banquet event order (BEO) / function sheet
  - Setup checklist
  - Buffet replenishment / hygiene check
- **responsibilities:**
  - Set up banquet halls, buffets, and tables per the function sheet
  - Serve food and beverages for events (buffet and plated)
  - Replenish buffets and maintain presentation during the event
  - Clear and break down the setup after the event
- **safety_points (hygiene + safety):**
  - Safe carrying of heavy trays and hot chafing equipment
  - Food safety and buffet temperature / hygiene control
  - Crowd, spill, and guest-safety awareness at events
- **experience_phrases:**
  - Served large banquets and events while maintaining standards
  - Worked as a team to set up and turn around events on time
- **fresher_phrases:**
  - Service-trained Banquet Server seeking a first events role
  - Trained in banquet setup and service; energetic team player for busy events
- **certification_phrases:**
  - Diploma / certificate in Food & Beverage Service
  - Hospitality / catering certificate
- **keywords:** banquet server, banquet, catering, events, F&B service, hospitality

**Interview kit** (`InterviewKitContent`)

- **overview:** A Banquet Server interview checks whether you can set up events, serve large volumes (buffet and plated), and follow the function sheet and hygiene. Expect service questions, practical setup questions, and safety questions.
- **common_questions:**
  - What is a banquet event order (BEO) / function sheet and how do you use it?
  - What is the difference between buffet and plated banquet service?
  - How do you set up a banquet hall and buffet?
  - How do you serve a large number of guests on time?
  - How do you replenish a buffet during an event?
- **practical_questions:**
  - Set up a banquet table and buffet line — what is the sequence?
  - How do you carry and serve multiple plates safely?
  - How do you break down and reset after an event?
- **safety_questions (hygiene + safety):**
  - How do you carry heavy trays and hot chafing equipment safely?
  - How do you keep buffet food at safe temperatures?
  - How do you manage spills and guest safety at a crowded event?
- **drawing_measurement_questions (standards/measurement):**
  - How do you set up against the function sheet's headcount and layout?
  - How do you keep buffet portions and presentation consistent?
  - How do you check chafing-dish food temperatures during the event?
- **skill_checklist:**
  - Banquet and buffet setup
  - Plated and buffet service
  - Function-sheet reading
  - Event mise-en-place and breakdown
  - Hygiene and safety
- **revise_before:**
  - Banquet setup sequence
  - Buffet temperature and hygiene control
  - Function sheet / BEO basics
  - Safe carrying of trays and chafing equipment
- **documents_to_carry:**
  - Aadhaar card (original + photocopy)
  - Hospitality diploma / certificates and marksheets (if any)
  - Experience / relieving letters (if any)
  - 2 passport-size photographs
  - Updated resume (BadaBhai resume printout)
- **common_mistakes:**
  - Not following the function sheet for setup
  - Letting buffet food fall out of safe temperature
  - Unsafe carrying of heavy or hot items
- **hinglish_note:** Tip: Function sheet ke hisaab se setup karna aur time par service dena. Buffet ka temperature aur hygiene maintain rakhna. Heavy aur hot items safely carry karna.

---

### 9. Barista — `hosp_barista`

**Resume content** (`TradeContent`)

- **headline_template:** {{role}}
- **summary_template:** Barista with {{years}} of café experience in coffee preparation and guest service. Strong on espresso standards, milk texturing, and counter hygiene.
- **core_skills:**
  - Espresso and coffee preparation
  - Milk steaming and latte art basics
  - Grinder calibration and dosing
  - Café counter and POS handling
  - Beverage recipe and portion consistency
- **machine_tools (equipment):**
  - Espresso machine
  - Coffee grinder
  - Blender
  - Refrigeration / chiller
  - POS / billing terminal
- **inspection_tools (service tools/checks):**
  - Beverage recipe / spec card
  - Shot timer and scale
  - Counter cleaning / hygiene checklist
- **responsibilities:**
  - Prepare espresso-based and other beverages to standard recipes
  - Steam and texture milk and maintain drink consistency
  - Operate the café counter, take orders, and handle billing
  - Clean and maintain the machine, grinder, and counter hygiene
- **safety_points (hygiene + safety):**
  - Hot-surface, steam, and machine safety
  - Food safety, milk handling, and counter hygiene
  - Safe handling of cleaning chemicals for machine backflush
- **experience_phrases:**
  - Maintained drink quality and speed during peak café hours
  - Kept the machine and counter to hygiene and quality standard
- **fresher_phrases:**
  - Café-trained Barista seeking a first coffee-service role
  - Trained in espresso preparation, milk texturing, and counter service; friendly and quick
- **certification_phrases:**
  - Barista / coffee-craft certificate
  - Food & beverage service certificate
- **keywords:** barista, coffee, espresso, cafe, beverage service, hospitality

**Interview kit** (`InterviewKitContent`)

- **overview:** A Barista interview checks your coffee preparation, espresso and milk skills, machine handling, and counter hygiene. Expect beverage questions, practical preparation questions, and hygiene/safety questions.
- **common_questions:**
  - Walk me through preparing an espresso and a cappuccino.
  - How do you steam and texture milk?
  - How do you calibrate the grinder and dose for a shot?
  - How do you keep drink quality consistent during a rush?
  - How do you handle a guest who is unhappy with their coffee?
- **practical_questions:**
  - Pull a shot and explain what a good extraction looks like.
  - How do you clean and backflush the espresso machine?
  - How do you set up the café counter before opening?
- **safety_questions (hygiene + safety):**
  - How do you work safely around hot surfaces and steam?
  - How do you keep milk and the counter food-safe?
  - How do you handle cleaning chemicals for machine cleaning?
- **drawing_measurement_questions (standards/measurement):**
  - How do you weigh the dose and time the shot for consistency?
  - How do you follow a beverage recipe's exact proportions?
  - How do you check the grind and adjust for a correct extraction?
- **skill_checklist:**
  - Espresso and coffee preparation
  - Milk steaming and texturing
  - Grinder calibration and dosing
  - Counter and POS handling
  - Machine cleaning and hygiene
- **revise_before:**
  - Espresso and milk basics
  - Grinder dosing and shot timing
  - Machine cleaning and backflush
  - Counter hygiene standards
- **documents_to_carry:**
  - Aadhaar card (original + photocopy)
  - Hospitality diploma / certificates and marksheets (if any)
  - Experience / relieving letters (if any)
  - 2 passport-size photographs
  - Updated resume (BadaBhai resume printout)
- **common_mistakes:**
  - Claiming machine skills you have not used
  - Inconsistent dose and shot timing
  - Forgetting machine cleaning and counter hygiene
- **hinglish_note:** Tip: Espresso aur milk texturing confident hoke dikhana. Dose aur shot timing consistent rakhna. Machine cleaning aur counter hygiene ki baat zaroor karna.

---

