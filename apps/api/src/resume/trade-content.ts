/**
 * Per-trade resume content rows (TD24a, Task 2 — owner: Prakash / RVM content pass).
 *
 * DETERMINISTIC, STATIC, REVIEWED COPY — NO LLM. This is the content layer the
 * resume renderer fills template variables from. Two hard rules (product decision,
 * "no LLM-authored resume prose"):
 *
 *  1. NOTHING here asserts a fact about a specific worker. `core_skills`,
 *     `machine_tools`, `inspection_tools`, `keywords` are a TRADE VOCABULARY (used
 *     for ATS keywords + interview kits), NOT claims — the renderer only ever
 *     renders the skills/machines the worker actually SELECTED in their profile.
 *  2. `responsibilities` / `safety_points` describe the TRADE (role-typical duties
 *     every recruiter expects on such a resume), filled only when the worker chose
 *     that trade. No company names, salaries, or invented experience anywhere.
 *
 * Templates: `{{role}}`, `{{years}}`, `{{primary_machine}}` are the only variables
 * substituted (by the renderer, from profile facts). A fresher (no years) gets a
 * `fresher_phrases` summary instead of the experienced `summary_template`.
 *
 * Versioning: trade_key ids are STABLE. Add trades freely; don't rename keys.
 */
export interface TradeContent {
  /** Stable lowercase slug (the row key). */
  readonly trade_key: string;
  /** Recruiter-facing role title (the resume headline + interview-kit title). */
  readonly display_name: string;
  /** Headline line. Vars: {{role}} {{years}}. */
  readonly headline_template: string;
  /** Experienced summary. Vars: {{role}} {{years}} {{primary_machine}}. */
  readonly summary_template: string;
  /** Trade skill vocabulary (ATS keywords / interview kit — NOT a per-worker claim). */
  readonly core_skills: readonly string[];
  /** Typical machines/tools for the trade. */
  readonly machine_tools: readonly string[];
  /** Typical measuring/inspection instruments for the trade. */
  readonly inspection_tools: readonly string[];
  /** Role-typical responsibilities (trade-level, recruiter-readable). */
  readonly responsibilities: readonly string[];
  /** Shop-floor safety points relevant to the trade. */
  readonly safety_points: readonly string[];
  /** Phrases usable when the worker HAS experience. */
  readonly experience_phrases: readonly string[];
  /** Phrases usable for a fresher (no/low experience) — used for the summary. */
  readonly fresher_phrases: readonly string[];
  /** Certifications commonly relevant (suggestions for the interview kit only). */
  readonly certification_phrases: readonly string[];
  /** ATS keywords. */
  readonly keywords: readonly string[];
  /** Taxonomy role ids (@badabhai/taxonomy) that map onto this trade, if any. */
  readonly taxonomy_role_ids?: readonly string[];
}

const C = (t: TradeContent): TradeContent => t;

