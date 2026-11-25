import { describe, expect, it } from "vitest";
import {
  CAMPUS_DOMAIN_ROWS,
  CAMPUS_PRE_V2_SKILLS,
  campusSkillReleased,
  CAMPUS_ROLE_ROWS,
  CAMPUS_ROLE_TO_TRADE,
  CAMPUS_TRADE_MAP_CODES,
  RVM_COURSE_ROWS,
  campusDomainDepartment,
  campusRoleTrade,
  campusTradeEntry,
  normalizeCampusName,
  rvmCourseTrades,
  splitRvmCourses,
  type CampusTranslation,
} from "./campus-trade-map";
import { LIVE_POSTING_TRADE_KINDS } from "./posting-trades";
import { getMatchSkill } from "./match-skills";
import { TRADE_CATALOGUE } from "./trade-catalogue";

/** Every kind released: the table's own answers, before the switch. */
const ALL = new Set(TRADE_CATALOGUE.map((e) => e.roleKind));
/** Today's production switch: the 16 live kinds only (the 0198 seed). */
const LIVE = new Set<string>(LIVE_POSTING_TRADE_KINDS);

const code = (t: CampusTranslation): string =>
  t.kind === "trade" ? t.code : t.kind === "held" ? `held:${t.reason}` : t.kind;

/**
 * Pack section 7.2, transcribed independently of the table (role → expected answer). The test
 * below also checks this list and the table hold exactly the same names.
 */
const PACK_7_2: readonly [string, string][] = [
  ["CAD Designer", "T58"],
  ["Mechanical Design Engineer", "T58"],
  ["Design Engineer", "T58"],
  ["Product Design Engineer", "T58"],
  ["Mold Design Engineer", "T58"],
  ["Die Design Engineer", "T58"],
  ["Tool Design Engineer", "T58"],
  ["Jig & Fixture Design Engineer", "T58"],
  ["Sheet Metal Design Engineer", "T58"],
  ["CAD Drafter", "T05"],
  ["Draughtsman (Mechanical)", "T05"],
  ["Piping Designer", "T60"],
  ["CAE / FEA Analyst", "T59"],
  ["HVAC Design Engineer", "label_only"],
  ["ArtCAM Designer", "T21"],
  ["CAM Programmer", "T04"],
  ["CNC Programmer", "T04"],
  ["Machine Operator", "general_cnc"],
  ["CNC Operator", "general_cnc"],
  ["CNC Turner", "T01"],
  ["Lathe Operator", "T01"],
  ["VMC Operator", "T02"],
  ["HMC Operator", "T02"],
  ["Milling Operator", "T02"],
  ["Grinding Operator", "T03"],
  ["Wire-cut / EDM Operator", "T17"],
  ["Tool & Die Maker", "T07"],
  ["Tool Room Engineer", "T07"],
  ["Mould Maker", "T07"],
  ["Welder", "T08"],
  ["Fabricator", "T22"],
  ["Fitter", "T12"],
  ["Production Engineer", "T46"],
  ["Manufacturing Engineer (running a shop)", "T46"],
  ["Process Engineer", "T47"],
  ["Industrial Engineer", "T47"],
  ["Tooling Engineer", "T47"],
  ["Manufacturing Engineer (process planning)", "T47"],
  ["Production Supervisor", "T45"],
  ["Shift In-charge", "T45"],
  ["Quality Engineer", "T37"],
  ["QA / QC Engineer", "T37"],
  ["Supplier Quality Engineer", "T37"],
  ["Quality Inspector", "T16"],
  ["QC Inspector", "T16"],
  ["CMM Operator / Programmer", "T33"],
  ["NDT Technician", "T34"],
  ["PPC Engineer", "T52"],
  ["Material Planner", "T52"],
  ["Production Planner", "T52"],
  ["Vendor Development Engineer", "T54"],
  ["Purchase Engineer", "T54"],
  ["Sourcing Engineer", "T54"],
  ["Store Keeper", "T53"],
  ["Stores Executive", "T53"],
  ["Logistics Executive", "T55"],
  ["Dispatch Executive", "T55"],
  ["Maintenance Engineer", "T43"],
  ["Reliability Engineer", "T43"],
  ["Maintenance Technician", "T13"],
  ["R&D Engineer", "T48"],
  ["NPD Engineer", "T48"],
  ["Prototype Engineer", "T48"],
  ["Development Engineer", "T48"],
  ["Field Service Engineer", "T44"],
  ["Service Engineer", "T44"],
  ["Application Engineer", "T51"],
  ["Technical Sales Engineer", "T51"],
  ["Pre-sales Engineer", "T51"],
  ["Project Engineer", "T50"],
  ["Site Engineer", "T50"],
  ["PLC Engineer", "T38"],
  ["Automation Engineer", "T38"],
  ["SCADA Engineer", "T38"],
  ["DCS Engineer", "T38"],
  ["Robotics Engineer", "T39"],
  ["Instrumentation Engineer", "T40"],
  ["Safety Engineer", "T49"],
  ["EHS Engineer", "T49"],
  ["Structural Design Engineer", "label_only"],
  ["Bridge Design Engineer", "label_only"],
  ["BIM Modeller", "label_only"],
  ["CAD Drafter (Civil)", "label_only"],
  ["Architectural Designer", "label_only"],
  ["Interior Designer", "label_only"],
  ["3D Architectural Visualizer", "label_only"],
];

