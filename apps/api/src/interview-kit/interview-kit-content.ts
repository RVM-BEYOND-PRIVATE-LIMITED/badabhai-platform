/**
 * Per-trade interview kit content (Task 4 — owner: Prakash / RVM content pass).
 *
 * DETERMINISTIC, STATIC, REVIEWED COPY — NO LLM. A kit is a per-TRADE preparation
 * pack (overview + likely questions + checklist + what to carry). It is PII-FREE:
 * kits are per-trade, never per-worker, so nothing here references an individual.
 *
 * Render-once identity is `{trade_key}:v{INTERVIEW_KIT_CONTENT_VERSION}` — BUMP
 * the env content version whenever any copy below changes so a fresh PDF renders
 * instead of serving the stale cached file. trade_key ids are STABLE.
 */
export interface InterviewKitContent {
  readonly trade_key: string;
  readonly display_name: string;
  readonly overview: string;
  readonly common_questions: readonly string[];
  readonly practical_questions: readonly string[];
  readonly safety_questions: readonly string[];
  readonly drawing_measurement_questions: readonly string[];
  readonly skill_checklist: readonly string[];
  readonly revise_before: readonly string[];
  readonly documents_to_carry: readonly string[];
  readonly common_mistakes: readonly string[];
  /** Short Hindi/Hinglish encouragement (the product supports Hinglish copy). */
  readonly hinglish_note: string;
}

/** Documents almost every blue/grey-collar interview asks for (shared baseline). */
const COMMON_DOCS = [
  "Aadhaar card (original + photocopy)",
  "ITI / Diploma certificates and marksheets",
  "Experience / relieving letters (if any)",
  "2 passport-size photographs",
  "Updated resume (BadaBhai resume printout)",
] as const;

const K = (k: InterviewKitContent): InterviewKitContent => k;

