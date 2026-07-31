import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import * as engine from "./index";

/**
 * MATCHING V1 STATIC PURITY LOCK — adapted from
 * `packages/reach-engine/src/no-skills-in-rank.test.ts` (ADR-0033).
 *
 * V1's promise to a payer is that the order is reproducible: hand a supervisor the
 * row and he can re-derive the position himself. That promise dies the moment the
 * engine reads a clock, a random number, a network, a model — or a weight ledger
 * somebody can quietly re-tune.
 *
 * So this is a STATIC lock on the source, not a behavioural test:
 *  1. No clock / randomness / network / timers in any non-test source.
 *  2. No embedding / cosine / similarity identifier. V1 matches on exact closed-set
 *     ids and a hand-curated relation, never on a learned distance (invariant #4).
 *  3. NO WEIGHTS. Not a ledger, not a multiplier, not a factor. If a future decision
 *     legitimately introduces one, it must edit THIS test in the same diff — the same
 *     instruction ADR-0030/TAX-6 carried and ADR-0033 honoured.
 *  4. `rankKeyCompare` is the ONE ordering export. A second comparator is how a
 *     "temporary" alternative order gets shipped and never removed.
 */
const NON_DETERMINISM_RES = [/Math\.random/, /Date\.now/, /new Date\(/, /fetch\(/, /setTimeout/];
const EMBEDDING_RE = /embedding|cosine|similarity/i;
const WEIGHT_RE = /weight/i;

function nonTestSources(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist") continue;
        walk(full);
      } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
        out.push(relative(dir, full));
      }
    }
  };
  walk(dir);
  return out;
}

/** Scan CODE, not prose — a comment that DOCUMENTS the exclusion must not trip it. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

const SRC = __dirname;
const sources = nonTestSources(SRC);

describe("match-engine purity lock", () => {
  it("covers the whole engine (every module present)", () => {
    expect(sources.sort()).toEqual([
      "config.ts",
      "derive.ts",
      "index.ts",
      "months.ts",
      "rank.ts",
      "reach.ts",
      "tenure.ts",
      "types.ts",
    ]);
  });

  for (const file of sources) {
    it(`${file} is clock-free, random-free, timer-free and network-free`, () => {
      const src = stripComments(readFileSync(join(SRC, file), "utf8"));
      for (const re of NON_DETERMINISM_RES) expect(src, `${file} matched ${re}`).not.toMatch(re);
    });

    it(`${file} references no embedding / similarity signal`, () => {
      const src = stripComments(readFileSync(join(SRC, file), "utf8"));
      expect(src).not.toMatch(EMBEDDING_RE);
    });

    it(`${file} contains NO weight identifier — V1 has no numeric-weight ledger`, () => {
      const src = stripComments(readFileSync(join(SRC, file), "utf8"));
      expect(src).not.toMatch(WEIGHT_RE);
    });
  }

  it("imports nothing but @badabhai/taxonomy, zod and its own modules", () => {
    const importRe = /from\s+["']([^"']+)["']/g;
    for (const file of sources) {
      const src = stripComments(readFileSync(join(SRC, file), "utf8"));
      for (const m of src.matchAll(importRe)) {
        const spec = m[1] ?? "";
        const allowed = spec.startsWith("./") || spec === "@badabhai/taxonomy" || spec === "zod";
        expect(allowed, `${file} imports ${spec}`).toBe(true);
      }
    }
  });

  it("does NOT depend on the weighted reach-engine it replaces", () => {
    for (const file of sources) {
      const src = stripComments(readFileSync(join(SRC, file), "utf8"));
      expect(src, file).not.toContain("reach-engine");
      expect(src, file).not.toContain("reach-learn");
    }
  });

  it("exports exactly ONE comparator, and it is rankKeyCompare", () => {
    const comparators = Object.keys(engine).filter((name) => /compar/i.test(name));
    expect(comparators).toEqual(["rankKeyCompare"]);
  });

  it("exports no score / weight / rating surface at all", () => {
    const offenders = Object.keys(engine).filter((name) => /score|weight|rating|rank_?score/i.test(name));
    expect(offenders).toEqual([]);
  });

  it("exports no plain-object constant that could hide a numeric ledger", () => {
    const allowedObjects = new Set(["DEFAULT_MATCH_CONFIG", "MatchConfigSchema"]);
    const surface = engine as unknown as Record<string, unknown>;
    for (const name of Object.keys(surface)) {
      const value = surface[name];
      if (typeof value === "function" || value === null || typeof value !== "object") continue;
      expect(allowedObjects.has(name), `unexpected object export: ${name}`).toBe(true);
    }
  });

  it("the config surface carries thresholds only — nothing that re-orders the feed", () => {
    // `tierFloorMonths` is a THRESHOLD in months, not a multiplier: it moves a worker
    // between two tiers, it cannot make one column count "more" than another.
    expect(Object.keys(engine.DEFAULT_MATCH_CONFIG).sort()).toEqual([
      "applicantQuota",
      "boostSupplyFloor",
      "engineVersion",
      "freeUnlockCredits",
      "maxConsecutiveSameCompany",
      "maxSkillsPerPosting",
      "monthBucket",
      "relatedSkillsDefault",
      "tierFloorMonths",
    ]);
  });
});