/** Pack section 7.3, transcribed independently (course → expected trade code, or label_only). */
const PACK_7_3: readonly [string, string][] = [
  ["CNC", "T01"],
  ["CNC Operating + Setting", "T01"],
  ["CNC C-Axis", "T01"],
  ["CNC Y-Axis", "T01"],
  ["VMC", "T02"],
  ["VMC Operating + Setting", "T02"],
  ["AutoCAD Mechanical", "T05"],
  ["AutoCAD Civil", "T05"],
  ["AutoCAD 2D", "T05"],
  ["SolidWorks", "T58"],
  ["CATIA", "T58"],
  ["NX CAD", "T58"],
  ["Creo", "T58"],
  ["Mastercam", "T04"],
  ["Delcam / PowerMill", "T04"],
  ["SolidCAM", "T04"],
  ["NX CAM", "T04"],
  ["Work NC", "T04"],
  ["Fusion 360 CAM", "T04"],
  ["Esprit", "T04"],
  ["ArtCAM", "T21"],
  ["PLC", "T38"],
  ["PLC Siemens", "T38"],
  ["HMI", "T38"],
  ["SCADA", "T38"],
  ["Full Automation", "T38"],
  ["Robotics", "T39"],
  ["Revit", "label_only"],
  ["Staad Pro", "label_only"],
];

