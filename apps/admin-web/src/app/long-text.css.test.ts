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

/**
 * The Engine view (/matching/engine, #2014) — final re-sweep NEW-01/NEW-02. Measured in Chrome
 * before: one 95-character token made the page 1209px wide at 375 and 1501px at 1280 on the worker
 * tab (picker trade label, skill label), 1396 / 1688 on the posting tab (the posting's role title,
 * customer-typed); and with ORDINARY data the page was 342px wide at 320, because a picker pill
 * (short ref + trade + date) could not shrink and every grid track sized itself to its content.
 *
 * The rule here is `break-word` plus a zero minimum, never `anywhere`: `anywhere` lowers an item's
 * min-content, which is what split "welding" mid-word in the grouped queue. With the tracks and the
 * pill bounded instead, an unbroken token breaks at the edge and a 33-character name of ordinary
 * words still wraps between words at every width (measured at 320-1280).
 */
describe("the Engine view is bounded by its stage at every width", () => {
  it("every grid on the stage has one column that never grows past its container", () => {
    // An implicit `auto` track is sized by its items' min-content — an unbroken token's whole
    // width — so the stage, a panel, the skill list and a skill row each declare their column.
    for (const selector of [".engine", ".engine__panel", ".engine__skills", ".engine__skill"]) {
      expect(topLevel(selector, "grid-template-columns"), selector).toBe("minmax(0, 1fr)");
    }
  });

  it("a posting title, a skill label and a picker trade label break an unbroken token", () => {
    for (const selector of [
      ".engine__panel-title",
      ".engine__skill-label",
      ".engine__pick-trade",
    ]) {
      expect(topLevel(selector, "overflow-wrap"), selector).toBe("break-word");
    }
  });

  it("a picker pill shrinks to its row and wraps its own parts instead of widening the page", () => {
    // The list item is a flex item (its automatic minimum is its content), the pill is an inline
    // flex box (as wide as its content), and the trade label is a flex item inside it: each one
    // is allowed below its content width, and the pill wraps the date under the ref on a phone.
    expect(topLevel(".engine__picker > li", "min-width")).toBe("0");
    expect(topLevel(".engine__pick", "max-inline-size")).toBe("100%");
    expect(topLevel(".engine__pick", "flex-wrap")).toBe("wrap");
    expect(topLevel(".engine__pick-trade", "min-width")).toBe("0");
  });

  it("on a phone the panels step their padding down with the stage, so a word still fits its card", () => {
    // Bounded at 320, a feed card's title got 118px — under the 127px "Maintenance" needs at the
    // card's 20px bold, so a 33-character role title split mid-word. 16px panel padding (the
    // stage's own phone step) gives it 134px (measured).
    const phone = rules(CSS, true).filter(
      (r) => r.selector === ".engine__panel" && r.atRules.join() === "@media (max-width: 767px)",
    );
    expect(phone.map((r) => decl(r.body, "padding"))).toEqual(["var(--space-4)"]);
  });

  it("never uses `anywhere` on the stage — it would split ordinary words mid-word", () => {
    const anywhere = TOP.filter(
      (r) =>
        r.selector.split(",").some((part) => part.trim().startsWith(".engine")) &&
        decl(r.body, "overflow-wrap") === "anywhere" &&
        // The feed card's title predates this fence: it sits in a `minmax(0, 1fr)` column of
        // its own grid, so `anywhere` there cannot shrink it below its words.
        r.selector !== ".engine-card__title",
    );
    expect(anywhere.map((r) => r.selector)).toEqual([]);
  });
});
