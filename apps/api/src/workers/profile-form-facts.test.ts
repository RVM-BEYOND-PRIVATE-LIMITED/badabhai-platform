import { describe, expect, it } from "vitest";
import { NO_FORM_FACTS, readProfileFormFacts } from "./profile-form-facts";

const TURNER = "qp_cnc_turning";

/** A turner who walked the whole form: capability, terms page, tenure gate. */
const FULL_TURNER = {
  turning_experience: 5,
  turning_machine: ["cnc_lathe", "vtl"],
  turning_operation: ["facing_od", "boring"],
  salary_expected_max: 28000,
  preferred_locations: ["Pune", "Chakan"],
  availability: { status: "within_week" },
};

describe("readProfileFormFacts (#2201)", () => {
  it("finds every form-fillable dimension on a fully answered turner form", () => {
    expect(readProfileFormFacts({ packId: TURNER, attributes: FULL_TURNER })).toEqual({
      hasSalary: true,
      hasPreferredLocations: true,
      hasAvailability: true,
      hasExperience: true,
      hasMachines: true,
      hasSkills: true,
    });
  });

  it("reports nothing for an empty attribute bag", () => {
    expect(readProfileFormFacts({ packId: TURNER, attributes: {} })).toEqual(NO_FORM_FACTS);
    expect(readProfileFormFacts({ packId: null, attributes: {} })).toEqual(NO_FORM_FACTS);
  });

  it("counts a salary from EITHER end of the band (resolveSalaryBand)", () => {
    const min = readProfileFormFacts({
      packId: TURNER,
      attributes: { salary_expected_min: 15000 },
    });
    const max = readProfileFormFacts({
      packId: TURNER,
      attributes: { salary_expected_max: 15000 },
    });
    expect(min.hasSalary).toBe(true);
    expect(max.hasSalary).toBe(true);
    // A non-positive or non-numeric figure is no figure.
    for (const bad of [0, -5, "abc", null]) {
      expect(
        readProfileFormFacts({ packId: TURNER, attributes: { salary_expected_max: bad } })
          .hasSalary,
      ).toBe(false);
    }
  });

  it("counts availability only for a vocabulary status, never `unknown` or a stray slug", () => {
    const status = (s: unknown) =>
      readProfileFormFacts({ packId: TURNER, attributes: { availability: { status: s } } })
        .hasAvailability;
    expect(status("immediate")).toBe(true);
    expect(status("unknown")).toBe(false);
    expect(status("toString")).toBe(false);
    expect(status(undefined)).toBe(false);
  });

  it("counts a blank-only preferred-locations list as absent", () => {
    expect(
      readProfileFormFacts({ packId: TURNER, attributes: { preferred_locations: ["  ", ""] } })
        .hasPreferredLocations,
    ).toBe(false);
  });

  it("reads experience from THIS pack's tenure gate; 0 (under a year) is a stated answer", () => {
    const tenure = (attributes: Record<string, unknown>, packId: string | null = TURNER) =>
      readProfileFormFacts({ packId, attributes }).hasExperience;
    expect(tenure({ turning_experience: 0 })).toBe(true);
    // Another trade's tenure key on a turner's sheet is not this worker's tenure answer.
    expect(tenure({ welding_experience: 5 })).toBe(false);
    // No descriptor for the pack → no tenure key to read.
    expect(tenure({ turning_experience: 5 }, "qp_not_a_pack")).toBe(false);
    expect(tenure({ turning_experience: -1 })).toBe(false);
  });

  it("splits machines from skills exactly as the résumé text lines do", () => {
    const machinesOnly = readProfileFormFacts({
      packId: TURNER,
      attributes: { turning_machine: ["cnc_lathe"] },
    });
    expect(machinesOnly).toMatchObject({ hasMachines: true, hasSkills: false });
    // A controller rides the Machines line (resume-draft-overlay THE SPLIT).
    expect(
      readProfileFormFacts({ packId: TURNER, attributes: { controller_brand: ["fanuc"] } }),
    ).toMatchObject({ hasMachines: true, hasSkills: false });
    const opsOnly = readProfileFormFacts({
      packId: TURNER,
      attributes: { turning_operation: ["boring"] },
    });
    expect(opsOnly).toMatchObject({ hasMachines: false, hasSkills: true });
    // An unknown slug prints nothing on the sheet, so it counts for nothing here.
    expect(
      readProfileFormFacts({ packId: TURNER, attributes: { turning_machine: ["spaceship"] } })
        .hasMachines,
    ).toBe(false);
  });
});
