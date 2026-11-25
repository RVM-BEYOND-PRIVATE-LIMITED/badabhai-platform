import { describe, expect, it } from "vitest";
import { LIVE_POSTING_TRADE_KINDS, TRADE_CATALOGUE, isMatchSkillId } from "@badabhai/taxonomy";
import {
  campusRoleSkill,
  campusSoftwareSkill,
  mapCampusStudentProfile,
  normalizeCampusValue,
  type CampusMappingContext,
} from "./campus-profile-mapping";

/**
 * #2887, ruled by #3014 — the Campus profile mapping. Roles and courses go through the one Campus
 * table (CEO pack v2 section 7): a name the table does not hold, or whose new trade is switched
 * off, is HELD (reported, no skill); a "label only" name is listed, not reported; nothing is
 * guessed. Software names keep the 17 Nov certain table, behind the same release gate.
 */

/** Production today: the 0198 seed, the 16 live kinds. */
const LIVE: CampusMappingContext = { postingEnabled: new Set(LIVE_POSTING_TRADE_KINDS) };
/** Every kind released. */
const ALL: CampusMappingContext = {
  postingEnabled: new Set(TRADE_CATALOGUE.map((e) => e.roleKind)),
};

const roleSkill = (role: string, ctx = ALL) => {
  const t = campusRoleSkill(role, ctx);
  return t.kind === "trade" || t.kind === "general_cnc" ? t.skillId : t.kind;
};

describe("normalizeCampusValue", () => {
  it("folds case, ampersands and punctuation", () => {
    expect(normalizeCampusValue("  Tool &  Die Maker ")).toBe("tool and die maker");
    expect(normalizeCampusValue("NX (Siemens)")).toBe("nx siemens");
    expect(normalizeCampusValue("CNC//VMC Programmer")).toBe("cnc vmc programmer");
  });
});

describe("the certain software table (17 Nov)", () => {
  it.each([
    ["SolidWorks", "mskill_cad_designer_3d"],
    ["solidworks", "mskill_cad_designer_3d"],
    ["NX (Siemens)", "mskill_cad_designer_3d"],
    ["Fusion 360", "mskill_cad_designer_3d"],
    ["AutoCAD", "mskill_designer"],
    ["Mastercam", "mskill_cam_programmer"],
    ["PowerMill", "mskill_cam_programmer"],
  ])("software %s → %s", (name, skill) => {
    expect(campusSoftwareSkill(name)).toBe(skill);
  });

  it.each(["SketchUp", "3ds Max", "Revit", "ANSYS", "STAAD Pro", "Rhino 3D", "NX / CAM"])(
    "software %s is not mapped",
    (name) => {
      expect(campusSoftwareSkill(name)).toBeNull();
    },
  );

  it("every software skill is a real match skill", () => {
    for (const n of ["SolidWorks", "AutoCAD", "Mastercam"]) {
      expect(isMatchSkillId(campusSoftwareSkill(n)), n).toBe(true);
    }
  });
});

describe("roles through the Campus table (pack 7.2)", () => {
  it.each([
    ["CAM Programmer", "mskill_cam_programmer"],
    ["CNC Programmer", "mskill_cnc_programmer"],
    ["Product Design Engineer", "mskill_cad_designer_3d"],
    ["Welder", "mskill_welder"],
    ["Tool & Die Maker", "mskill_tool_die_maker"],
    ["Mould Maker", "mskill_tool_die_maker"],
    ["CAD Drafter", "mskill_designer"],
    ["CNC Operator", "mskill_cnc_operator_general"],
    ["Machine Operator", "mskill_cnc_operator_general"],
    ["Piping Designer", "mskill_piping_designer"],
    ["CMM Operator / Programmer", "mskill_cmm_operator"],
  ])("role %s → %s", (role, skill) => {
    expect(roleSkill(role)).toBe(skill);
  });

  it.each([
    "Interior Designer",
    "HVAC Design Engineer",
    "Structural Design Engineer",
    "3D Architectural Visualizer",
  ])("role %s is label only", (role) => {
    expect(roleSkill(role)).toBe("label_only");
  });

  it.each([
    // The 17 Nov rows pack 7.2 does not name (owner ruling 25 Nov 2026).
    "Press Operator",
    "CAD Draftsman",
    "BIW Designer",
    "CAM Engineer",
    "Toolpath Programmer",
    "VMC Programmer",
    "CNC/VMC Programmer",
    "CMM Operator",
    "Machine Setter",
    "BIM Modeller (Civil)",
  ])("role %s is held", (role) => {
    expect(roleSkill(role)).toBe("held");
  });

  it("holds a new trade that is switched off, keeps a skill live before v2", () => {
    expect(roleSkill("CMM Operator / Programmer", LIVE)).toBe("held");
    expect(roleSkill("Piping Designer", LIVE)).toBe("held");
    expect(roleSkill("Product Design Engineer", LIVE)).toBe("mskill_cad_designer_3d");
  });
});

