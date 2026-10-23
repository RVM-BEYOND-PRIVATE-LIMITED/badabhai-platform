import { describe, expect, it } from "vitest";

import { buildResumeRenderInput } from "./resume-render-input";
import { applyTierScope } from "./resume-tier-scope";
import { buildTradeCapabilityRows } from "./trade-resume-map";

/**
 * ═══ #2409 — A REVIEWED "KOI AUR — KHUD LIKHEIN" ANSWER PRINTS IN ITS OWN ROW ═══
 *
 * The worker's typed answer, once the review has let a name through, prints in the capability row
 * of the question he typed it under: on HIS copy, and so on the app's Resume screen, which draws
 * the same rows. The employer portal's masked copy is unchanged (owner ruling 2026-10-22).
 */

const CONTAINER = {
  role_label: "CNC Turner",
  skills: ["CNC lathe operation"],
  resume_profile: {
    role_label: "CNC Turner",
    skills: ["CNC lathe operation"],
    current_city: "Faridabad",
    availability: "immediate",
    experiences: [],
    preferred_locations: ["Faridabad"],
  },
};

function sheet(
  otherAnswers: Record<string, readonly string[]> | undefined,
  audience: "worker" | "employer" = "worker",
) {
  return buildResumeRenderInput(CONTAINER, "Ramesh Kumar", "bb_trade", null, false, audience, {
    packId: "qp_cnc_turning",
    attributes: { turning_machine: ["cnc_lathe"], controller_brand: ["fanuc"] },
    ...(otherAnswers === undefined ? {} : { otherAnswers }),
  });
}

const machines = (input: ReturnType<typeof sheet>) =>
  input.capChipRows?.find((row) => row.key === "turning_machine")?.values ?? null;

describe("the worker's own copy", () => {
  it("prints the reviewed names in the row of the question they were typed under", () => {
    expect(machines(sheet({ turning_machine: ["Batliboi lathe"] }))).toEqual(["Batliboi lathe"]);
  });

  it("the typed answer IS his answer: a stale ticked row for the same question does not print", () => {
    const row = machines(sheet({ turning_machine: ["Batliboi lathe"] }));
    expect(row).not.toContain("CNC lathe / turning centre");
  });

  it("a settled 'nothing prints' leaves the row out, never the stale ticks in its place", () => {
    expect(machines(sheet({ turning_machine: [] }))).toBeNull();
  });

  it("every other row prints exactly as before", () => {
    const before = sheet(undefined);
    const after = sheet({ turning_machine: ["Batliboi lathe"] });
    const others = (input: ReturnType<typeof sheet>) =>
      input.capChipRows?.filter((row) => row.key !== "turning_machine");
    expect(others(after)).toEqual(others(before));
  });

  it("with no typed answers the sheet is exactly today's", () => {
    expect(machines(sheet(undefined))).toEqual(["CNC lathe / turning centre"]);
    expect(sheet({})).toEqual(sheet(undefined));
  });
});

describe("the employer portal's masked copy", () => {
  it("never prints a typed answer, even if a caller passed one", () => {
    const employer = sheet({ turning_machine: ["Batliboi lathe"] }, "employer");
    expect(machines(employer)).toEqual(["CNC lathe / turning centre"]);
    expect(JSON.stringify(employer)).not.toContain("Batliboi");
  });
});

describe("the row builder", () => {
  it("caps typed names at the row's own limit", () => {
    const rows = buildTradeCapabilityRows(
      "qp_cnc_turning",
      {},
      { turning_machine: ["A lathe", "B lathe", "C lathe", "D lathe", "E lathe"] },
    );
    expect(rows.chipRows.find((r) => r.key === "turning_machine")?.values).toHaveLength(4);
  });

  it("never pairs a typed machine with an axis configuration he answered separately", () => {
    const rows = buildTradeCapabilityRows(
      "qp_vmc_milling",
      { milling_machine: ["vmc"], axis_capability: ["three_axis"] },
      { milling_machine: ["Makino VMC"] },
    );
    expect(rows.chipRows.find((r) => r.key === "milling_machine")?.values).toEqual(["Makino VMC"]);
  });
});

describe("the profiling tier", () => {
  it("drops a typed answer to a question the worker's tier does not ask, with its ticks", () => {
    const scoped = applyTierScope(
      {
        packId: "qp_cnc_turning",
        attributes: { turning_machine: ["cnc_lathe"] },
        otherAnswers: { turning_machine: ["Batliboi lathe"], tolerance_band: ["0.01 mm"] },
      },
      {
        tier: "easy",
        itemTiers: new Map([
          ["turning_machine", "easy"],
          ["tolerance_band", "hard"],
        ]),
        statedExperienceYears: null,
      } as never,
    );
    expect(scoped.otherAnswers).toEqual({ turning_machine: ["Batliboi lathe"] });
  });
});
