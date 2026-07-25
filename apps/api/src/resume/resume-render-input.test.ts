import { describe, expect, it } from "vitest";
import { buildResumeRenderInput } from "./resume-render-input";

/**
 * Q14 (ADR-0030 OQ#3): the PDF skills array renders canonical ids + the
 * worker-confirmed raw `skill_labels`, deduped (a label that normalizes to an
 * id with the `skill_` prefix stripped is dropped). Old snapshots without the
 * field must render byte-for-byte as before (default []).
 */
describe("buildResumeRenderInput — skill_labels (Q14)", () => {
  it("resolves skill ids to NAMES first, then confirmed raw labels", () => {
    const input = buildResumeRenderInput(
      { skills: ["skill_milling"], skill_labels: ["MIG welding", "TIG welding"] },
      null,
      null,
      null, // photoDataUri (ADR-0032): caller-supplied; these tests render photo-less
    );
    // skill_milling → "Milling" (the résumé must never show a raw skill_* id).
    expect(input.skills).toEqual(["Milling", "MIG welding", "TIG welding"]);
  });

  it("drops a label that duplicates a resolved skill name", () => {
    const input = buildResumeRenderInput(
      { skills: ["skill_milling"], skill_labels: ["Milling", "5-axis setup"] },
      null,
      null,
      null,
    );
    expect(input.skills).toEqual(["Milling", "5-axis setup"]);
  });

  it("old snapshot without skill_labels resolves its ids to names", () => {
    const input = buildResumeRenderInput({ skills: ["skill_milling"] }, null, null, null);
    expect(input.skills).toEqual(["Milling"]);
  });

  it("labels-only snapshot (off-wedge welder) renders the labels", () => {
    const input = buildResumeRenderInput({ skill_labels: ["MIG welding"] }, null, null, null);
    expect(input.skills).toEqual(["MIG welding"]);
  });
});

/**
 * #499 — education + certifications now ride on the DraftProfile snapshot, so the
 * templates' "Education & Certifications" section renders instead of collapsing.
 * Old snapshots without the keys default to [] (invariant #8, byte-identical).
 */
describe("buildResumeRenderInput — education + certifications (#499)", () => {
  it("carries education + certifications from the snapshot into the render input", () => {
    const input = buildResumeRenderInput(
      { education: ["ITI", "Diploma"], certifications: ["NCVT"] },
      null,
      null,
      null,
    );
    expect(input.education).toEqual(["ITI", "Diploma"]);
    expect(input.certifications).toEqual(["NCVT"]);
  });

  it("resolves taxonomy IDs in education + certifications to labels", () => {
    const input = buildResumeRenderInput(
      { education: ["skill_milling", "role_cnc_operator"], certifications: ["mach_vmc"] },
      null,
      null,
      null,
    );
    // skill_milling → "Milling", role_cnc_operator → "CNC Operator", mach_vmc → "Vertical Machining Center (VMC)"
    expect(input.education).toEqual(["Milling", "CNC Operator"]);
    expect(input.certifications).toEqual(["Vertical Machining Center (VMC)"]);
  });

  it("old snapshot without the keys defaults both to [] (no fabrication)", () => {
    const input = buildResumeRenderInput({ skills: ["skill_milling"] }, null, null, null);
    expect(input.education).toEqual([]);
    expect(input.certifications).toEqual([]);
  });
});

/**
 * Machines field should resolve taxonomy IDs to display labels.
 */
describe("buildResumeRenderInput — machines", () => {
  it("resolves machine ids to display names", () => {
    const input = buildResumeRenderInput(
      { machines: ["mach_vmc", "mach_cnc_lathe", "mach_hmc"] },
      null,
      null,
      null,
    );
    expect(input.machines).toEqual([
      "Vertical Machining Center (VMC)",
      "CNC Lathe / Turning Center",
      "Horizontal Machining Center (HMC)",
    ]);
  });

  it("prettifies unknown machine ids as fallback", () => {
    const input = buildResumeRenderInput(
      { machines: ["mach_unknown_machine"] },
      null,
      null,
      null,
    );
    expect(input.machines).toEqual(["Unknown Machine"]);
  });

  it("passes through non-id labels unchanged", () => {
    const input = buildResumeRenderInput(
      { machines: ["VMC", "CNC Lathe"] },
      null,
      null,
      null,
    );
    expect(input.machines).toEqual(["VMC", "CNC Lathe"]);
  });

  it("old snapshot without machines defaults to []", () => {
    const input = buildResumeRenderInput({ skills: ["skill_milling"] }, null, null, null);
    expect(input.machines).toEqual([]);
  });
});

/**
 * education_level + education_field ride the DraftProfile snapshot beside the
 * education list, and are threaded to the render input. Old snapshots without the
 * keys default to null (invariant #8).
 */
describe("buildResumeRenderInput — education_level + education_field", () => {
  it("carries education_level + education_field from the snapshot", () => {
    const input = buildResumeRenderInput(
      { education_level: "12th", education_field: "Electronics" },
      null,
      null,
      null,
    );
    expect(input.educationLevel).toBe("12th");
    expect(input.educationField).toBe("Electronics");
  });

  it("old snapshot without the keys defaults both to null (no fabrication)", () => {
    const input = buildResumeRenderInput({ skills: ["skill_milling"] }, null, null, null);
    expect(input.educationLevel).toBeNull();
    expect(input.educationField).toBeNull();
  });
});
