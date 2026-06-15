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
  K({
    trade_key: "cnc_vmc_setter",
    display_name: "CNC/VMC Setter",
    overview:
      "A CNC/VMC Setter interview checks whether you can set machines independently: tooling, offsets, fixtures, program proving, and first-piece approval before handing over to operators. Expect questions on tool life, troubleshooting runs, and quality.",
    common_questions: [
      "Which CNC and VMC machines have you set independently?",
      "Walk through your full setting sequence for a new job.",
      "How do you select tooling and manage tool life?",
      "How do you approve the first piece before production?",
      "How do you troubleshoot a dimensional or surface-finish issue during a run?",
    ],
    practical_questions: [
      "How do you set work and tool offsets on a fresh setup?",
      "How do you mount and align a fixture for repeatability?",
      "How do you edit a program to correct an out-of-tolerance dimension?",
    ],
    safety_questions: [
      "What safe-setting / lock-out practices do you follow before tooling changes?",
      "How do you handle cutting tools and inserts safely?",
      "What PPE and machine guards do you use during setup?",
    ],
    drawing_measurement_questions: [
      "How do you read a drawing to plan the setting sequence?",
      "How do you use slip gauges and a dial indicator during setup?",
      "How do you verify a critical dimension on the first piece?",
    ],
    skill_checklist: [
      "Machine setting (CNC & VMC)",
      "Tooling selection & tool-life management",
      "Fixture setup & alignment",
      "Program editing & offset correction",
      "First-piece inspection & approval",
    ],
    revise_before: [
      "Full setting sequence (tooling, offsets, fixtures, proving)",
      "First-piece approval steps",
      "Tool-life and tooling selection basics",
      "Program editing and offset correction",
    ],
    documents_to_carry: COMMON_DOCS,
    common_mistakes: [
      "Saying you set machines when you only operated them",
      "Skipping the first-piece approval step",
      "Vague on tooling selection and tool life",
    ],
    hinglish_note:
      "Tip: Setting ka pura sequence — tooling, offset, fixture, proving — step-by-step samjhana. Sirf operate kiya hai to setting ka jhootha claim mat karna. First piece approval aur safe-setting practice ki baat confident hoke bolna.",
  }),
  K({
    trade_key: "cnc_programmer",
    display_name: "CNC Programmer",
    overview:
      "A CNC Programmer interview checks how you turn a drawing or model into a proven program: process planning, tooling, G-code/CAM, and on-machine proving. Be ready to explain post-processors, tool paths, and cycle-time optimisation.",
    common_questions: [
      "Which CAM software have you used? (Mastercam / Fusion / etc.)",
      "How do you write and edit a program using G-code and M-code?",
      "How do you plan operations and select tooling from a drawing?",
      "What is a post-processor and why does it matter?",
      "How do you prove out a new program on the machine?",
    ],
    practical_questions: [
      "How do you generate a tool path in CAM and verify it before posting?",
      "How do you set cutting parameters (speed, feed, depth) for a material?",
      "How do you optimise a program to reduce cycle time?",
    ],
    safety_questions: [
      "How do you safely prove a program (dry run, single block)?",
      "How do you avoid collision and over-travel during proving?",
      "What do you check before letting an operator run your program?",
    ],
    drawing_measurement_questions: [
      "How do you interpret GD&T to decide machining strategy?",
      "How do you read a model/drawing to extract programming features?",
      "How do you confirm a programmed dimension matches the part?",
    ],
    skill_checklist: [
      "G & M code programming",
      "CAM software & tool-path generation",
      "Process planning & tooling selection",
      "Post-processor / setup sheets",
      "Program proving & cycle-time optimisation",
    ],
    revise_before: [
      "G-code / M-code and CAM workflow",
      "Post-processor and setup-sheet basics",
      "Tool-path strategies and cutting parameters",
      "Safe program proving (dry run, single block)",
    ],
    documents_to_carry: COMMON_DOCS,
    common_mistakes: [
      "Listing CAM software you have only seen, not used",
      "Weak on post-processors and setup sheets",
      "Not mentioning safe proving (dry run / single block)",
    ],
    hinglish_note:
      "Tip: Jo CAM software actually use kiya hai wahi batana. G-code, tool path aur post-processor clearly samjhana. Program proving me dry run aur single block ki safety baat zaroor bolna.",
  }),
  K({
    trade_key: "vmc_programmer",
    display_name: "VMC Programmer",
    overview:
      "A VMC Programmer interview focuses on milling: writing and proving programs from 2D/3D drawings, defining fixtures and multi-tool setups, and optimising tool paths. Be ready for CAM, G-code, and post-processor questions for milling.",
    common_questions: [
      "Which CAM software do you use for milling programs?",
      "How do you write and prove a VMC program with G-code and M-code?",
      "How do you plan fixtures and a multi-tool setup for a milling job?",
      "What is a post-processor and how does it suit your VMC control?",
      "How do you optimise milling tool paths to reduce cycle time and tool wear?",
    ],
    practical_questions: [
      "How do you build a milling tool path in CAM and verify it before posting?",
      "How do you set cutting parameters for a milling operation?",
      "How do you correct a program when a milled feature is oversize?",
    ],
    safety_questions: [
      "How do you safely prove a milling program (dry run, single block)?",
      "How do you guard against collision and over-travel during setup?",
      "What do you confirm before handing the program to a setter/operator?",
    ],
    drawing_measurement_questions: [
      "How do you read a milling drawing with multiple datums to plan operations?",
      "How do you interpret GD&T to choose a milling strategy?",
      "How do you confirm a programmed milled dimension on the first piece?",
    ],
    skill_checklist: [
      "VMC / milling programming (G & M codes)",
      "CAM software & tool-path generation",
      "Fixture & multi-tool setup planning",
      "Post-processor / setup documentation",
      "Tool-path & cycle-time optimisation",
    ],
    revise_before: [
      "Milling CAM workflow and G-code basics",
      "Post-processor for your VMC control",
      "Multi-tool setup and fixture planning",
      "Safe program proving (dry run, single block)",
    ],
    documents_to_carry: COMMON_DOCS,
    common_mistakes: [
      "Confusing turning programming with milling specifics",
      "Listing CAM software you have not actually used",
      "Not mentioning safe proving and collision awareness",
    ],
    hinglish_note:
      "Tip: Milling-specific CAM aur tool path ki baat clearly karna. Multi-tool setup aur fixture planning samjhana. Program proving me dry run, single block aur collision safety ka dhyan zaroor mention karna.",
  }),
  K({
    trade_key: "solidworks_designer",
    display_name: "SolidWorks Designer",
    overview:
      "A SolidWorks Designer interview checks parametric modelling, assemblies, drawing detailing, and design-for-manufacturing. Be ready to discuss part/assembly structure, configurations, GD&T, and how you keep models robust and easy to revise.",
    common_questions: [
      "How do you build a robust parametric part model in SolidWorks?",
      "How do you create and mate a multi-part assembly?",
      "How do you produce a manufacturing drawing with correct GD&T?",
      "How do you use configurations and design tables?",
      "How do you manage revisions and design intent?",
    ],
    practical_questions: [
      "Walk through modelling a bracket and detailing its drawing.",
      "How do you create a BOM from an assembly?",
      "How do you check mating parts for interference and fit?",
    ],
    safety_questions: [
      "How do you back up and version-control your design files?",
      "How do you keep model structure clean so others can revise it?",
      "How do you maintain ergonomic workstation habits?",
    ],
    drawing_measurement_questions: [
      "How do you apply a datum reference frame and position tolerance?",
      "What is the difference between bilateral and unilateral tolerance?",
      "How do you dimension a hole pattern and fits correctly?",
    ],
    skill_checklist: [
      "SolidWorks parametric part modelling",
      "Assembly modelling & mates",
      "Drawing detailing & GD&T",
      "Configurations / design tables",
      "Revision & design-intent management",
    ],
    revise_before: [
      "Parametric modelling and feature order (design intent)",
      "Assembly mates and interference checks",
      "GD&T and drawing detailing standards",
      "Configurations and BOM creation",
    ],
    documents_to_carry: [...COMMON_DOCS, "Design portfolio / sample drawings (if available)"],
    common_mistakes: [
      "Modelling without thinking about design intent / easy revisions",
      "Weak on GD&T and drawing detailing",
      "Saying you know features you have not actually used",
    ],
    hinglish_note:
      "Tip: Parametric modelling aur design intent (feature order) clearly samjhana. Assembly mates aur GD&T ke basics revise karke jana. Ho sake to apne sample SolidWorks drawings dikhane ke liye le jana.",
  }),
  K({
    trade_key: "autocad_draftsman",
    display_name: "AutoCAD Draftsman",
    overview:
      "An AutoCAD Draftsman interview checks 2D drafting accuracy, dimensioning and drawing standards, GD&T basics, and layout/detailing discipline. Be ready to show how you produce clean, standard-compliant drawings and manage revisions.",
    common_questions: [
      "How long have you worked on 2D drafting in AutoCAD?",
      "How do you set up layers, dimension styles, and templates?",
      "How do you apply dimensioning and drawing standards correctly?",
      "How do you prepare a layout and detail views?",
      "How do you incorporate revisions and maintain a drawing register?",
    ],
    practical_questions: [
      "How would you draft and detail a simple part drawing from a sketch?",
      "How do you use layers, blocks, and xrefs to keep a drawing organised?",
      "How do you scale and plot a drawing to the correct sheet size?",
    ],
    safety_questions: [
      "How do you back up and manage drawing files and revisions?",
      "How do you avoid errors when reusing or updating old drawings?",
      "How do you maintain ergonomic workstation habits?",
    ],
    drawing_measurement_questions: [
      "What are GD&T basics and how do you place them on a 2D drawing?",
      "What is the difference between bilateral and unilateral tolerance?",
      "How do you dimension correctly to avoid ambiguity?",
    ],
    skill_checklist: [
      "2D drafting in AutoCAD",
      "Dimensioning & drawing standards",
      "GD&T basics",
      "Layouts & detailing",
      "Drawing revision control",
    ],
    revise_before: [
      "AutoCAD layers, dimension styles, blocks, and xrefs",
      "Dimensioning and drawing standards",
      "GD&T basics on 2D drawings",
      "Plotting/scaling and revision control",
    ],
    documents_to_carry: [...COMMON_DOCS, "Sample drawings / portfolio (if available)"],
    common_mistakes: [
      "Sloppy or ambiguous dimensioning",
      "Not using layers/standards, leading to messy drawings",
      "Weak on GD&T basics",
    ],
    hinglish_note:
      "Tip: Layers, dimension style aur drawing standards ka clean use dikhana. Dimensioning bina confusion ke karna aana chahiye. GD&T basics revise karke jana aur ho sake to apne sample drawings le jana.",
  }),
  K({
    trade_key: "tool_room_technician",
    display_name: "Tool Room Technician",
    overview:
      "A Tool Room Technician interview checks precision: making and repairing jigs, fixtures, and dies, grinding and fitting to tight tolerance, and accurate measurement. Be ready to explain how you hold close tolerances and care for tool-room equipment.",
    common_questions: [
      "What jigs, fixtures, or dies have you made or repaired?",
      "Which grinding machines have you used (surface / cylindrical)?",
      "How do you hold a tight tolerance during precision machining?",
      "How do you do fitting and assembly of tooling?",
      "How do you maintain dies/moulds and tool-room equipment?",
    ],
    practical_questions: [
      "How would you grind a component to a close tolerance?",
      "How do you set up a job using a sine bar and slip gauges?",
      "How do you fit and align mating parts of a fixture?",
    ],
    safety_questions: [
      "How do you safely handle and dress a grinding wheel?",
      "What guarding and PPE do you use during grinding?",
      "How do you care for precision instruments and tooling?",
    ],
    drawing_measurement_questions: [
      "How do you use slip gauges and a sine bar to set/check an angle?",
      "How do you measure with a micrometer and height gauge to close tolerance?",
      "How do you read a tooling/fixture drawing with tight tolerances?",
    ],
    skill_checklist: [
      "Tool, jig & fixture making",
      "Grinding & precision machining",
      "Die/mould maintenance",
      "Fitting & assembly",
      "Precision measurement (slip gauges, sine bar)",
    ],
    revise_before: [
      "Grinding setup and close-tolerance work",
      "Slip gauges, sine bar, and precision measurement",
      "Jig/fixture/die fundamentals",
      "Grinding-wheel safety and tool care",
    ],
    documents_to_carry: COMMON_DOCS,
    common_mistakes: [
      "Vague about the tolerances you can actually hold",
      "Not mentioning grinding-wheel safety",
      "Weak on precision-measurement instruments",
    ],
    hinglish_note:
      "Tip: Jo jig/fixture/die banaya ya repair kiya hai uske examples ready rakhna. Tight tolerance kaise hold karte ho aur slip gauge/sine bar ka use samjhana. Grinding wheel ki safety ki baat zaroor bolna.",
  }),
  K({
    trade_key: "machine_operator",
    display_name: "Machine Operator",
    overview:
      "A Machine Operator interview checks whether you can run a production machine to work instructions, do basic quality checks, keep output records, and follow safety and housekeeping. Be ready for simple measurement and 5S questions.",
    common_questions: [
      "Which machines have you operated? (conventional / CNC / drilling / grinding)",
      "How do you follow work instructions to run a job?",
      "How do you do basic quality checks on a part?",
      "What do you do when you notice a deviation or defect?",
      "How do you maintain production output records?",
    ],
    practical_questions: [
      "Walk through starting a job from work instructions.",
      "How do you load and unload a job safely?",
      "How do you use a Go/No-Go gauge or vernier for a basic check?",
    ],
    safety_questions: [
      "What PPE do you wear and which machine guards do you check?",
      "How do you handle material safely and keep a clean workstation (5S)?",
      "What do you do if the machine behaves abnormally?",
    ],
    drawing_measurement_questions: [
      "How do you read a basic work instruction or simple drawing?",
      "How do you use a vernier caliper or measuring scale?",
      "How do you use a Go/No-Go gauge to accept or reject a part?",
    ],
    skill_checklist: [
      "Machine operation",
      "Reading work instructions",
      "Basic measurement & quality checks",
      "Production record keeping",
      "Shop-floor discipline (5S)",
    ],
    revise_before: [
      "Basic machine operation and loading/unloading",
      "Vernier caliper and Go/No-Go gauge usage",
      "Reading work instructions",
      "PPE, machine guarding, and 5S",
    ],
    documents_to_carry: COMMON_DOCS,
    common_mistakes: [
      "Saying you ran a machine you have not actually operated",
      "Not mentioning quality checks or reporting deviations",
      "Forgetting PPE / housekeeping (5S)",
    ],
    hinglish_note:
      "Tip: Jo machine chala chuke ho sirf wahi bolna. Basic quality check aur deviation report karna aana chahiye. PPE, machine guard aur 5S housekeeping ki baat confident hoke bolna.",
  }),
  K({
    trade_key: "assembly_technician",
    display_name: "Assembly Technician",
    overview:
      "An Assembly Technician interview checks mechanical assembly and fitment to specification: reading assembly drawings/BOM, correct torque and fastening, fitment checks, and defect reporting. Be ready for hand/power tool and torque questions.",
    common_questions: [
      "What kind of mechanical assembly and sub-assembly work have you done?",
      "How do you read an assembly drawing and BOM?",
      "How do you apply correct torque and fastening standards?",
      "How do you check fitment during assembly?",
      "How do you report defects and maintain assembly records?",
    ],
    practical_questions: [
      "Walk through assembling a sub-assembly from a drawing and BOM.",
      "How do you set and use a torque wrench correctly?",
      "How do you verify fitment when two parts do not seat properly?",
    ],
    safety_questions: [
      "How do you use hand and power tools and lifting aids safely?",
      "What PPE and ergonomic practices do you follow on the line?",
      "How do you handle components to avoid damage during assembly?",
    ],
    drawing_measurement_questions: [
      "How do you read an assembly drawing and identify fastener/torque callouts?",
      "How do you use a torque wrench and a Go/No-Go gauge?",
      "How do you check a fitment dimension with a vernier caliper?",
    ],
    skill_checklist: [
      "Mechanical assembly & fitment",
      "Reading assembly drawings / BOM",
      "Use of hand & power tools",
      "Torque & fastening standards",
      "In-process quality checks",
    ],
    revise_before: [
      "Assembly drawing and BOM reading",
      "Torque and fastening standards",
      "Hand/power tool usage and safety",
      "Fitment and in-process quality checks",
    ],
    documents_to_carry: COMMON_DOCS,
    common_mistakes: [
      "Not applying correct torque / fastening standards",
      "Skipping fitment and in-process checks",
      "Weak on reading the assembly drawing / BOM",
    ],
    hinglish_note:
      "Tip: Assembly drawing aur BOM padhna aana chahiye. Sahi torque aur fastening ka dhyan rakhna — torque wrench ka use samjhana. Tool aur lifting ki safety ki baat zaroor bolna.",
  }),
  K({
    trade_key: "fitter",
    display_name: "Fitter",
    overview:
      "A Fitter interview checks bench and fitting skills: filing, drilling, tapping, alignment and fitment to drawing, and use of hand and measuring tools. Be ready for practical bench-work questions and tool-safety questions.",
    common_questions: [
      "What fitting, assembly, and alignment work have you done?",
      "How do you do filing, drilling, and tapping operations?",
      "How do you read a drawing and check fitment?",
      "How do you align mating parts or assemblies?",
      "What hand and measuring tools do you use regularly?",
    ],
    practical_questions: [
      "Walk through filing a surface flat and checking it with a try square.",
      "How do you drill and tap a hole to the correct size?",
      "How do you align two parts and check the fit?",
    ],
    safety_questions: [
      "How do you safely use hand and power tools at the bench?",
      "What PPE do you wear and how do you keep good housekeeping?",
      "How do you handle sharp edges and swarf safely?",
    ],
    drawing_measurement_questions: [
      "How do you read a drawing to plan a fitting job?",
      "How do you use a try square, feeler gauge, and vernier caliper?",
      "How do you check flatness or a clearance during fitting?",
    ],
    skill_checklist: [
      "Mechanical fitting & assembly",
      "Reading drawings",
      "Filing, drilling, tapping",
      "Alignment & fitment",
      "Use of hand & measuring tools",
    ],
    revise_before: [
      "Bench work: filing, drilling, tapping",
      "Alignment and fitment checks",
      "Try square, feeler gauge, and vernier usage",
      "Hand/power tool safety and housekeeping",
    ],
    documents_to_carry: COMMON_DOCS,
    common_mistakes: [
      "Vague on actual bench-work skills (filing, tapping, alignment)",
      "Not mentioning measuring-tool checks for fitment",
      "Forgetting tool safety and housekeeping",
    ],
    hinglish_note:
      "Tip: Bench work — filing, drilling, tapping aur alignment — practically samjhana. Try square aur feeler gauge se fitment check karna aana chahiye. Hand aur power tool ki safety ki baat zaroor bolna.",
  }),
];

/** Required Phase-1 interview-kit trades (Task 4 acceptance). */
export const REQUIRED_KIT_TRADE_KEYS = [
  "cnc_operator",
  "vmc_operator",
  "cnc_vmc_setter",
  "cnc_programmer",
  "vmc_programmer",
  "cad_designer",
  "solidworks_designer",
  "autocad_draftsman",
  "quality_inspector",
  "production_engineer",
  "maintenance_technician",
  "tool_room_technician",
  "machine_operator",
  "assembly_technician",
  "fitter",
] as const;

const BY_KEY = new Map(INTERVIEW_KITS.map((k) => [k.trade_key, k]));

/** Look up an interview kit by its stable trade_key (undefined when unknown). */
export function getInterviewKit(tradeKey: string): InterviewKitContent | undefined {
  return BY_KEY.get(tradeKey);
}
