import { describe, expect, it } from "vitest";
import { ATTRIBUTE_TO_MATCH_SKILLS, ROLE_TO_MATCH_SKILL } from "./match-skills";
import { TRADE_CATALOGUE } from "./trade-catalogue";

/**
 * #3053 / ADR-0070 §5 — a worker who reaches a NEW trade by free chat, without its form,
 * earns no skill of that trade until the form's claim question is answered, exactly as the
 * #2022 trades behave. Free chat reaches a match skill only through two bridges: a canonical
 * role id (`ROLE_TO_MATCH_SKILL`) and a corpus attribute (`ATTRIBUTE_TO_MATCH_SKILLS`). The
 * new trades have no `role_*` id on purpose, and no attribute may imply their skill. A row
 * added to either bridge for one of them is a decision for the record, not a quiet fix.
 */
const NEW_TRADE_SKILLS = new Set(
  TRADE_CATALOGUE.filter((t) => t.status === "new").map((t) => t.matchSkillId),
);

describe("trades v2 — free chat earns no new-trade skill without the form (#3053)", () => {
  it("covers the new trades (non-vacuous)", () => {
    expect(NEW_TRADE_SKILLS.size).toBeGreaterThan(30);
    expect(NEW_TRADE_SKILLS).toContain(
      TRADE_CATALOGUE.find((t) => t.roleKind === "quality_engineer")!.matchSkillId,
    );
  });

  it("no canonical role id derives a new trade's skill", () => {
    const hits = Object.entries(ROLE_TO_MATCH_SKILL).filter(([, skill]) =>
      NEW_TRADE_SKILLS.has(skill),
    );
    expect(hits).toEqual([]);
  });

  it("no corpus attribute implies a new trade's skill", () => {
    const hits = Object.entries(ATTRIBUTE_TO_MATCH_SKILLS).filter(([, skills]) =>
      skills.some((skill) => NEW_TRADE_SKILLS.has(skill)),
    );
    expect(hits).toEqual([]);
  });
});
