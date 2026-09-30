import { describe, expect, it } from "vitest";
import { workerCardGap, workerCardGaps, type WorkerCardGapInput } from "./worker-card-gap";

/**
 * The gap rule is a UX gate ported from the payer app, with roleKind checked FIRST (web). These pin
 * the ORDER (the message must name the field nearest the payer's eye) and the exact COPY, so a
 * reordering or a copy edit is caught. The API stays permissive; this only blocks create/publish.
 */

/** A COMPLETE card — every row filled, so the rule returns null. */
const FULL: WorkerCardGapInput = {
  roleKind: "cnc_turner",
  city: "Pune",
  payMin: 20000,
  payMax: 35000,
  payType: "in_hand",
  expMin: 1,
  expMax: 5,
  shift: "day",
  neededBy: "immediate",
  description: "Two-shift CNC role.",
  requirements: ["Fanuc control"],
  benefits: ["PF + ESI"],
};

describe("workerCardGap — order + copy", () => {
  it("returns null when the card is complete", () => {
    expect(workerCardGap(FULL)).toBeNull();
  });

  it("checks roleKind FIRST (web) with the 'Pick the role' copy", () => {
    const gap = workerCardGap({ ...FULL, roleKind: null, city: "" });
    expect(gap).not.toBeNull();
    expect(gap!.title).toBe("Pick the role");
    expect(gap!.message).toContain("The role leads the worker's card");
  });

  it("surfaces the FIRST open field in top-to-bottom order", () => {
    const cases: Array<[Partial<WorkerCardGapInput>, string]> = [
      [{ city: "" }, "Add the city"],
      [{ payMin: null }, "Add the pay band"],
      [{ payMax: null }, "Add the pay band"],
      [{ payType: null }, "Pick the pay type"],
      [{ expMin: null }, "Add the experience"],
      [{ expMax: null }, "Add the experience"],
      [{ shift: null }, "Pick the shift"],
      [{ neededBy: null }, "Pick needed by"],
      [{ description: "  " }, "Add the description"],
      [{ requirements: [] }, "Add a requirement"],
      [{ benefits: [] }, "Add a benefit"],
    ];
    for (const [override, title] of cases) {
      const gap = workerCardGap({ ...FULL, ...override });
      expect(gap, JSON.stringify(override)).not.toBeNull();
      expect(gap!.title).toBe(title);
    }
  });

  it("pins the exact pay-band + pay-type copy", () => {
    expect(workerCardGap({ ...FULL, payMin: null })!.message).toContain('"kitna milega"');
    expect(workerCardGap({ ...FULL, payType: null })!.message).toBe(
      "Say what the band means — in-hand, gross or CTC. We never guess it for you.",
    );
  });
});

describe("workerCardGaps — every open field, in order", () => {
  it("returns all gaps top-to-bottom for an empty card", () => {
    const gaps = workerCardGaps({
      roleKind: null,
      city: "",
      payMin: null,
      payMax: null,
      payType: null,
      expMin: null,
      expMax: null,
      shift: null,
      neededBy: null,
      description: "",
      requirements: [],
      benefits: [],
    });
    expect(gaps.map((g) => g.title)).toEqual([
      "Pick the role",
      "Add the city",
      "Add the pay band",
      "Pick the pay type",
      "Add the experience",
      "Pick the shift",
      "Pick needed by",
      "Add the description",
      "Add a requirement",
      "Add a benefit",
    ]);
  });

  it("returns [] for a complete card", () => {
    expect(workerCardGaps(FULL)).toEqual([]);
  });
});
