import { describe, expect, it } from "vitest";
import { decl, globalsCss, rules } from "../../test/css-rules";

/**
 * A long unbroken name must wrap where it sits, never scroll the page sideways (final sweep
 * AW-01). A role title, an organisation name or a discovered phrase is typed by a customer or
 * pulled from a corpus, and one 95-character token with no space in it made the page body
 * 1445px wide at 1280 and 803px at 375 (company, agency, posting, worker, skill and the grouped
 * queue, measured in Chrome): the title block's automatic minimum is its min-content width, and
 * an unbroken token's min-content is the whole token.
 *
 * The node env has no layout engine, so these pin the DECLARED rules; the outcome (no sideways
 * scroll from 320 to 1280, and a medium title still pushing the actions under it rather than
 * splitting) was measured in Chrome when they were written.
 */
const CSS = globalsCss();
const TOP = rules(CSS);

/** The last top-level (every-width) declaration of `prop` on a rule whose selector list holds `selector`. */
function topLevel(selector: string, prop: string): string | null {
  let value: string | null = null;
  for (const r of TOP) {
    if (r.selector.split(",").some((part) => part.trim() === selector)) {
      value = decl(r.body, prop) ?? value;
    }
  }
  return value;
}

describe("the page title block is bounded by its row", () => {
  it("never grows past the header row: its automatic minimum is clamped to 100%", () => {
    // Flexbox clamps an item's content-based minimum by a definite max size. So a token wider
    // than the row stops at the row (and wraps inside it), while a title that fits keeps its
    // whole width as the floor and still pushes the actions onto the next line.
    expect(topLevel(".page__heading", "max-inline-size")).toBe("100%");
  });

  it("keeps the content-based minimum — no zeroed min size (the title would run under the actions)", () => {
    for (const prop of ["min-width", "min-inline-size"]) {
      expect(topLevel(".page__heading", prop), prop).toBeNull();
    }
  });

  it("the title and its description break an unbroken token at every width, not only on a phone", () => {
    // `break-word`, not `anywhere`: `anywhere` lowers the min-content size, so a medium title
    // would split mid-word beside the actions instead of moving them under it.
    for (const selector of [".page__title", ".page__sub"]) {
      expect(topLevel(selector, "overflow-wrap"), selector).toBe("break-word");
    }
  });
});

describe("a long label inside a flex row or a chip list wraps inside its own box", () => {
  it("a batch label in the grouped queue wraps inside its summary row", () => {
    // `anywhere`, because only it lowers a flex item's min-content. On the summary's ONE text
    // run (label + counts), not on the label alone: as separate flex items, the flex algorithm
    // shrank a short label by its share of the overflow and split "welding" mid-word.
    expect(topLevel(".reviewgroup__title", "overflow-wrap")).toBe("anywhere");
    expect(topLevel(".reviewgroup > summary > strong", "overflow-wrap")).toBeNull();
  });

  it("a chip (a skill's source phrase, a capability) wraps instead of widening its list", () => {
    expect(topLevel(".chip", "overflow-wrap")).toBe("anywhere");
  });
});
