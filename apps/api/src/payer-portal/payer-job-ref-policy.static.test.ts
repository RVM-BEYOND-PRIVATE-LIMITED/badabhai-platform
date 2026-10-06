import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * #1899 — the payer-session routes must enforce job-reference OWNERSHIP. The chokepoints take a
 * `jobRefPolicy` that defaults to `"normalise"` (the ops routes), so a payer-portal caller that
 * omits it would silently skip the check. This guard fails the build if any payer-portal source
 * calls `requestUnlock(` / `requestDisclosure(` without passing `"payer_owned"`.
 */
const DIR = __dirname;
const CALL = /\.(requestUnlock|requestDisclosure)\(/g;

/** The argument text of the call that opens at `start` (balanced parentheses). */
function callText(src: string, start: number): string {
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")" && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error("unbalanced call");
}

describe("payer-portal — every unlock / disclosure call enforces ownership (#1899)", () => {
  const sources = readdirSync(DIR).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));

  it("finds the two payer-session call sites", () => {
    const calls = sources.flatMap((f) => [...readFileSync(join(DIR, f), "utf8").matchAll(CALL)]);
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });

  for (const file of sources) {
    const src = readFileSync(join(DIR, file), "utf8");
    for (const m of src.matchAll(CALL)) {
      it(`${file}: ${m[1]} passes "payer_owned"`, () => {
        expect(callText(src, m.index! + m[0].length - 1)).toContain('"payer_owned"');
      });
    }
  }
});