describe("pack 7.2 — Campus role to trade", () => {
  it("holds exactly the names of pack 7.2, each once", () => {
    expect([...CAMPUS_ROLE_TO_TRADE.keys()].sort()).toEqual(
      PACK_7_2.map(([r]) => normalizeCampusName(r)).sort(),
    );
  });

  it.each(PACK_7_2)("%s → %s", (role, expected) => {
    expect(code(campusRoleTrade(role, { postingEnabled: ALL }))).toBe(expected);
  });

  it("names only catalogue trades whose skill is seeded with an industry", () => {
    for (const c of CAMPUS_TRADE_MAP_CODES) {
      const entry = campusTradeEntry(c);
      expect(entry, c).toBeDefined();
      expect(getMatchSkill(entry!.matchSkillId), c).toBeDefined();
    }
  });

  it("gives each trade its catalogue skill, kind and department", () => {
    const r = campusRoleTrade("Quality Engineer", { postingEnabled: ALL });
    expect(r).toEqual({
      kind: "trade",
      code: "T37",
      roleKind: "quality_engineer",
      skillId: "mskill_quality_engineer",
      industryId: getMatchSkill("mskill_quality_engineer")!.industryId,
      department: "Quality & Metrology",
      hint: null,
    });
  });

  it("keeps the live CNC Programmer skill on T04", () => {
    const r = campusRoleTrade("CNC Programmer", { postingEnabled: ALL });
    expect(r.kind === "trade" && [r.code, r.roleKind, r.skillId]).toEqual([
      "T04",
      "cam_programmer",
      "mskill_cnc_programmer",
    ]);
    const cam = campusRoleTrade("CAM Programmer", { postingEnabled: ALL });
    expect(cam.kind === "trade" && cam.skillId).toBe("mskill_cam_programmer");
  });

  it("sends Machine Operator and CNC Operator to the live general CNC skill", () => {
    for (const role of ["Machine Operator", "CNC Operator"]) {
      const r = campusRoleTrade(role, { postingEnabled: new Set() });
      // Not a trade kind, so no release switch applies to it.
      expect(r.kind === "general_cnc" && r.skillId).toBe("mskill_cnc_operator_general");
    }
  });

  describe("CAD Designer", () => {
    const cad = (software: string[] | null) =>
      code(campusRoleTrade("CAD Designer", { postingEnabled: ALL, software }));
    it("is T58, with the software chips as its hint", () => {
      expect(cad(["SolidWorks", "AutoCAD"])).toBe("T58");
      expect(cad(null)).toBe("T58");
      expect(cad([])).toBe("T58");
      const r = campusRoleTrade("CAD Designer", { postingEnabled: ALL });
      expect(r.kind === "trade" && r.hint).toEqual({
        kind: "software_chips",
        questionKey: "design_software",
        confirmed: false,
      });
    });
    it("is T05 when the only software listed is AutoCAD", () => {
      expect(cad(["AutoCAD"])).toBe("T05");
      expect(cad(["AutoCAD", "AutoCAD Mechanical", " "])).toBe("T05");
    });
  });

  it("declares hints as unconfirmed answers, never a rung", () => {
    const hint = (role: string) => {
      const r = campusRoleTrade(role, { postingEnabled: ALL });
      return r.kind === "trade" ? r.hint : "not a trade";
    };
    expect(hint("ArtCAM Designer")).toEqual({
      kind: "answer",
      questionKey: "router_level",
      values: ["programmer"],
      confirmed: false,
    });
    expect(hint("Product Design Engineer")).toMatchObject({
      questionKey: "design_specialisation",
      values: ["product_design"],
    });
    expect(hint("Mold Design Engineer")).toMatchObject({ values: ["mould_design"] });
    expect(hint("Die Design Engineer")).toMatchObject({ values: ["press_tool"] });
    expect(hint("Tool Design Engineer")).toMatchObject({ values: ["mould_design", "press_tool"] });
    expect(hint("Jig & Fixture Design Engineer")).toMatchObject({ values: ["jig_fixture"] });
    expect(hint("Sheet Metal Design Engineer")).toMatchObject({ values: ["sheet_metal"] });
    expect(hint("Design Engineer")).toBeNull();
    for (const row of CAMPUS_ROLE_ROWS) {
      if (row.target.kind === "trade" && row.target.hint) {
        expect(row.target.hint.confirmed).toBe(false);
      }
    }
  });

  it("matches the whole normalised name: case, spacing and punctuation only", () => {
    expect(code(campusRoleTrade("  cnc   TURNER ", { postingEnabled: ALL }))).toBe("T01");
    expect(code(campusRoleTrade("Wire cut/EDM operator", { postingEnabled: ALL }))).toBe("T17");
    expect(code(campusRoleTrade("R & D Engineer", { postingEnabled: ALL }))).toBe("T48");
  });

  it.each([
    "Senior CNC Operator",
    "CNC",
    "Operator",
    "Engineer",
    "Manufacturing Engineer",
    "Draughtsman",
    "Mould Design Engineer",
    // 17 Nov import rows the pack does not name (owner ruling 25 Nov: held).
    "Press Operator",
    "CAD Draftsman",
    "BIW Designer",
    "CAM Engineer",
    "VMC Programmer",
    "CMM Operator",
  ])("holds %s: never a single word, never a guess", (role) => {
    expect(campusRoleTrade(role, { postingEnabled: ALL })).toEqual({
      kind: "held",
      reason: "not_in_table",
      code: null,
    });
  });

  it("answers no_role for an empty role", () => {
    for (const role of ["", "   ", null, undefined]) {
      expect(campusRoleTrade(role, { postingEnabled: ALL }).kind).toBe("no_role");
    }
  });

  it("holds a role whose trade is new in v2 and switched off", () => {
    expect(campusRoleTrade("Quality Engineer", { postingEnabled: LIVE })).toEqual({
      kind: "held",
      reason: "trade_switched_off",
      code: "T37",
    });
    expect(code(campusRoleTrade("Quality Engineer", { postingEnabled: ALL }))).toBe("T37");
    expect(code(campusRoleTrade("ArtCAM Designer", { postingEnabled: LIVE }))).toBe(
      "held:trade_switched_off",
    );
  });

  it("never holds a skill that was live before v2, whatever the switch (tracking #3024 rule 1)", () => {
    // T58 is switched off in the 0198 seed, but its skill is live today.
    expect(code(campusRoleTrade("Product Design Engineer", { postingEnabled: LIVE }))).toBe("T58");
    expect(code(campusRoleTrade("CNC Turner", { postingEnabled: new Set() }))).toBe("T01");
    expect(code(campusRoleTrade("PLC Engineer", { postingEnabled: new Set() }))).toBe("T38");
  });
});

