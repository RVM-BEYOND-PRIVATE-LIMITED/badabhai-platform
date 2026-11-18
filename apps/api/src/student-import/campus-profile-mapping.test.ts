import { describe, expect, it } from "vitest";
import { isMatchSkillId } from "@badabhai/taxonomy";
import {
  campusRoleSkill,
  campusSoftwareSkill,
  mapCampusStudentProfile,
  normalizeCampusValue,
} from "./campus-profile-mapping";

/**
 * #2887 — the Campus profile mapping. The owner rule under test: only CERTAIN values map; every
 * closest fit, every value with no BadaBhai skill and every free-text value goes to the unmapped
 * report, so nothing is guessed.
 */

describe("normalizeCampusValue", () => {
  it("folds case, ampersands and punctuation", () => {
    expect(normalizeCampusValue("  Tool &  Die Maker ")).toBe("tool and die maker");
    expect(normalizeCampusValue("NX (Siemens)")).toBe("nx siemens");
    expect(normalizeCampusValue("CNC//VMC Programmer")).toBe("cnc vmc programmer");
  });
});

describe("the certain dictionaries", () => {
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

  it.each([
    ["CAM Programmer", "mskill_cam_programmer"],
    ["Product Design Engineer", "mskill_cad_designer_3d"],
    ["Welder", "mskill_welder"],
    ["Tool & Die Maker", "mskill_tool_die_maker"],
    ["CAD Draftsman", "mskill_designer"],
    ["Interior Designer", "mskill_interior_designer"],
    ["CMM Operator / Programmer", "mskill_quality_inspector"],
  ])("role %s → %s", (role, skill) => {
    expect(campusRoleSkill(role)).toBe(skill);
  });

  it.each([
    // Closest fits: reported, never mapped (owner ruling 17 Nov 2026).
    "Mold Maker",
    "Machine Setter",
    "Machine Operator",
    "Die Design Engineer",
    "Piping Designer",
    "HVAC Designer",
    "3D Architectural Visualizer",
    "PLC Engineer",
    "CAD Designer",
    // No BadaBhai skill at all.
    "Structural Design Engineer",
    "BIM Modeller (Civil)",
    "CAE / FEA Analyst",
    "Architectural Designer",
  ])("role %s is not mapped", (role) => {
    expect(campusRoleSkill(role)).toBeNull();
  });

  it.each(["SketchUp", "3ds Max", "Revit", "ANSYS", "STAAD Pro", "Rhino 3D", "NX / CAM"])(
    "software %s is not mapped",
    (name) => {
      expect(campusSoftwareSkill(name)).toBeNull();
    },
  );

  it("every skill either dictionary can return is a real match skill", () => {
    const names = [
      "SolidWorks",
      "AutoCAD",
      "Mastercam",
      "CAM Programmer",
      "Welder",
      "Fitter",
      "Press Operator",
      "Quality Inspector",
      "Interior Designer",
      "CNC Programmer",
      "Tool & Die Maker",
    ];
    for (const n of names) {
      const s = campusSoftwareSkill(n) ?? campusRoleSkill(n);
      expect(s && isMatchSkillId(s), n).toBe(true);
    }
  });
});

describe("mapCampusStudentProfile", () => {
  it("a fresher from an AutoCAD course with SolidWorks: both skills, months from the evidence, the RVM certificate", () => {
    const out = mapCampusStudentProfile({
      rvm: { course: "AutoCAD Mechanical", trade: null },
      profile: {
        is_fresher: true,
        total_experience_months: 0,
        cad_software: ["AutoCAD"],
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
    });
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
    // CAD Designer (a closest fit) and GD&T (no skill) are reported; the domain is not, because
    // other values mapped.
    expect(out.unmapped).toEqual([
      { field: "job_role", value: "CAD Designer" },
      { field: "skill", value: "GD&T" },
    ]);
  });

  it("an experienced CAM programmer: the role's months come from his experience row", () => {
    const out = mapCampusStudentProfile({
      profile: { total_experience_months: 40, job_role: "CAM Programmer" },
      experience: [{ job_role: "CAM Programmer", skills: ["Mastercam"], duration_months: 30 }],
    });
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

  it("a civil student with nothing certain: no skill, and every value (domain included) reported", () => {
    const out = mapCampusStudentProfile({
      rvm: { course: "Revit Architecture", trade: null },
      profile: {
        job_domain: "Design Civil",
        job_role: "BIM Modeller (Civil)",
        cad_software: ["Revit"],
      },
    });
    expect(out.skills).toEqual([]);
    expect(out.unmapped).toEqual([
      { field: "cad_software", value: "Revit" },
      { field: "course", value: "Revit Architecture" },
      { field: "job_domain", value: "Design Civil" },
      { field: "job_role", value: "BIM Modeller (Civil)" },
    ]);
  });

  it("reports each distinct value once, however often it appears", () => {
    const out = mapCampusStudentProfile({
      profile: { skills: ["ANSYS", "ansys", " ANSYS "] },
      experience: [{ skills: ["Ansys"], duration_months: 6 }],
    });
    expect(out.unmapped).toEqual([{ field: "skill", value: "ANSYS" }]);
  });

  it("an empty or missing profile maps to nothing and reports nothing", () => {
    expect(mapCampusStudentProfile({})).toEqual({
      skills: [],
      totalExperienceMonths: null,
      certificates: [],
      unmapped: [],
    });
  });

  it("ignores bad month values and caps a certificate name at 120 characters", () => {
    const out = mapCampusStudentProfile({
      skill_experience: [
        { skill: "AutoCAD", months: -3 },
        { skill: "Creo", months: Number.NaN },
      ],
      certifications: [{ name: "x".repeat(200), issue_date: "sometime" }],
    });
    expect(out.skills.map((s) => [s.skillId, s.months])).toEqual([
      ["mskill_cad_designer_3d", 0],
      ["mskill_designer", 0],
    ]);
    expect(out.certificates[0]!.name).toHaveLength(120);
    expect(out.certificates[0]!.year).toBeNull();
  });

  it("the RVM course goes through #2752's word rule (the same skill a linked student gets)", () => {
    const out = mapCampusStudentProfile({ rvm: { course: "SolidWorks", trade: null } });
    expect(out.skills.map((s) => s.skillId)).toEqual(["mskill_cad_designer_3d"]);
  });
});
