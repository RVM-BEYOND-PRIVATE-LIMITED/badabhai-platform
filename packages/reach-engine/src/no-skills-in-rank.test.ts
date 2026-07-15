import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * ADR-0030 / TAX-6 GUARD — skills NEVER enter the RANK path (CLAUDE.md invariant #4).
 *
 * TAX-6 gives job postings vector-canonicalized `skill_ids` so both sides share ONE id
 * space — but a skills SIGNAL in ranking is a separate, future ADR. This lock makes the
 * accidental coupling a failing test instead of a silent drift. If a future ADR
 * legitimately adds a skills factor, it must edit THIS test in the same diff (the
 * decision becomes visible in review).
 *
 * Coverage (#226 review M2 — no evasion routes):
 * - EVERY non-test source in the reach-engine package (not a hard-coded list, so a new
 *   helper file like `factor.ts` importing skill logic is scanned the day it appears);
 * - the api's reach layer (`apps/api/src/reach`), which BUILDS the RankInputs from DB
 *   rows — the place a `job_postings.skill_ids` read would smuggle a skills signal in
 *   under a neutral field name. Same regexes; the one legitimate incumbent (a test
 *   fixture's prose word "skilled") lives in a `.test.ts`, which is excluded.
 */
const SKILL_RE = /skill/i;
const EMBEDDING_RE = /embedding/i;

function nonTestSources(dir: string): string[] {
  return readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
}

/** Scan CODE, not prose: comments legitimately DOCUMENT the exclusion ("never selects
 * `embedding`", reach.repository.ts D8 header) — the lock must fire on an identifier
 * actually entering the code, not on the sentence promising it never will. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

describe("RANK inputs contain no skills signal (invariant #4 lock)", () => {
  const ENGINE_SRC = __dirname;
  const engineSources = nonTestSources(ENGINE_SRC);

  it("covers the whole RANK core (types/scoring/ranking present)", () => {
    expect(engineSources).toEqual(
      expect.arrayContaining(["types.ts", "scoring.ts", "ranking.ts"]),
    );
  });

  for (const file of nonTestSources(__dirname)) {
    it(`reach-engine/${file} references no skill/embedding signal`, () => {
      const src = stripComments(readFileSync(join(ENGINE_SRC, file), "utf8"));
      expect(src).not.toMatch(SKILL_RE);
      expect(src).not.toMatch(EMBEDDING_RE);
    });
  }

  // The api layer that FEEDS the engine (RankInputs assembly) — same lock.
  const API_REACH = join(__dirname, "..", "..", "..", "apps", "api", "src", "reach");
  for (const file of nonTestSources(API_REACH)) {
    it(`apps/api/src/reach/${file} references no skill/embedding signal`, () => {
      const src = stripComments(readFileSync(join(API_REACH, file), "utf8"));
      expect(src).not.toMatch(SKILL_RE);
      expect(src).not.toMatch(EMBEDDING_RE);
    });
  }
});
