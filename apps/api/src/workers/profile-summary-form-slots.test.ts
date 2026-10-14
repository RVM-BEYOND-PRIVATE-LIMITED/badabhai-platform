import { describe, expect, it } from "vitest";

import { rawCorpusPack } from "../profiling/form/corpus-pack.test-support";
import { TRADE_RESUME_MAPS, tradeResumeMapFor } from "../resume/trade-resume-map";
import {
  PACK_MACHINE_KEYS,
  PACKS_WITHOUT_MACHINE_QUESTION,
  formFilledSlots,
  type SummaryAttributeRow,
} from "./profile-summary-form-slots";

/**
 * #2257 — which strength slots the worker's own form answers fill.
 *
 * THE DEFECT. A CNC turner who completed the trade form and the preferences page was told
 * "Sirf apni skills aur apni machines bharna baaki hai" at 22%, while the résumé above the card
 * printed "Exp: Fanuc & Siemens". The summary read `worker_profiles` alone and the form never
 * writes it.
 */

const TURNING = "qp_cnc_turning";

function row(over: Partial<SummaryAttributeRow> & { attributeKey: string }): SummaryAttributeRow {
  return {
    packId: null,
    valueNumber: null,
    valueText: null,
    valueTextList: null,
    valueJson: null,
    ...over,
  };
}

const slots = (...rows: SummaryAttributeRow[]) => [...formFilledSlots(rows)].sort();

describe("formFilledSlots — the #2257 worker", () => {
  it("fills skills and machines from a turner's controller and machine answers", () => {
    // The reported case: the résumé prints these two answers, so the card must stop asking.
    expect(
      slots(
        row({ packId: TURNING, attributeKey: "turning_machine", valueTextList: ["cnc_lathe"] }),
        row({
          packId: TURNING,
          attributeKey: "controller_brand",
          valueTextList: ["fanuc", "siemens"],
        }),
      ),
    ).toEqual(["machines", "skills"]);
  });

  it("fills the preferences page's three slots from its own keys, under no pack", () => {
    expect(
      slots(
        row({ attributeKey: "salary_expected_max", valueNumber: "22000.0000" }),
        row({ attributeKey: "preferred_locations", valueTextList: ["Pune"] }),
        row({ attributeKey: "availability", valueJson: { status: "within_month" } }),
      ),
    ).toEqual(["availability", "location", "salary"]);
  });

  it("fills nothing for a worker with no attribute rows", () => {
    expect(slots()).toEqual([]);
  });
});

describe("formFilledSlots — machines", () => {
  it("never scores a none-of-above chip as a machine", () => {
    // `unknown` has no entry in the résumé row's dictionary — the sheet drops it, so does this.
    expect(
      slots(row({ packId: TURNING, attributeKey: "controller_brand", valueTextList: ["unknown"] })),
    ).not.toContain("machines");
  });

  it("reads a machine key only under the pack it was answered in", () => {
    for (const packId of [null, "qp_universal", "qp_not_a_pack"]) {
      expect(
        slots(row({ packId, attributeKey: "turning_machine", valueTextList: ["cnc_lathe"] })),
      ).not.toContain("machines");
    }
  });

  it("does not treat a turner's other capability rows as machines", () => {
    expect(
      slots(row({ packId: TURNING, attributeKey: "measuring_tools", valueTextList: ["vernier"] })),
    ).not.toContain("machines");
  });

  it("reads a single-select's bare value as well as a multi-select's list", () => {
    const spec = tradeResumeMapFor("qp_welding_trade")?.capability.find(
      (s) => s.from === "welding_equipment",
    );
    const slug = Object.keys(spec?.values ?? {})[0];
    expect(slug).toBeDefined();
    expect(
      slots(
        row({ packId: "qp_welding_trade", attributeKey: "welding_equipment", valueText: slug! }),
      ),
    ).toContain("machines");
  });
});

describe("formFilledSlots — skills", () => {
  it("is the matcher's own reading of the pack answers", () => {
    // `facing_od` → `skill_turning` in `PACK_ANSWER_SKILLS`, the table the rebuild derives from.
    expect(
      slots(
        row({ packId: TURNING, attributeKey: "turning_operation", valueTextList: ["facing_od"] }),
      ),
    ).toEqual(["skills"]);
  });

  it("derives no skill from an answer the matcher maps to nothing", () => {
    // `material_worked` is deliberately absent from the table: what he cut, not what he can do.
    expect(
      slots(
        row({ packId: TURNING, attributeKey: "material_worked", valueTextList: ["mild_steel"] }),
      ),
    ).toEqual([]);
  });

  it("derives nothing from a row with no pack", () => {
    expect(slots(row({ attributeKey: "turning_operation", valueTextList: ["facing_od"] }))).toEqual(
      [],
    );
  });
});

