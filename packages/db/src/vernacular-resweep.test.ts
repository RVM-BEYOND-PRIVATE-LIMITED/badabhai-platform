/**
 * §5a — the vernacular collision re-sweep, and the tripwire for the condition that produced it.
 *
 * ===========================================================================
 * THE CONDITION THIS FILE EXISTS TO CATCH
 * ===========================================================================
 * `config.py` justifies the 0.75 floor with three measured ceilings and instructs a re-sweep
 * "on any corpus/model change". The corpus changed on 2026-07-16 — 22 vernacular aliases
 * shipped — and the sweep was not re-run for six weeks. Nothing failed, because **nothing
 * connected the calibration to the corpus it was measured on.**
 *
 * That is the real defect: not the collisions, but the fact that a stale safety argument could
 * sit in a config comment indefinitely and read as current. So the assertions below pin the
 * MEASUREMENT to the corpus, and fail when they drift apart.
 *
 * These read the committed artifact and the repository. No database, no pooler, no spend.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { missingProvenance } from "./evidence-provenance";

const DOCS = join(__dirname, "..", "..", "..", "docs", "registers", "taxonomy-decisions");

interface Collision {
  phrase: string;
  score: number;
  got?: string;
  sibling_skill?: string;
  own_skill?: string;
  wanted?: string;
}

interface Sweep {
  embedding_model: string;
  ai_spend_inr: number;
  floor: number;
  probes: number;
  anchor_scope: string;
  recorded_2026_07_14: Record<string, number>;
  measured: Record<string, number>;
  floor_clears_all_three: boolean;
  above_floor_counts: Record<string, number>;
  anchor_path_collisions_above_floor: Collision[];
  sibling_collisions_above_floor: Collision[];
  duplicate_text_residue: { ceiling: number; distinct_phrases: string[] };
  production_mutation_performed: boolean;
}

const sweep = JSON.parse(readFileSync(join(DOCS, "5a-vernacular-resweep.json"), "utf8")) as Sweep;

describe("the sweep itself", () => {
  it("carries provenance, cost nothing, and wrote nothing", () => {
    expect(missingProvenance(sweep)).toEqual([]);
    expect(sweep.ai_spend_inr).toBe(0);
    expect(sweep.production_mutation_performed).toBe(false);
  });

  it("measured the WHOLE corpus, not just the 22 wedge aliases", () => {
    // The previous instrument probed 22. A ceiling over 22 phrases is not a ceiling.
    expect(sweep.probes).toBe(106);
    expect(sweep.anchor_scope).toBe("cnc-machining");
  });

  it("was measured in ONE embedding space — cosine across models would be meaningless", () => {
    expect(sweep.embedding_model).toBe("gemini-embedding-001");
  });
});

describe("the 2026-07-14 calibration no longer holds", () => {
  it("pins what config.py claims, so a silent edit there is caught", () => {
    expect(sweep.recorded_2026_07_14).toEqual({
      labeled_domain_negative_ceiling: 0.598,
      sibling_confusion_ceiling: 0.722,
      anchor_path_negative_ceiling: 0.7263,
    });
  });

  it("TWO of the three ceilings now exceed the floor — the claim is falsified", () => {
    // config.py: "0.75 clears all three". It does not.
    expect(sweep.floor).toBe(0.75);
    expect(sweep.floor_clears_all_three).toBe(false);
    expect(sweep.measured["anchor_path_negative_ceiling"]).toBeGreaterThan(0.75);
    expect(sweep.measured["sibling_confusion_ceiling"]).toBeGreaterThan(0.75);
  });

  it("the anchor-path ceiling ROSE from 0.7263 to 0.7760", () => {
    expect(sweep.measured["anchor_path_negative_ceiling"]).toBeCloseTo(0.776, 3);
  });

  it("the sibling ceiling rose furthest — 0.722 to 0.8405", () => {
    // The one a scoping fix cannot touch, because it happens inside the correct domain.
    expect(sweep.measured["sibling_confusion_ceiling"]).toBeCloseTo(0.8405, 4);
  });

  it("the labeled-domain 0.0000 is VACUOUS and is labelled as such", () => {
    // A probe scoped to its own domain always matches its own alias at 1.0, so there is never
    // a wrong top-1. Reporting 0.0000 as an improvement would be a lie by omission.
    expect(sweep.measured["labeled_domain_negative_ceiling"]).toBe(0);
    expect((sweep as unknown as Record<string, string>)["labeled_domain_ceiling_is_vacuous"]).toMatch(
      /vacuous|always matches its own alias/i,
    );
  });
});

describe("the two known collisions", () => {
  const byPhrase = new Map(sweep.anchor_path_collisions_above_floor.map((c) => [c.phrase, c]));

  it("BOTH still exist, at the same scores", () => {
    expect(byPhrase.get("welding ka kaam")?.got).toBe("skill_drilling");
    expect(byPhrase.get("welding ka kaam")?.score).toBeCloseTo(0.776, 3);
    expect(byPhrase.get("fitting ka kaam")?.got).toBe("skill_drilling");
    expect(byPhrase.get("fitting ka kaam")?.score).toBeCloseTo(0.7621, 4);
  });

  it("and a THIRD was found that was not previously recorded", () => {
    // The D-7C-1 defect, now confirmed on the anchor path as well as the canonical one.
    expect(byPhrase.get("dimensional inspection")?.got).toBe("skill_drawing_reading");
    expect(byPhrase.get("dimensional inspection")?.score).toBeCloseTo(0.757, 3);
    expect(sweep.above_floor_counts["anchor_path"]).toBe(3);
  });
});

describe("what a scoping fix would and would not reach", () => {
  it("all three anchor-path collisions are cross-domain — scoping WOULD fix them", () => {
    expect(sweep.above_floor_counts["labeled_domain"]).toBe(0);
  });

  it("but 16 sibling collisions are INSIDE the correct domain — scoping cannot reach them", () => {
    // This is the finding that makes re-domaining necessary but not sufficient.
    expect(sweep.above_floor_counts["sibling"]).toBe(16);
    for (const c of sweep.sibling_collisions_above_floor) {
      expect(c.own_skill, c.phrase).not.toBe(c.sibling_skill);
      expect(c.score, c.phrase).toBeGreaterThanOrEqual(0.75);
    }
  });

  it("the worst siblings are genuinely distinct welding processes", () => {
    // GMAW is MIG, SMAW is stick/arc — different machines, different tickets. 0.8405 apart is
    // an artifact of acronym shape, not of the trades being similar.
    const worst = sweep.sibling_collisions_above_floor[0];
    expect(worst?.score).toBeCloseTo(0.8405, 4);
    expect([worst?.own_skill, worst?.sibling_skill].sort()).toEqual([
      "skill_arc_welding",
      "skill_mig_welding",
    ]);
  });

  it("boring/drilling reproduces the D-7A figure exactly — the instruments agree", () => {
    const bd = sweep.sibling_collisions_above_floor.find((c) => c.phrase === "boring");
    expect(bd?.sibling_skill).toBe("skill_drilling");
    expect(bd?.score).toBeCloseTo(0.7556, 4);
  });
});

describe("merge residue is separated from semantic confusion", () => {
  it("8 phrases exist on two skills at 1.0000, and are NOT folded into the ceilings", () => {
    // Folding these in would report a 1.0000 ceiling and drown the actual finding. They are a
    // real defect with a different remedy — the D-7C alias cleanup.
    expect(sweep.duplicate_text_residue.ceiling).toBe(1);
    expect(sweep.duplicate_text_residue.distinct_phrases).toHaveLength(8);
    expect(sweep.duplicate_text_residue.distinct_phrases).toContain("GD&T");
    // The headline ceilings must be strictly below the residue's.
    for (const k of Object.keys(sweep.measured)) {
      expect(sweep.measured[k], k).toBeLessThan(1);
    }
  });
});

// ---------------------------------------------------------------------------
// THE TRIPWIRE. The stale-measurement condition, made mechanical.
// ---------------------------------------------------------------------------
describe("config.py cannot silently keep claiming a calibration it no longer has", () => {
  const configPy = readFileSync(
    join(__dirname, "..", "..", "..", "apps", "ai-service", "app", "config.py"),
    "utf8",
  );

  it("still contains the three numbers this sweep pins, so drift is detectable", () => {
    // If someone edits these in config.py without re-running the sweep, the assertions in
    // "the 2026-07-14 calibration no longer holds" stop describing the file and this fails.
    expect(configPy).toContain("0.598");
    expect(configPy).toContain("0.722");
    expect(configPy).toContain("0.7263");
  });

  it("and the floor it pins is the floor the sweep measured against", () => {
    expect(configPy).toMatch(/skill_canonicalize_floor/);
    expect(sweep.floor).toBe(0.75);
  });

  it("the sweep records WHEN it was true — the property the config comment lacked", () => {
    // The whole failure was a calibration with no measured_at. This one has one, and the
    // provenance test suite asserts every committed artifact does.
    expect(sweep).toHaveProperty("measured_at");
    expect(String((sweep as unknown as Record<string, string>)["measured_at"])).toMatch(/^2026-/);
  });
});