export const TRADE_CONTENT: readonly TradeContent[] = [
  C({
    trade_key: "cnc_operator",
    display_name: "CNC Operator",
    headline_template: "{{role}}",
    summary_template:
      "CNC Operator with {{years}} of hands-on machining experience on {{primary_machine}}. Reliable on production targets, quality, and shop-floor discipline.",
    core_skills: [
      "CNC machine operation",
      "Reading job drawings & GD&T",
      "Tool offset & wear setting",
      "Program selection and editing (G & M codes)",
      "Cycle-time and rejection control",
    ],
    machine_tools: ["CNC Lathe / Turning Center", "CNC Milling", "Bar feeder"],
    inspection_tools: ["Vernier caliper", "Micrometer", "Bore gauge", "Plug & snap gauges"],
    responsibilities: [
      "Operate CNC machines to produce components as per drawing and tolerance",
      "Load/unload jobs, set tool offsets, and run approved programs",
      "Perform in-process inspection and maintain production records",
      "Achieve daily production targets while keeping rejections low",
    ],
    safety_points: [
      "Use of PPE (safety shoes, goggles) at all times",
      "Machine guarding and emergency-stop awareness",
      "Safe handling of coolant, chips, and sharp components",
    ],
    experience_phrases: [
      "Consistently met production targets",
      "Reduced rework through careful in-process checking",
    ],
    fresher_phrases: [
      "ITI/diploma-qualified CNC Operator seeking a first machining role",
      "Trained on CNC operation, basic setting, and drawing reading; eager to learn on the job",
    ],
    certification_phrases: ["ITI (Machinist / Turner)", "CNC operation training certificate"],
    keywords: ["CNC", "operator", "machining", "turning", "production", "GD&T"],
    taxonomy_role_ids: ["role_cnc_turner_operator"],
  }),
  C({
    trade_key: "vmc_operator",
    display_name: "VMC Operator",
    headline_template: "{{role}}",
    summary_template:
      "VMC Operator with {{years}} of experience running vertical machining centres on {{primary_machine}}. Strong on setting, offsets, and first-piece quality.",
    core_skills: [
      "VMC operation (3-axis)",
      "Fixture and job setup",
      "Tool offset & length setting",
      "Fanuc / Siemens / Mitsubishi control operation",
      "Drawing & GD&T reading",
    ],
    machine_tools: ["Vertical Machining Center (VMC)", "Rotary table", "Vices & fixtures"],
    inspection_tools: ["Vernier caliper", "Micrometer", "Height gauge", "Dial indicator"],
    responsibilities: [
      "Set up and operate VMC machines for milling components to drawing",
      "Mount fixtures, set work and tool offsets, and prove out the first piece",
      "Run production with in-process inspection and record output",
      "Coordinate with quality on tolerance and surface-finish requirements",
    ],
    safety_points: [
      "PPE compliance and machine guarding",
      "Safe fixture clamping and job loading",
      "Coolant and swarf handling discipline",
    ],
    experience_phrases: [
      "Independently set and operated VMC for varied components",
      "Maintained tight tolerances on milled features",
    ],
    fresher_phrases: [
      "ITI/diploma-qualified VMC Operator seeking a first machining role",
      "Trained on VMC operation, fixturing, and offset setting; quick to learn",
    ],
    certification_phrases: ["ITI (Machinist / Fitter)", "VMC operation training certificate"],
    keywords: ["VMC", "operator", "milling", "machining center", "Fanuc", "setting"],
    taxonomy_role_ids: ["role_vmc_operator", "role_hmc_operator"],
  }),
  C({
    trade_key: "cnc_vmc_setter",
    display_name: "CNC/VMC Setter",
    headline_template: "{{role}}",
    summary_template:
      "CNC/VMC Setter with {{years}} of experience in machine setting, tooling, and first-piece approval on {{primary_machine}}.",
    core_skills: [
      "Machine setting (CNC & VMC)",
      "Tooling selection & tool life management",
      "Fixture setup and alignment",
      "Program editing and offset correction",
      "First-piece inspection & approval",
    ],
    machine_tools: ["CNC Lathe", "VMC", "Tool presetter", "Fixtures & vices"],
    inspection_tools: ["Micrometer", "Vernier caliper", "Bore gauge", "Dial indicator", "Slip gauges"],
    responsibilities: [
      "Set up CNC/VMC machines: tooling, offsets, fixtures, and program proving",
      "Approve first piece and hand over to operators for production",
      "Troubleshoot dimensional and surface-finish issues during runs",
      "Optimise cycle time and tool life to improve productivity",
    ],
    safety_points: [
      "Lock-out / safe-setting practices before tooling changes",
      "PPE and machine-guard compliance",
      "Correct handling of cutting tools and inserts",
    ],
    experience_phrases: [
      "Reduced setup time through standardised tooling",
      "Resolved tolerance issues at first-piece stage",
    ],
    fresher_phrases: [
      "Operator progressing into a setting role; trained on tooling and offsets",
      "Diploma/ITI holder seeking a CNC/VMC setter opportunity",
    ],
    certification_phrases: ["ITI (Machinist / Turner)", "CNC setting training certificate"],
    keywords: ["setter", "CNC", "VMC", "setting", "tooling", "first piece"],
    taxonomy_role_ids: ["role_cnc_setter_operator"],
  }),
  C({
    trade_key: "cnc_programmer",
    display_name: "CNC Programmer",
    headline_template: "{{role}}",
    summary_template:
      "CNC Programmer with {{years}} of experience writing and proving programs for turning/milling on {{primary_machine}}.",
    core_skills: [
      "G & M code programming",
      "CAM software (Mastercam / Fusion / etc.)",
      "Process planning & tooling selection",
      "GD&T interpretation",
      "Program proving and optimisation",
    ],
    machine_tools: ["CNC Lathe", "CNC Milling / VMC", "Tool presetter"],
    inspection_tools: ["Micrometer", "Vernier caliper", "CMM (basic awareness)"],
    responsibilities: [
      "Develop CNC programs from drawings/models using G-code and CAM",
      "Plan operations, select tooling, and define cutting parameters",
      "Prove out programs on machine and optimise cycle time",
      "Document setup sheets and support operators/setters",
    ],
    safety_points: [
      "Safe dry-run and single-block proving practices",
      "Awareness of collision/over-travel risks during proving",
    ],
    experience_phrases: [
      "Cut cycle time through optimised tool paths",
      "Standardised setup sheets across part families",
    ],
    fresher_phrases: [
      "Diploma/engineering graduate trained in CNC programming and CAM",
      "Seeking a first CNC programming role; strong on G-code and drawing reading",
    ],
    certification_phrases: ["Diploma in Mechanical / Tool & Die", "CAM software training certificate"],
    keywords: ["CNC", "programmer", "G-code", "CAM", "Mastercam", "process planning"],
    taxonomy_role_ids: ["role_cnc_programmer", "role_cam_programmer"],
  }),
  C({
    trade_key: "vmc_programmer",
    display_name: "VMC Programmer",
    headline_template: "{{role}}",
    summary_template:
      "VMC Programmer with {{years}} of experience programming and proving milling jobs on {{primary_machine}}.",
    core_skills: [
      "VMC programming (G & M codes)",
      "CAM software for milling",
      "Fixture and process planning",
      "Multi-tool setup definition",
      "Program optimisation",
    ],
    machine_tools: ["Vertical Machining Center (VMC)", "Tool presetter", "Fixtures"],
    inspection_tools: ["Micrometer", "Height gauge", "Dial indicator"],
    responsibilities: [
      "Write and prove VMC programs from 2D/3D drawings and models",
      "Define tooling, fixtures, and cutting parameters for milling jobs",
      "Optimise tool paths to reduce cycle time and tool wear",
      "Prepare setup documentation for setters/operators",
    ],
    safety_points: [
      "Safe program proving (dry run, single block)",
      "Collision and over-travel awareness during setup",
    ],
    experience_phrases: [
      "Improved surface finish through optimised milling strategies",
      "Reduced setup errors with clear documentation",
    ],
    fresher_phrases: [
      "Diploma/engineering graduate trained in VMC/milling programming",
      "Seeking a first VMC programming role; confident with CAM and drawings",
    ],
    certification_phrases: ["Diploma in Mechanical", "CAM (milling) training certificate"],
    keywords: ["VMC", "programmer", "milling", "CAM", "G-code", "tool path"],
  }),
  C({
    trade_key: "cad_designer",
    display_name: "CAD Designer",
    headline_template: "{{role}}",
    summary_template:
      "CAD Designer with {{years}} of experience in mechanical design and detailing using {{primary_machine}}.",
    core_skills: [
      "2D/3D mechanical design",
      "Part & assembly modelling",
      "GD&T and drawing standards",
      "Design for manufacturing (DFM)",
      "BOM preparation",
    ],
    machine_tools: ["CAD workstation", "Plotter / printer"],
    inspection_tools: ["Vernier caliper", "Micrometer (for reverse-engineering)"],
    responsibilities: [
      "Create 2D drawings and 3D models from concepts/specifications",
      "Apply GD&T and follow drawing standards for manufacturability",
      "Prepare BOMs and revise designs as per review feedback",
      "Coordinate with production and quality on design intent",
    ],
    safety_points: [
      "Ergonomic workstation practices",
      "Correct data backup and revision control",
    ],
    experience_phrases: [
      "Delivered manufacturable designs with clean detailing",
      "Maintained disciplined drawing revision control",
    ],
    fresher_phrases: [
      "Diploma/engineering graduate trained in CAD modelling and detailing",
      "Seeking a first CAD design role; strong fundamentals in drawings and GD&T",
    ],
    certification_phrases: ["Diploma in Mechanical / Design", "CAD software certification"],
    keywords: ["CAD", "design", "modelling", "GD&T", "detailing", "DFM"],
  }),
  C({
    trade_key: "solidworks_designer",
    display_name: "SolidWorks Designer",
    headline_template: "{{role}}",
    summary_template:
      "SolidWorks Designer with {{years}} of experience in 3D modelling, assemblies, and drawings.",
    core_skills: [
      "SolidWorks part & assembly modelling",
      "Drawing detailing & GD&T",
      "Sheet metal / weldments (as applicable)",
      "Design for manufacturing",
      "Revision & configuration management",
    ],
    machine_tools: ["CAD workstation (SolidWorks)"],
    inspection_tools: ["Vernier caliper", "Micrometer"],
    responsibilities: [
      "Model parts and assemblies in SolidWorks from inputs/specifications",
      "Produce manufacturing drawings with correct GD&T and tolerances",
      "Manage configurations and design revisions",
      "Support manufacturing with DFM feedback",
    ],
    safety_points: ["Ergonomic workstation practices", "Disciplined file/revision backups"],
    experience_phrases: [
      "Built reusable, well-structured SolidWorks models",
      "Reduced drawing errors through standard templates",
    ],
    fresher_phrases: [
      "Trained in SolidWorks modelling, assemblies, and drawings",
      "Seeking a first SolidWorks design role",
    ],
    certification_phrases: ["SolidWorks (CSWA/CSWP) certification", "Diploma in Mechanical / Design"],
    keywords: ["SolidWorks", "3D", "modelling", "assembly", "drawing", "design"],
  }),
  C({
    trade_key: "autocad_draftsman",
    display_name: "AutoCAD Draftsman",
    headline_template: "{{role}}",
    summary_template:
      "AutoCAD Draftsman with {{years}} of experience preparing accurate 2D drawings and layouts.",
    core_skills: [
      "2D drafting in AutoCAD",
      "Dimensioning & drawing standards",
      "GD&T basics",
      "Layout and detailing",
      "Drawing revision control",
    ],
    machine_tools: ["CAD workstation (AutoCAD)", "Plotter"],
    inspection_tools: ["Vernier caliper", "Measuring tape / scale"],
    responsibilities: [
      "Prepare and update 2D drawings, layouts, and detailing in AutoCAD",
      "Apply dimensioning and drawing standards correctly",
      "Incorporate revisions and maintain drawing registers",
      "Coordinate with design/production teams",
    ],
    safety_points: ["Ergonomic workstation practices", "Accurate file/revision management"],
    experience_phrases: [
      "Produced clean, standard-compliant drawings",
      "Maintained accurate drawing registers",
    ],
    fresher_phrases: [
      "Trained in AutoCAD 2D drafting and detailing",
      "Seeking a first draftsman role",
    ],
    certification_phrases: ["AutoCAD certification", "ITI/Diploma (Draughtsman Mechanical)"],
    keywords: ["AutoCAD", "draftsman", "drafting", "2D", "detailing", "layout"],
  }),
  C({
    trade_key: "quality_inspector",
    display_name: "Quality Inspector",
    headline_template: "{{role}}",
    summary_template:
      "Quality Inspector with {{years}} of experience in dimensional inspection and quality documentation.",
    core_skills: [
      "Dimensional inspection",
      "GD&T interpretation",
      "Use of measuring instruments & gauges",
      "In-process & final inspection",
      "Quality records (inspection reports)",
    ],
    machine_tools: ["Inspection table / surface plate", "CMM (as applicable)"],
    inspection_tools: [
      "Vernier caliper",
      "Micrometer",
      "Height gauge",
      "Bore gauge",
      "Plug & ring gauges",
      "Profile projector",
    ],
    responsibilities: [
      "Perform in-process and final inspection against drawings and tolerances",
      "Use measuring instruments and gauges to verify dimensions",
      "Record inspection results and raise non-conformance reports",
      "Support root-cause analysis and corrective actions",
    ],
    safety_points: [
      "Safe handling of components and gauges",
      "Calibration awareness and instrument care",
    ],
    experience_phrases: [
      "Maintained accurate inspection documentation",
      "Helped reduce defects through disciplined checking",
    ],
    fresher_phrases: [
      "ITI/diploma holder trained in measurement and inspection",
      "Seeking a first quality-inspection role",
    ],
    certification_phrases: ["ITI/Diploma (Mechanical)", "Quality/metrology training certificate"],
    keywords: ["quality", "inspector", "inspection", "GD&T", "measuring", "CMM"],
  }),
  C({
    trade_key: "production_engineer",
    display_name: "Production Engineer",
    headline_template: "{{role}}",
    summary_template:
      "Production Engineer with {{years}} of experience in shop-floor production, planning, and process improvement.",
    core_skills: [
      "Production planning & control",
      "Process improvement (lean basics)",
      "Manpower & machine coordination",
      "Quality & rejection control",
      "Production documentation/MIS",
    ],
    machine_tools: ["CNC/VMC machines (supervisory)", "Shop-floor systems"],
    inspection_tools: ["Vernier caliper", "Micrometer (verification)"],
    responsibilities: [
      "Plan and monitor daily production against targets",
      "Coordinate manpower, machines, and material for smooth flow",
      "Drive process improvements and reduce rejections/downtime",
      "Maintain production reports and coordinate with quality/maintenance",
    ],
    safety_points: [
      "Enforce shop-floor safety and PPE compliance",
      "Promote 5S and safe working practices",
    ],
    experience_phrases: [
      "Improved output through better planning",
      "Reduced downtime via coordination with maintenance",
    ],
    fresher_phrases: [
      "Engineering graduate (Mechanical/Production) seeking a first shop-floor role",
      "Trained in production planning and process fundamentals",
    ],
    certification_phrases: ["B.E./Diploma (Mechanical/Production)", "Lean/Six Sigma awareness"],
    keywords: ["production", "engineer", "planning", "process", "lean", "shop floor"],
  }),
  C({
    trade_key: "maintenance_technician",
    display_name: "Maintenance Technician",
    headline_template: "{{role}}",
    summary_template:
      "Maintenance Technician with {{years}} of experience in preventive and breakdown maintenance of machines.",
    core_skills: [
      "Preventive & breakdown maintenance",
      "Mechanical/electrical fault diagnosis",
      "Hydraulics & pneumatics basics",
      "Machine alignment & lubrication",
      "Maintenance record keeping",
    ],
    machine_tools: ["CNC/VMC machines", "Hand & power tools", "Multimeter"],
    inspection_tools: ["Dial indicator", "Feeler gauge", "Vernier caliper"],
    responsibilities: [
      "Carry out preventive maintenance as per schedule",
      "Diagnose and repair mechanical/electrical breakdowns to restore uptime",
      "Maintain spares, lubrication, and maintenance records",
      "Support installation and alignment of machines",
    ],
    safety_points: [
      "Lock-out/tag-out (LOTO) during maintenance",
      "Electrical safety and PPE compliance",
      "Safe use of tools and lifting equipment",
    ],
    experience_phrases: [
      "Reduced breakdown downtime through quick diagnosis",
      "Maintained disciplined preventive-maintenance schedules",
    ],
    fresher_phrases: [
      "ITI (Fitter/Electrician) trained in machine maintenance",
      "Seeking a first maintenance-technician role",
    ],
    certification_phrases: ["ITI (Fitter / Electrician)", "Maintenance training certificate"],
    keywords: ["maintenance", "technician", "preventive", "breakdown", "repair", "uptime"],
  }),
  C({
    trade_key: "tool_room_technician",
    display_name: "Tool Room Technician",
    headline_template: "{{role}}",
    summary_template:
      "Tool Room Technician with {{years}} of experience in tooling, jigs, fixtures, and precision machining.",
    core_skills: [
      "Tool, jig & fixture making",
      "Grinding & precision machining",
      "Die/mould maintenance (as applicable)",
      "Fitting & assembly",
      "Precision measurement",
    ],
    machine_tools: ["Surface grinder", "Cylindrical grinder", "Milling/lathe", "EDM (as applicable)"],
    inspection_tools: ["Micrometer", "Slip gauges", "Height gauge", "Dial indicator", "Sine bar"],
    responsibilities: [
      "Manufacture and repair jigs, fixtures, and tooling to tight tolerance",
      "Perform precision grinding and fitting operations",
      "Maintain dies/moulds and tool-room equipment",
      "Inspect tooling using precision instruments",
    ],
    safety_points: [
      "Safe grinding-wheel handling and guarding",
      "PPE and precision-tool care",
    ],
    experience_phrases: [
      "Produced precision tooling to tight tolerances",
      "Extended tool/die life through good maintenance",
    ],
    fresher_phrases: [
      "ITI (Tool & Die Maker) seeking a first tool-room role",
      "Trained in grinding, fitting, and precision measurement",
    ],
    certification_phrases: ["ITI (Tool & Die Maker)", "Tool-room training certificate"],
    keywords: ["tool room", "jig", "fixture", "die", "grinding", "precision"],
    taxonomy_role_ids: ["role_cnc_grinding_operator"],
  }),
  C({
    trade_key: "machine_operator",
    display_name: "Machine Operator",
    headline_template: "{{role}}",
    summary_template:
      "Machine Operator with {{years}} of experience operating production machines on {{primary_machine}}.",
    core_skills: [
      "Machine operation",
      "Reading work instructions",
      "Basic measurement & quality checks",
      "Production record keeping",
      "Shop-floor discipline (5S)",
    ],
    machine_tools: ["Conventional/CNC machines", "Drilling/grinding machines"],
    inspection_tools: ["Vernier caliper", "Measuring tape / scale", "Go/No-Go gauges"],
    responsibilities: [
      "Operate machines as per work instructions to meet production targets",
      "Perform basic quality checks and report deviations",
      "Maintain output records and a clean, safe workstation",
      "Assist with loading, unloading, and material handling",
    ],
    safety_points: [
      "PPE compliance and machine-guard awareness",
      "Safe material handling and housekeeping (5S)",
    ],
    experience_phrases: [
      "Met production targets consistently",
      "Maintained good housekeeping and safety record",
    ],
    fresher_phrases: [
      "Seeking a first machine-operator role; willing to learn",
      "Trained in basic machine operation and safety",
    ],
    certification_phrases: ["ITI (any trade)", "Machine-operation training"],
    keywords: ["machine", "operator", "production", "operation", "5S"],
  }),
  C({
    trade_key: "assembly_technician",
    display_name: "Assembly Technician",
    headline_template: "{{role}}",
    summary_template:
      "Assembly Technician with {{years}} of experience in mechanical assembly and fitment to specification.",
    core_skills: [
      "Mechanical assembly & fitment",
      "Reading assembly drawings/BOM",
      "Use of hand & power tools",
      "Torque & fastening standards",
      "In-process quality checks",
    ],
    machine_tools: ["Assembly fixtures", "Torque wrenches", "Hand & power tools"],
    inspection_tools: ["Vernier caliper", "Torque wrench", "Go/No-Go gauges"],
    responsibilities: [
      "Assemble components/sub-assemblies per drawings and BOM",
      "Apply correct torque and fastening standards",
      "Perform fitment and functional checks during assembly",
      "Report defects and maintain assembly records",
    ],
    safety_points: [
      "Safe use of tools and lifting aids",
      "PPE compliance and ergonomic practices",
    ],
    experience_phrases: [
      "Maintained quality and pace on the assembly line",
      "Reduced fitment errors through careful checking",
    ],
    fresher_phrases: [
      "ITI/fresher seeking a first assembly role",
      "Trained in mechanical assembly and tool usage",
    ],
    certification_phrases: ["ITI (Fitter / Mechanic)", "Assembly training certificate"],
    keywords: ["assembly", "fitment", "technician", "BOM", "torque", "sub-assembly"],
  }),
  C({
    trade_key: "fitter",
    display_name: "Fitter",
    headline_template: "{{role}}",
    summary_template:
      "Fitter with {{years}} of experience in mechanical fitting, assembly, and maintenance.",
    core_skills: [
      "Mechanical fitting & assembly",
      "Reading drawings",
      "Filing, drilling, tapping",
      "Alignment & fitment",
      "Use of hand & measuring tools",
    ],
    machine_tools: ["Bench/vice", "Drilling machine", "Hand & power tools"],
    inspection_tools: ["Vernier caliper", "Micrometer", "Try square", "Feeler gauge"],
    responsibilities: [
      "Carry out fitting, assembly, and alignment as per drawings",
      "Perform filing, drilling, tapping, and finishing operations",
      "Assist in installation and maintenance of equipment",
      "Check fitment with measuring tools and correct as needed",
    ],
    safety_points: [
      "Safe use of hand and power tools",
      "PPE compliance and good housekeeping",
    ],
    experience_phrases: [
      "Delivered accurate fitting and assembly work",
      "Supported smooth installation and maintenance",
    ],
    fresher_phrases: [
      "ITI (Fitter) seeking a first fitting role",
      "Trained in fitting, drilling, and assembly fundamentals",
    ],
    certification_phrases: ["ITI (Fitter)", "Apprenticeship (NCVT/SCVT)"],
    keywords: ["fitter", "fitting", "assembly", "maintenance", "ITI", "mechanical"],
  }),
];