export const INTERVIEW_KITS: readonly InterviewKitContent[] = [
  K({
    trade_key: "cnc_operator",
    display_name: "CNC Operator",
    overview:
      "A CNC Operator interview checks whether you can run CNC machines safely, read a drawing, set tool offsets, and keep production and quality on target. Expect a mix of basic questions, a few practical ones, and safety questions.",
    common_questions: [
      "Which CNC machines have you operated? (lathe / turning center)",
      "How do you set a tool offset and check the first piece?",
      "What is the difference between G-code and M-code?",
      "How do you read a part drawing and identify tolerances?",
      "How do you handle a job that is going out of tolerance?",
    ],
    practical_questions: [
      "Explain the steps to start a job from a saved program.",
      "What do you check before pressing cycle start?",
      "How do you measure an outer diameter and correct an offset?",
    ],
    safety_questions: [
      "What PPE do you wear on the shop floor?",
      "What do you do if the machine makes an unusual noise?",
      "How do you safely clear chips and coolant?",
    ],
    drawing_measurement_questions: [
      "What does a tolerance like 25.00 +0.02/-0.00 mean?",
      "Which instrument would you use to measure a 30 mm diameter accurately?",
      "How do you use a vernier caliper and a micrometer?",
    ],
    skill_checklist: [
      "CNC machine operation",
      "Drawing & GD&T reading",
      "Tool offset / wear setting",
      "Measuring instruments (vernier, micrometer)",
      "In-process inspection",
    ],
    revise_before: [
      "G-code / M-code basics",
      "How to read tolerances on a drawing",
      "Using vernier caliper and micrometer",
      "Tool offset setting steps",
    ],
    documents_to_carry: COMMON_DOCS,
    common_mistakes: [
      "Saying you know a machine you have not actually operated",
      "Forgetting to mention first-piece inspection",
      "Not mentioning PPE / safety",
    ],
    hinglish_note:
      "Tip: Jo machine aap chala chuke ho sirf wahi bolna. Drawing padhna aur measuring tools ka use confident hoke samjhana. Safety aur quality ka dhyan rakhne wali baat zaroor bolna.",
  }),
  K({
    trade_key: "vmc_operator",
    display_name: "VMC Operator",
    overview:
      "A VMC Operator interview checks machine setting, fixturing, offsets, and first-piece quality on vertical machining centres. Be ready for control-system questions (Fanuc/Siemens) and measurement basics.",
    common_questions: [
      "Which VMC machines and controls have you used? (Fanuc / Siemens / Mitsubishi)",
      "How do you set work offset (G54) and tool length offset?",
      "How do you mount and align a fixture?",
      "How do you prove out the first piece?",
      "How do you maintain surface finish on a milled face?",
    ],
    practical_questions: [
      "Walk through setting up a new job on a VMC.",
      "How do you set tool length using a presetter or on-machine?",
      "What do you do if a milled dimension is oversize?",
    ],
    safety_questions: [
      "How do you ensure a fixture is safely clamped before machining?",
      "What PPE and machine guards do you use?",
      "How do you handle hot chips and coolant safely?",
    ],
    drawing_measurement_questions: [
      "How do you read a milling drawing with multiple datums?",
      "Which tool measures depth of a slot?",
      "How do you check flatness or parallelism?",
    ],
    skill_checklist: [
      "VMC operation (3-axis)",
      "Work & tool offset setting",
      "Fixture setup & alignment",
      "Fanuc / Siemens control basics",
      "Measuring instruments",
    ],
    revise_before: [
      "Work offsets (G54–G59) and tool length offsets",
      "Fixturing and alignment basics",
      "Control-panel operations for your machine",
      "Measurement of milled features",
    ],
    documents_to_carry: COMMON_DOCS,
    common_mistakes: [
      "Confusing work offset with tool offset",
      "Not explaining first-piece proving",
      "Skipping fixture-safety checks",
    ],
    hinglish_note:
      "Tip: Konsa control (Fanuc/Siemens) chalaya hai clearly batana. Offset setting aur first piece check step-by-step samjhana. Fixture clamping safety ki baat miss mat karna.",
  }),
  K({
    trade_key: "cad_designer",
    display_name: "CAD Designer",
    overview:
      "A CAD Designer interview checks modelling skills, drawing detailing, GD&T, and design-for-manufacturing thinking. Be ready to discuss your software and how you make designs that are easy to manufacture.",
    common_questions: [
      "Which CAD software do you use? (SolidWorks / AutoCAD / etc.)",
      "How do you decide tolerances on a drawing?",
      "What is GD&T and why is it important?",
      "How do you make a design easy to manufacture (DFM)?",
      "How do you manage drawing revisions?",
    ],
    practical_questions: [
      "Explain how you would model a simple bracket and detail it.",
      "How do you create a BOM from an assembly?",
      "How do you check that mating parts will fit?",
    ],
    safety_questions: [
      "How do you back up and version-control your design files?",
      "How do you maintain ergonomic workstation habits?",
    ],
    drawing_measurement_questions: [
      "What is the difference between bilateral and unilateral tolerance?",
      "How do you choose a datum reference frame?",
      "How do you dimension a hole pattern correctly?",
    ],
    skill_checklist: [
      "2D/3D modelling",
      "Drawing detailing & GD&T",
      "Design for manufacturing",
      "BOM preparation",
      "Revision control",
    ],
    revise_before: [
      "GD&T symbols and tolerance basics",
      "Your CAD software shortcuts and features",
      "DFM principles",
      "Drawing standards and detailing",
    ],
    documents_to_carry: [...COMMON_DOCS, "Design portfolio / sample drawings (if available)"],
    common_mistakes: [
      "Listing software you have only seen, not used",
      "Ignoring manufacturability in designs",
      "Weak on tolerance / GD&T fundamentals",
    ],
    hinglish_note:
      "Tip: Jo software aapne actually use kiya hai wahi highlight karna. GD&T aur tolerance ke basics revise karke jaana. Ho sake to apne sample drawings dikhane ke liye le jana.",
  }),
  K({
    trade_key: "quality_inspector",
    display_name: "Quality Inspector",
    overview:
      "A Quality Inspector interview checks measurement skills, GD&T reading, use of instruments and gauges, and how you handle non-conformance. Accuracy and documentation discipline matter most.",
    common_questions: [
      "Which measuring instruments and gauges have you used?",
      "How do you perform in-process vs final inspection?",
      "What do you do when a part is out of tolerance?",
      "What is a non-conformance report (NCR)?",
      "How do you ensure your instruments are calibrated?",
    ],
    practical_questions: [
      "How would you inspect a shaft for diameter and runout?",
      "How do you use a height gauge and a bore gauge?",
      "How do you record and report inspection results?",
    ],
    safety_questions: [
      "How do you handle components and gauges safely?",
      "Why is instrument calibration important?",
    ],
    drawing_measurement_questions: [
      "How do you read GD&T callouts like flatness, position, and runout?",
      "Which instrument suits measuring a 0.01 mm difference?",
      "How do you use slip gauges and a profile projector?",
    ],
    skill_checklist: [
      "Dimensional inspection",
      "GD&T interpretation",
      "Instruments & gauges (vernier, micrometer, bore gauge)",
      "Inspection documentation / NCR",
      "Calibration awareness",
    ],
    revise_before: [
      "GD&T symbols and how to verify them",
      "Instrument least-count and correct usage",
      "Inspection report / NCR process",
      "Calibration basics",
    ],
    documents_to_carry: COMMON_DOCS,
    common_mistakes: [
      "Approximate measurement instead of accurate readings",
      "Weak on GD&T interpretation",
      "Not mentioning documentation / NCR",
    ],
    hinglish_note:
      "Tip: Measurement me accuracy aur least-count clearly samjhana. GD&T symbols padhna aana chahiye. NCR aur documentation ki baat zaroor karna — quality me record bahut important hai.",
  }),
  K({
    trade_key: "production_engineer",
    display_name: "Production Engineer",
    overview:
      "A Production Engineer interview checks planning, coordination, process improvement, and how you handle targets, rejections, and downtime on the shop floor. Expect questions on teamwork and problem-solving.",
    common_questions: [
      "How do you plan and track daily production?",
      "How do you coordinate manpower, machines, and material?",
      "How do you reduce rejections and downtime?",
      "What process improvements have you driven?",
      "How do you handle a sudden production shortfall?",
    ],
    practical_questions: [
      "How would you balance a line to meet a higher target?",
      "How do you do a basic root-cause analysis for a defect?",
      "Which production reports do you maintain?",
    ],
    safety_questions: [
      "How do you enforce shop-floor safety and PPE?",
      "What is 5S and how do you apply it?",
    ],
    drawing_measurement_questions: [
      "How do you verify a quality issue reported from the line?",
      "How do you read a process/route sheet?",
    ],
    skill_checklist: [
      "Production planning & control",
      "Process improvement (lean basics)",
      "Manpower & machine coordination",
      "Quality / rejection control",
      "Reporting / MIS",
    ],
    revise_before: [
      "Lean / 5S basics",
      "Root-cause analysis (why-why, fishbone)",
      "Production planning and OEE basics",
      "Common shop-floor problems and fixes",
    ],
    documents_to_carry: COMMON_DOCS,
    common_mistakes: [
      "Only talking theory, no shop-floor examples",
      "Not knowing basic lean / 5S",
      "Vague on how rejections/downtime were reduced",
    ],
    hinglish_note:
      "Tip: Real shop-floor examples ready rakho — target kaise meet kiya, rejection kaise kam kiya. Lean/5S aur root-cause ke basics revise karke jana. Team coordination ki baat highlight karna.",
  }),
  K({
    trade_key: "maintenance_technician",
    display_name: "Maintenance Technician",
    overview:
      "A Maintenance Technician interview checks preventive and breakdown maintenance, fault diagnosis, and safety (especially LOTO). Be ready to explain how you restore machine uptime quickly and safely.",
    common_questions: [
      "What preventive maintenance activities have you done?",
      "How do you diagnose a machine breakdown?",
      "What is your experience with hydraulics and pneumatics?",
      "How do you maintain maintenance records and spares?",
      "How do you align or level a machine?",
    ],
    practical_questions: [
      "Walk through troubleshooting a machine that stopped suddenly.",
      "How do you use a multimeter to check a fault?",
      "How do you decide repair vs replace for a part?",
    ],
    safety_questions: [
      "What is LOTO (lock-out / tag-out) and when do you use it?",
      "What electrical-safety precautions do you follow?",
      "How do you safely use tools and lifting equipment?",
    ],
    drawing_measurement_questions: [
      "How do you read a machine wiring or hydraulic diagram?",
      "How do you use a dial indicator for alignment?",
      "How do you check a clearance with a feeler gauge?",
    ],
    skill_checklist: [
      "Preventive & breakdown maintenance",
      "Mechanical / electrical fault diagnosis",
      "Hydraulics & pneumatics basics",
      "Alignment & lubrication",
      "LOTO / safety",
    ],
    revise_before: [
      "LOTO and electrical-safety procedures",
      "Basic hydraulics / pneumatics",
      "Multimeter and diagnosis basics",
      "Preventive-maintenance schedules",
    ],
    documents_to_carry: COMMON_DOCS,
    common_mistakes: [
      "Not mentioning LOTO / safety procedures",
      "Vague on diagnosis steps",
      "Forgetting preventive maintenance (only talking breakdown)",
    ],
    hinglish_note:
      "Tip: Safety sabse pehle — LOTO aur electrical safety ki baat zaroor bolna. Breakdown diagnosis step-by-step samjhana. Preventive maintenance ka experience bhi highlight karna, sirf breakdown nahi.",
  }),
];

/** Required Phase-1 interview-kit trades (Task 4 acceptance). */
export const REQUIRED_KIT_TRADE_KEYS = [
  "cnc_operator",
  "vmc_operator",
  "cad_designer",
  "quality_inspector",
  "production_engineer",
  "maintenance_technician",
] as const;

const BY_KEY = new Map(INTERVIEW_KITS.map((k) => [k.trade_key, k]));

/** Look up an interview kit by its stable trade_key (undefined when unknown). */
export function getInterviewKit(tradeKey: string): InterviewKitContent | undefined {
  return BY_KEY.get(tradeKey);
}