describe("pack 7.3 — RVM course to trade", () => {
  it.each(PACK_7_3)("%s → %s", (course, expected) => {
    const r = rvmCourseTrades(course, ALL);
    const got =
      r.trades[0]?.code ?? (r.labelOnly.length > 0 ? "label_only" : `held:${r.held[0]?.reason}`);
    expect(got).toBe(expected);
  });

  it("names every course row of the table in the transcription", () => {
    const named = new Set(PACK_7_3.map(([c]) => normalizeCampusName(c)));
    for (const row of RVM_COURSE_ROWS) {
      for (const c of row.courses) expect(named.has(normalizeCampusName(c)), c).toBe(true);
    }
  });

  it("never gives CNC Programmer from the word CNC", () => {
    for (const course of ["CNC", "CNC Operating + Setting", "CNC C-Axis", "CNC Y-Axis"]) {
      const skills = rvmCourseTrades(course, ALL).trades.map((t) => t.skillId);
      expect(skills).toEqual(["mskill_cnc_turner"]);
    }
    expect(rvmCourseTrades("CNC Programming", ALL).trades).toEqual([]);
  });

  it("gives both trades for two courses, in the order listed, each at trainee", () => {
    const r = rvmCourseTrades("CNC, VMC", ALL);
    expect(r.trades.map((t) => [t.code, t.level, t.confirmed])).toEqual([
      ["T01", "trainee", false],
      ["T02", "trainee", false],
    ]);
    expect(rvmCourseTrades("Mastercam, SolidWorks", ALL).trades.map((t) => t.code)).toEqual([
      "T04",
      "T58",
    ]);
    expect(rvmCourseTrades(["SolidWorks", "Mastercam"], ALL).trades.map((t) => t.code)).toEqual([
      "T58",
      "T04",
    ]);
  });

  it("lists a trade two courses give once", () => {
    expect(rvmCourseTrades("CNC, CNC C-Axis", ALL).trades.map((t) => t.course)).toEqual(["CNC"]);
  });

  it("keeps + and / inside a course name", () => {
    expect(splitRvmCourses("CNC Operating + Setting, Delcam / PowerMill")).toEqual([
      "CNC Operating + Setting",
      "Delcam / PowerMill",
    ]);
  });

  it("holds an unknown course and a course whose new trade is switched off", () => {
    expect(rvmCourseTrades("Spoken English, CNC", ALL)).toMatchObject({
      trades: [{ code: "T01" }],
      held: [{ course: "Spoken English", reason: "not_in_table" }],
    });
    expect(rvmCourseTrades("ArtCAM, CNC", LIVE)).toMatchObject({
      trades: [{ code: "T01" }],
      held: [{ course: "ArtCAM", reason: "trade_switched_off" }],
    });
    expect(rvmCourseTrades("Robotics", LIVE).held).toEqual([
      { course: "Robotics", reason: "trade_switched_off" },
    ]);
  });

  it("keeps a SolidWorks student's live 3D CAD skill while T58 is switched off", () => {
    expect(rvmCourseTrades("SolidWorks", LIVE).trades.map((t) => t.skillId)).toEqual([
      "mskill_cad_designer_3d",
    ]);
  });

  it("gives nothing for an empty or missing course", () => {
    for (const c of ["", " , ", null, undefined]) {
      expect(rvmCourseTrades(c, ALL)).toEqual({ trades: [], labelOnly: [], held: [] });
    }
  });
});