describe("formFilledSlots — experience", () => {
  it("counts the role's own tier answer", () => {
    expect(
      slots(
        row({ packId: TURNING, attributeKey: "turning_experience", valueText: "three_to_seven" }),
      ),
    ).toEqual(["experience"]);
  });

  it("does not read another role's tier key under the wrong pack", () => {
    expect(
      slots(row({ packId: TURNING, attributeKey: "welding_experience", valueText: "under_one" })),
    ).toEqual([]);
    expect(slots(row({ attributeKey: "turning_experience", valueText: "under_one" }))).toEqual([]);
  });

  it("ignores a blank tier value", () => {
    expect(
      slots(row({ packId: TURNING, attributeKey: "turning_experience", valueText: "  " })),
    ).toEqual([]);
  });
});

describe("formFilledSlots — salary, location, availability", () => {
  it("counts either end of the salary band, and only a positive amount", () => {
    expect(slots(row({ attributeKey: "salary_expected_min", valueNumber: "15000" }))).toEqual([
      "salary",
    ]);
    for (const valueNumber of [null, "0", "-5", "not a number"]) {
      expect(slots(row({ attributeKey: "salary_expected_max", valueNumber }))).toEqual([]);
    }
  });

  it("does not read a salary figure under any other key", () => {
    expect(slots(row({ attributeKey: "commute_max_km", valueNumber: "20" }))).toEqual([]);
  });

  it("counts a non-empty city list only", () => {
    for (const valueTextList of [[], ["  "], null]) {
      expect(slots(row({ attributeKey: "preferred_locations", valueTextList }))).toEqual([]);
    }
  });

  it("counts only a closed availability status", () => {
    for (const valueJson of [
      { status: "unknown" },
      { status: null },
      { notice_period_days: 30 },
      "immediate",
      ["immediate"],
      null,
    ]) {
      expect(slots(row({ attributeKey: "availability", valueJson }))).toEqual([]);
    }
    expect(
      slots(row({ attributeKey: "availability", valueJson: { status: "immediate" } })),
    ).toEqual(["availability"]);
  });
});

describe("PACK_MACHINE_KEYS — the reviewed table stays true", () => {
  it("names every role pack with a résumé map exactly once", () => {
    // A new role with a sheet must be classified here, or its machines slot never clears.
    for (const { pack_id } of TRADE_RESUME_MAPS) {
      const listed = Object.hasOwn(PACK_MACHINE_KEYS, pack_id);
      const exempt = PACKS_WITHOUT_MACHINE_QUESTION.includes(pack_id);
      expect(listed !== exempt, pack_id).toBe(true);
    }
  });

  it("names only packs that have a résumé map", () => {
    const mapped = new Set(TRADE_RESUME_MAPS.map((m) => m.pack_id));
    for (const packId of [...Object.keys(PACK_MACHINE_KEYS), ...PACKS_WITHOUT_MACHINE_QUESTION]) {
      expect(mapped.has(packId), packId).toBe(true);
    }
  });

  it("names a real question of each pack, printed by the sheet with a dictionary", () => {
    for (const [packId, keys] of Object.entries(PACK_MACHINE_KEYS)) {
      const questions = new Set(rawCorpusPack(packId).items.map((item) => item.question_key));
      const sheet = tradeResumeMapFor(packId);
      for (const key of keys) {
        expect(questions.has(key), `${packId}.${key} is not a pack question`).toBe(true);
        const spec = sheet?.capability.find((s) => s.from === key);
        expect(spec?.values, `${packId}.${key} has no résumé dictionary`).toBeDefined();
      }
    }
  });

  it("reads dictionary slugs the pack actually stores", () => {
    // The dictionary is the gate in `fillsMachines`: a slug spelled differently from the stored
    // option value would silently never fill the slot.
    for (const [packId, keys] of Object.entries(PACK_MACHINE_KEYS)) {
      const pack = rawCorpusPack(packId);
      for (const key of keys) {
        const item = pack.items.find((i) => i.question_key === key);
        const stored = new Set((item?.options ?? []).map((o) => o.value_text ?? o.option_key));
        const spec = tradeResumeMapFor(packId)?.capability.find((s) => s.from === key);
        for (const slug of Object.keys(spec?.values ?? {})) {
          expect(stored.has(slug), `${packId}.${key}: ${slug}`).toBe(true);
        }
      }
    }
  });
});
