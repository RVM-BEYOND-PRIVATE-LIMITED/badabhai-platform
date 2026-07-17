import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WEIGHTS } from "./scoring";

/**
 * ADR-0033 INVERSE LOCK — the skills factor IS in RANK, deterministically, and
 * NOTHING model-shaped ever is (CLAUDE.md invariant #4).
 *
 * HISTORY (why a file named "no-skills-in-rank" now asserts skills ARE in rank):
 * the ADR-0030 / TAX-6 version of this test locked skills OUT of the RANK path and
 * carried its own edit instruction — "If a future ADR legitimately adds a skills
 * factor, it must edit THIS test in the same diff." ADR-0033 is that ADR: the owner
 * ruled (2026-07-17, team-decisions item 2) that the 2026-06-19 CEO weight lock is
 * OPERATIVE and supersedes ADR-0006's code-wins direction, so the deterministic
 * closed-set skills-overlap factor entered RANK at weight .15 — and this test was
 * edited in the same diff, exactly as instructed. The FILENAME is kept so every
 * existing reference (ADR-0030, schema.ts TAX-6 comments, the drift register)
 * still resolves to the lock that replaced it.
 *
 * WHAT THIS LOCK NOW ASSERTS:
 *  1. UNCHANGED HALF — no /embedding/i (or cosine/similarity/vector) identifier in
 *     any non-test source of the reach-engine package OR the api's reach layer
 *     (`apps/api/src/reach`, which builds the RankInputs from DB rows). Comment-
 *     stripped, so prose can't satisfy or trip it. Skills-similarity-by-embedding
 *     in RANK still requires its own ADR + an edit HERE.
 *  2. DETERMINISM — no clock/randomness/network enters the engine sources (the
 *     factor must stay pure: exact `skill_id` equality, no model, no time).
 *  3. THE FACTOR EXISTS — `skillsOverlap` is implemented in scoring.ts, the full
 *     2026-06-19 CEO weight ledger is pinned (skills at .15), and ADR-0033 is
 *     referenced at the factor site (the decision stays visible in the code).
 */
const EMBEDDING_RE = /embedding|cosine|similarity/i;
// The engine is clock-free + random-free + network-free by contract (ADR-0006).
const NON_DETERMINISM_RES = [/Math\.random/, /Date\.now/, /new Date\(/, /fetch\(/, /setTimeout/];

function nonTestSources(dir: string): string[] {
  return readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
}

/** Scan CODE, not prose: comments legitimately DOCUMENT the exclusion ("never selects
 * `embedding`", reach.repository.ts D8 header) — the lock must fire on an identifier
 * actually entering the code, not on the sentence promising it never will. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

describe("RANK skills factor lock (ADR-0033) — deterministic-only, invariant #4", () => {
  const ENGINE_SRC = __dirname;
  const engineSources = nonTestSources(ENGINE_SRC);

  it("covers the whole RANK core (types/scoring/ranking present)", () => {
    expect(engineSources).toEqual(
      expect.arrayContaining(["types.ts", "scoring.ts", "ranking.ts"]),
    );
  });

  // ── 1. The unchanged TAX-6 half: nothing embedding/model-shaped in the RANK path ──
  for (const file of engineSources) {
    it(`reach-engine/${file} references no embedding/similarity signal`, () => {
      const src = stripComments(readFileSync(join(ENGINE_SRC, file), "utf8"));
      expect(src).not.toMatch(EMBEDDING_RE);
    });
  }

  // The api layer that FEEDS the engine (RankInputs assembly) — same embedding lock.
  // (It may legitimately read canonical `skill_ids` since ADR-0033 — closed-set ids
  // are a RANK input now — but never an embedding column.)
  const API_REACH = join(__dirname, "..", "..", "..", "apps", "api", "src", "reach");
  for (const file of nonTestSources(API_REACH)) {
    it(`apps/api/src/reach/${file} references no embedding/similarity signal`, () => {
      const src = stripComments(readFileSync(join(API_REACH, file), "utf8"));
      expect(src).not.toMatch(EMBEDDING_RE);
    });
  }

  // ── 2. Determinism: the engine stays pure (no clock, no randomness, no network) ──
  for (const file of engineSources) {
    it(`reach-engine/${file} is clock-free, random-free and network-free`, () => {
      const src = stripComments(readFileSync(join(ENGINE_SRC, file), "utf8"));
      for (const re of NON_DETERMINISM_RES) expect(src).not.toMatch(re);
    });
  }

  // ── 3. The ADR-0033 factor exists, at the CEO-locked weight, with the ADR cited ──
  it("scoring.ts implements the deterministic skillsOverlap factor and cites ADR-0033", () => {
    const raw = readFileSync(join(ENGINE_SRC, "scoring.ts"), "utf8");
    expect(stripComments(raw)).toMatch(/function skillsOverlap/);
    // The decision reference lives in the doc comments — scan the RAW source.
    expect(raw).toContain("ADR-0033");
  });

  it("pins the full 2026-06-19 CEO weight ledger (ADR-0033) — edit ONLY via a new ADR", () => {
    expect(WEIGHTS).toEqual({
      role: 0.35,
      distance: 0.2,
      skills: 0.15,
      experience: 0.15,
      pay: 0.1,
      availability: 0.05,
      activity: 0,
    });
  });
});