describe("the release gate", () => {
  it("exempts exactly the 35 skills that predate CEO pack v2", () => {
    expect(CAMPUS_PRE_V2_SKILLS.size).toBe(35);
    expect(CAMPUS_PRE_V2_SKILLS.has("mskill_cad_designer_3d")).toBe(true);
    expect(CAMPUS_PRE_V2_SKILLS.has("mskill_cnc_operator_general")).toBe(true);
    // A deepened trade whose skill is new in v2 is held like any new trade.
    expect(CAMPUS_PRE_V2_SKILLS.has("mskill_foundry_operator")).toBe(false);
    expect(CAMPUS_PRE_V2_SKILLS.has("mskill_quality_engineer")).toBe(false);
  });

  it("releases a new trade's skill once its switch is on", () => {
    expect(campusSkillReleased("mskill_quality_engineer", LIVE)).toBe(false);
    expect(campusSkillReleased("mskill_quality_engineer", new Set(["quality_engineer"]))).toBe(true);
    expect(campusSkillReleased("mskill_designer", new Set())).toBe(true);
    expect(campusSkillReleased("mskill_not_a_skill", ALL)).toBe(false);
  });
});

describe("pack 7.1 — Campus domain to department", () => {
  it.each([
    ["Design Mechanical", null, "Design"],
    ["Quality", null, "Quality & Metrology"],
    ["Supply Chain", null, "Planning & Supply Chain"],
    ["Maintenance & Reliability", null, "Maintenance & Automation"],
    ["R&D / NPD", null, "Production & Engineering"],
    ["Project & Site", null, "Production & Engineering"],
    ["Automation & Mechatronics", null, "Maintenance & Automation"],
    ["Industrial Automation (Electrical)", null, "Maintenance & Automation"],
    ["HSE / Safety", null, "Production & Engineering"],
    ["Technical Sales & Marketing", null, "Production & Engineering"],
    ["Design Civil", null, null],
    ["Design Architecture", null, null],
    ["Production", "CNC Turner", "Machining"],
    ["Production", "Welder", "Sheet Metal & Fabrication"],
    ["Production", "Production Supervisor", "Production & Engineering"],
    ["Production", "Quality Engineer", null],
    ["Service & Aftermarket", "Service Engineer", "Maintenance & Automation"],
    ["Service & Aftermarket", "Application Engineer", "Production & Engineering"],
    ["Service & Aftermarket", "CNC Turner", null],
    ["Unknown Domain", null, null],
  ])("%s (role %s) → %s", (domain, role, expected) => {
    const r = role ? campusRoleTrade(role, { postingEnabled: ALL }) : null;
    expect(campusDomainDepartment(domain, r)).toBe(expected);
  });

  it("names only the 11 departments of the catalogue", () => {
    const departments = new Set(TRADE_CATALOGUE.map((e) => e.department));
    for (const row of CAMPUS_DOMAIN_ROWS) {
      const named =
        row.target.kind === "department"
          ? [row.target.department]
          : row.target.kind === "by_role"
            ? row.target.departments
            : [];
      for (const d of named) expect(departments.has(d), d).toBe(true);
    }
  });
});
