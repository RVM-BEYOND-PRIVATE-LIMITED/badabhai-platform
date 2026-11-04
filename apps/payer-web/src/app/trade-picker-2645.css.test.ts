import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { decl, parseRules, stripComments } from "../../test/css-rules";

/**
 * #2645 — the stylesheet half of the company trade picker's "the 16 trades did not load" spot
 * (postings/trade-picker.tsx; its behaviour is trade-picker.test.tsx). Node env, no layout engine:
 * the declared rule is fenced. The block is the LAST one in globals.css, after W4's, and draws with
 * the existing `.alert` / `.bb-field` tokens — no colour of its own.
 */

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(join(here, "globals.css"), "utf8");
const RULES = parseRules(stripComments(SOURCE));

describe("the trade picker's unavailable spot", () => {
  it("drops the alert's block margin inside the field shell (the field's gap spaces it)", () => {
    const found = RULES.filter((r) => r.selector === ".trade-picker__unavailable" && r.at === "");
    expect(found).toHaveLength(1);
    expect(decl(found[0]!, "margin-bottom")).toBe("0");
  });

  it("lives in one marked block at the end of the stylesheet, with no colour of its own", () => {
    const at = SOURCE.indexOf("/* ══ #2645 16-trade posting");
    expect(at).toBeGreaterThan(SOURCE.indexOf("W4 (#2584)"));
    const code = stripComments(SOURCE.slice(at)).trim();
    expect(code.startsWith(".trade-picker__unavailable")).toBe(true);
    expect(code).not.toMatch(/#[0-9a-f]{3,8}\b|rgb|hsl/i);
  });
});
