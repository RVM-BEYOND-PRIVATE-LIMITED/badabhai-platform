import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { decl, parseRules, stripComments } from "../../test/css-rules";
import type { Rule } from "../../test/css-rules";

/**
 * #2588 (W8) — remaining polish: the stylesheet half (node env, no layout engine, so the DECLARED
 * geometry and motion are fenced; the behaviour half lives beside each component).
 *
 * The block is ONE marked block at the end of globals.css. Where it re-states an earlier rule it
 * wins by ORDER at equal specificity — so this suite pins that order too: a reorder would silently
 * undo the fix with every other gate green.
 */

const here = dirname(fileURLToPath(import.meta.url));
const RAW = readFileSync(join(here, "globals.css"), "utf8");
const MARKER = "W8 (#2588) — REMAINING POLISH";
const CSS = stripComments(RAW);
const RULES: Rule[] = parseRules(CSS);
/** The rules of the W8 block alone (from its marker to the end of the file). */
const W8: Rule[] = parseRules(stripComments(RAW.slice(RAW.lastIndexOf("/*", RAW.indexOf(MARKER)))));
const PHONE = "@media (max-width: 600px)";

/** The ONE rule for exactly `selector` under `at` ("" = top level), in `rules`. */
function rule(selector: string, at = "", rules: Rule[] = RULES): Rule {
  const found = rules.filter((r) => r.selector === selector && r.at === at);
  expect(found, `${at} ${selector}`).toHaveLength(1);
  return found[0]!;
}

describe("the W8 block", () => {
  it("is one marked block (vacuity: it holds rules)", () => {
    expect(RAW.split(MARKER)).toHaveLength(2);
    expect(W8.length).toBeGreaterThanOrEqual(3);
  });
});

describe("the Candidates pager — the rows on screen, then the links", () => {
  it("the range takes the row's free space on the left; the links keep their right edge", () => {
    const range = rule(".candidates-pager__range", "", W8);
    expect(decl(range, "margin-inline-end")).toBe("auto");
    expect(decl(range, "font-variant-numeric")).toBe("tabular-nums");
    expect(decl(range, "color")).toBe("var(--text-secondary)");
    expect(decl(rule(".candidates-pager"), "justify-content")).toBe("flex-end");
  });

  it("on a phone it is a line of its own above the two equal thumb targets", () => {
    expect(decl(rule(".candidates-pager__range", PHONE, W8), "flex")).toBe("1 1 100%");
    expect(decl(rule(".candidates-pager > .bb-btn", PHONE), "flex")).toBe("1 1 0");
  });
});

describe("the list heading — the line it replaced, findable and focusable", () => {
  const h = () => rule(".paged-list-heading", "", W8);

  it("reads as the count/range line, not as a display heading (it inherits the line's type)", () => {
    for (const prop of ["font-family", "font-size", "line-height", "letter-spacing"]) {
      expect(decl(h(), prop), prop).toBe("inherit");
    }
  });

  it("hugs its text (a focus ring hugs it too) and lands below the sticky header", () => {
    expect(decl(h(), "justify-self")).toBe("start");
    expect(decl(h(), "scroll-margin-top")).toBe(decl(rule(".anchor-target"), "scroll-margin-top"));
  });
});