describe("mapCampusStudentProfile", () => {
  it("a fresher from an AutoCAD course, CAD Designer with SolidWorks: both skills, the RVM certificate", () => {
    const out = mapCampusStudentProfile(
      {
        rvm: { course: "AutoCAD Mechanical", trade: null },
        profile: {
          is_fresher: true,
          total_experience_months: 0,
          cad_software: ["AutoCAD", "SolidWorks"],
          skills: ["SolidWorks", "GD&T"],
          job_domain: "Design Mechanical",
          job_role: "CAD Designer",
        },
        skill_experience: [{ skill: "SolidWorks", months: 14 }],
        rvm_certifications: [
          { job_role: "Product Design Engineer", skills: ["SolidWorks"], training_months: 4 },
        ],
        certifications: [
          { name: "GD&T Basics", issuing_authority: "NPTEL", issue_date: "2023-05-01" },
        ],
      },
      LIVE,
    );
    expect(out.skills).toEqual([
      {
        skillId: "mskill_cad_designer_3d",
        industryId: "ind_industrial_manufacturing",
        months: 14,
        monthsBucketed: 12,
      },
      {
        skillId: "mskill_designer",
        industryId: "ind_industrial_manufacturing",
        months: 0,
        monthsBucketed: 0,
      },
    ]);
    expect(out.totalExperienceMonths).toBe(0);
    expect(out.certificates).toEqual([
      {
        name: "RVM CAD certification: Product Design Engineer",
        issuer: "RVM CAD",
        year: null,
        rvm: true,
      },
      { name: "GD&T Basics", issuer: "NPTEL", year: 2023, rvm: false },
    ]);
    // CAD Designer now maps (T58); only GD&T (no skill) is reported.
    expect(out.unmapped).toEqual([{ field: "skill", value: "GD&T", reason: "no_certain_skill" }]);
    // Hints are reported, never written.
    expect(out.hints.map((h) => [h.role, h.hint.questionKey])).toEqual([
      ["CAD Designer", "design_software"],
      ["Product Design Engineer", "design_specialisation"],
    ]);
  });

  it("CAD Designer whose only software is AutoCAD is the 2D draughtsman", () => {
    const out = mapCampusStudentProfile(
      { profile: { job_role: "CAD Designer", cad_software: ["AutoCAD"] } },
      LIVE,
    );
    expect(out.skills.map((s) => s.skillId)).toEqual(["mskill_designer"]);
  });

  it("an experienced CAM programmer: the role's months come from his experience row", () => {
    const out = mapCampusStudentProfile(
      {
        profile: { total_experience_months: 40, job_role: "CAM Programmer" },
        experience: [{ job_role: "CAM Programmer", skills: ["Mastercam"], duration_months: 30 }],
      },
      LIVE,
    );
    expect(out.skills).toEqual([
      {
        skillId: "mskill_cam_programmer",
        industryId: "ind_industrial_manufacturing",
        months: 30,
        monthsBucketed: 30,
      },
    ]);
    expect(out.totalExperienceMonths).toBe(40);
    expect(out.unmapped).toEqual([]);
  });

  it("a civil student: no skill; label-only values listed, the unknown ones held", () => {
    const out = mapCampusStudentProfile(
      {
        rvm: { course: "Revit Architecture", trade: null },
        profile: {
          job_domain: "Design Civil",
          job_role: "BIM Modeller (Civil)",
          cad_software: ["Revit"],
        },
        experience: [{ job_role: "Architectural Designer" }],
      },
      LIVE,
    );
    expect(out.skills).toEqual([]);
    expect(out.labelOnly).toEqual([
      { field: "course", value: "Revit Architecture" },
      { field: "job_role", value: "Architectural Designer" },
    ]);
    expect(out.unmapped).toEqual([
      { field: "cad_software", value: "Revit", reason: "no_certain_skill" },
      { field: "job_domain", value: "Design Civil", reason: "no_certain_skill" },
      { field: "job_role", value: "BIM Modeller (Civil)", reason: "not_in_table" },
    ]);
  });

  it("#3033 a student whose only role is BIM Modeller: the label, no skills", () => {
    // The issue's case: "BIM Modeller" is "none, label only", so the profile carries it as a
    // display label and no worker_skill row may ever be written for it (proved against
    // Postgres in `candidates/campus-label-only.db.test.ts`).
    const out = mapCampusStudentProfile(
      {
        rvm: { course: null, trade: null },
        profile: { job_domain: "Design Architecture", job_role: "BIM Modeller" },
      },
      LIVE,
    );
    expect(out.skills).toEqual([]);
    expect(out.labelOnly).toEqual([{ field: "job_role", value: "BIM Modeller" }]);
    expect(out.unmapped).toEqual([
      { field: "job_domain", value: "Design Architecture", reason: "no_certain_skill" },
    ]);
    expect(out.hints).toEqual([]);
  });

  it("a role on a new trade that is switched off is held with that reason, and gets no skill", () => {
    const out = mapCampusStudentProfile({ profile: { job_role: "Quality Engineer" } }, LIVE);
    expect(out.skills).toEqual([]);
    expect(out.unmapped).toContainEqual({
      field: "job_role",
      value: "Quality Engineer",
      reason: "trade_switched_off",
    });
    const on = mapCampusStudentProfile({ profile: { job_role: "Quality Engineer" } }, ALL);
    expect(on.skills.map((s) => s.skillId)).toEqual(["mskill_quality_engineer"]);
  });

  it("two RVM courses give both trades", () => {
    const out = mapCampusStudentProfile({ rvm: { course: "CNC, VMC", trade: null } }, LIVE);
    expect(out.skills.map((s) => s.skillId)).toEqual(["mskill_cnc_turner", "mskill_vmc_operator"]);
  });

  it("a CNC course is the CNC Turner, never the CNC Programmer", () => {
    const out = mapCampusStudentProfile({ rvm: { course: "CNC", trade: null } }, LIVE);
    expect(out.skills.map((s) => s.skillId)).toEqual(["mskill_cnc_turner"]);
  });

  it("an unknown course is held and named", () => {
    const out = mapCampusStudentProfile({ rvm: { course: "Spoken English", trade: null } }, LIVE);
    expect(out.skills).toEqual([]);
    expect(out.unmapped).toEqual([
      { field: "course", value: "Spoken English", reason: "not_in_table" },
    ]);
  });

  it("reports each distinct value once, however often it appears", () => {
    const out = mapCampusStudentProfile(
      {
        profile: { skills: ["ANSYS", "ansys", " ANSYS "] },
        experience: [{ skills: ["Ansys"], duration_months: 6 }],
      },
      LIVE,
    );
    expect(out.unmapped).toEqual([{ field: "skill", value: "ANSYS", reason: "no_certain_skill" }]);
  });

  it("an empty or missing profile maps to nothing and reports nothing", () => {
    expect(mapCampusStudentProfile({}, LIVE)).toEqual({
      skills: [],
      totalExperienceMonths: null,
      certificates: [],
      unmapped: [],
      labelOnly: [],
      hints: [],
    });
  });

  it("ignores bad month values and caps a certificate name at 120 characters", () => {
    const out = mapCampusStudentProfile(
      {
        skill_experience: [
          { skill: "AutoCAD", months: -3 },
          { skill: "Creo", months: Number.NaN },
        ],
        certifications: [{ name: "x".repeat(200), issue_date: "sometime" }],
      },
      LIVE,
    );
    expect(out.skills.map((s) => [s.skillId, s.months])).toEqual([
      ["mskill_cad_designer_3d", 0],
      ["mskill_designer", 0],
    ]);
    expect(out.certificates[0]!.name).toHaveLength(120);
    expect(out.certificates[0]!.year).toBeNull();
  });

  it("the RVM course gives the same skill a linked student's grant gets", () => {
    const out = mapCampusStudentProfile({ rvm: { course: "SolidWorks", trade: null } }, LIVE);
    expect(out.skills.map((s) => s.skillId)).toEqual(["mskill_cad_designer_3d"]);
  });
});
