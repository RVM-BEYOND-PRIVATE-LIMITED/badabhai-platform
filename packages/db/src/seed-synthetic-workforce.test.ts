import { describe, expect, it } from "vitest";
import { isMatchSkillId } from "@badabhai/taxonomy";
import { DEMO_TRADES } from "./demo-matching-plan";
import { WORKFORCE_TRADES, workforceUuid } from "./seed-synthetic-workforce";

/**
 * The synthetic-workforce seed (#2149) is the cohort payers see in the all-candidates search
 * (ADR-0040, E2): 250 workers with `employer_sharing`. Its trade list is DERIVED from
 * `DEMO_TRADES` at import time, and a trade added there without a derivation route here made the
 * module throw at import (#2513 → every dry run and re-sync dead, unnoticed, because nothing
 * imported it). This file imports it, so that failure is a red test, not a dead seed.
 */
describe("seed-synthetic-workforce — the cohort definition", () => {
  it("imports (the module evaluates its trade table at load time)", () => {
    expect(WORKFORCE_TRADES.length).toBe(20);
  });

  it("every workforce trade is a real match skill with a derivation route", () => {
    for (const trade of WORKFORCE_TRADES) {
      expect(isMatchSkillId(trade.skillId), trade.skillId).toBe(true);
      expect(trade.route, trade.skillId).toBeDefined();
    }
  });

  it("every demo trade is either in the workforce or deliberately excluded (never silently dropped)", () => {
    const inWorkforce = new Set(WORKFORCE_TRADES.map((t) => t.skillId));
    const excluded = DEMO_TRADES.map((t) => t.skillId).filter((id) => !inWorkforce.has(id));
    expect(excluded.sort()).toEqual(
      [
        "mskill_cad_designer_3d",
        "mskill_designer",
        "mskill_edm_wirecut_operator",
        "mskill_imm_operator",
        "mskill_interior_designer",
        "mskill_painter_coater",
        "mskill_plc_automation_tech",
        "mskill_plumber",
      ].sort(),
    );
  });

  it("keeps the face… id namespace production holds", () => {
    expect(workforceUuid("worker", 0)).toBe("face2000-0000-4000-8000-000000000000");
  });
});
