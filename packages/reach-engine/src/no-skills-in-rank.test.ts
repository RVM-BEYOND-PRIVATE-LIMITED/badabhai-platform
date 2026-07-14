import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * ADR-0030 / TAX-6 GUARD — skills NEVER enter the RANK path (CLAUDE.md invariant #4).
 *
 * TAX-6 gives job postings vector-canonicalized `skill_ids` so both sides share ONE id
 * space — but a skills SIGNAL in ranking is a separate, future ADR. This lock makes the
 * accidental coupling a failing test instead of a silent drift: no reach-engine source
 * file may reference skills/embeddings at all. If a future ADR legitimately adds a
 * skills factor, it must edit THIS test in the same diff (the decision becomes visible).
 */
describe("RANK inputs contain no skills signal (invariant #4 lock)", () => {
  const SRC = __dirname;
  const sources = readdirSync(SRC).filter(
    (f) => f.endsWith(".ts") && !f.endsWith(".test.ts"),
  );

  it("covers the whole RANK core (types/scoring/ranking present)", () => {
    expect(sources).toEqual(expect.arrayContaining(["types.ts", "scoring.ts", "ranking.ts"]));
  });

  for (const file of ["types.ts", "scoring.ts", "ranking.ts"]) {
    it(`${file} references no skill/embedding signal`, () => {
      const src = readFileSync(join(SRC, file), "utf8");
      expect(src).not.toMatch(/skill/i);
      expect(src).not.toMatch(/embedding/i);
    });
  }
});