/** Required trades for Phase-1 (Task 2 acceptance). Tests assert all are present. */
export const REQUIRED_TRADE_KEYS = [
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

const BY_KEY = new Map(TRADE_CONTENT.map((t) => [t.trade_key, t]));
const BY_ROLE_ID = new Map<string, TradeContent>();
for (const t of TRADE_CONTENT) {
  for (const roleId of t.taxonomy_role_ids ?? []) BY_ROLE_ID.set(roleId, t);
}

/** Look up trade content by its stable trade_key. */
export function getTradeContent(tradeKey: string): TradeContent | undefined {
  return BY_KEY.get(tradeKey);
}

/**
 * Resolve trade content from a profile's canonical ids. Tries the taxonomy
 * role-id mapping first, then a direct trade_key match (canonical_trade_id may
 * already be a trade_key). Returns undefined when nothing matches — the renderer
 * then falls back to the generic resume (no fabricated trade content).
 */
export function resolveTradeContent(
  canonicalRoleId?: string | null,
  canonicalTradeId?: string | null,
): TradeContent | undefined {
  if (canonicalRoleId) {
    const byRole = BY_ROLE_ID.get(canonicalRoleId) ?? BY_KEY.get(canonicalRoleId);
    if (byRole) return byRole;
  }
  if (canonicalTradeId) {
    const byTrade = BY_KEY.get(canonicalTradeId);
    if (byTrade) return byTrade;
  }
  return undefined;
}
