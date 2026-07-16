import { describe, expect, it } from "vitest";
import { buildResumeRenderInput } from "./resume-render-input";

/**
 * Q14 (ADR-0030 OQ#3): the PDF skills array renders canonical ids + the
 * worker-confirmed raw `skill_labels`, deduped (a label that normalizes to an
 * id with the `skill_` prefix stripped is dropped). Old snapshots without the
 * field must render byte-for-byte as before (default []).
 */
describe("buildResumeRenderInput — skill_labels (Q14)", () => {
  it("renders ids first, then confirmed raw labels", () => {
    const input = buildResumeRenderInput(
      { skills: ["skill_milling"], skill_labels: ["MIG welding", "TIG welding"] },
      null,
      null,
    );
    expect(input.skills).toEqual(["skill_milling", "MIG welding", "TIG welding"]);
  });

  it("drops a label that duplicates a canonical id (skill_ prefix stripped)", () => {
    const input = buildResumeRenderInput(
      { skills: ["skill_milling"], skill_labels: ["Milling", "5-axis setup"] },
      null,
      null,
    );
    expect(input.skills).toEqual(["skill_milling", "5-axis setup"]);
  });

  it("old snapshot without skill_labels renders exactly as before", () => {
    const input = buildResumeRenderInput({ skills: ["skill_milling"] }, null, null);
    expect(input.skills).toEqual(["skill_milling"]);
  });

  it("labels-only snapshot (off-wedge welder) renders the labels", () => {
    const input = buildResumeRenderInput({ skill_labels: ["MIG welding"] }, null, null);
    expect(input.skills).toEqual(["MIG welding"]);
  });
});
