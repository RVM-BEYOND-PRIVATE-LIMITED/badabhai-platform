import { describe, expect, it } from "vitest";
import { decl, globalsCss, rules, type Rule } from "../../test/css-rules";

/**
 * Page height on a phone (owner requirement 21, final sweep AW-02/AW-07/AW-08): the first datum
 * of a screen was 495-2325px below the top of <main> at 375px, behind explanations, filter
 * panels and header buttons that stood between the operator and the list. The markup moves are
 * pinned in each page's render test; these pin the CSS they rely on. Each was measured in
 * Chrome at 320/375/1280 when written (px from <main> to the first datum, before → after, in
 * the PR).
 */
const CSS = globalsCss();
const ALL = rules(CSS, true);
const PHONE = "@media (max-width: 600px)";
const TOUCH = "@media (max-width: 600px), (pointer: coarse)";

const at = (selector: string, media: string): Rule | undefined =>
  ALL.find((r) => r.selector === selector && r.atRules.join() === media);
const top = (selector: string): Rule | undefined =>
  ALL.find((r) => r.selector === selector && r.atRules.length === 0);

describe("dashboard 'Needs attention' on a phone (AW-07)", () => {
  it("the message takes the whole row and the action drops under it", () => {
    // `flex: 1` (basis 0) left the text a 65px column beside a 140-173px button at 320.
    const text = at(".attention__text", PHONE);
    expect(text).toBeDefined();
    expect(decl(text!.body, "flex")).toBe("1 1 100%");
    const action = at(".attention__action", PHONE);
    expect(action).toBeDefined();
    expect(decl(action!.body, "align-self")).toBe("flex-start");
  });

  it("is declared after the base rule it overrides (equal specificity)", () => {
    const base = ALL.indexOf(top(".attention__text")!);
    expect(base).toBeGreaterThanOrEqual(0);
    expect(ALL.indexOf(at(".attention__text", PHONE)!)).toBeGreaterThan(base);
  });
});

describe("page header actions are compact on a phone (AW-08)", () => {
  it("a header button is drawn at the small control size at 600px and under", () => {
    const btn = at(".page__actions .btn", PHONE);
    expect(btn).toBeDefined();
    expect(decl(btn!.body, "min-height")).toBe("var(--control-sm)");
    expect(decl(btn!.body, "font-size")).toBe("var(--ui-body-sm-size)");
  });

  it("a select among them fills its row's remainder in the same face, instead of forcing a row", () => {
    const field = at(".page__actions .field", PHONE);
    expect(field).toBeDefined();
    expect(decl(field!.body, "flex")).toBe("1 1 8rem");
    expect(decl(field!.body, "min-inline-size")).toBe("0");
    const input = at(".page__actions .field__input", PHONE);
    expect(input).toBeDefined();
    expect(decl(input!.body, "font-size")).toBe("var(--ui-body-sm-size)");
    // Its HEIGHT stays the 44px control: a select cannot carry a hit-area strip.
    expect(decl(input!.body, "min-height")).toBeNull();
    expect(decl(input!.body, "height")).toBeNull();
  });

  it("…and keeps a 44px hit area on touch: the .btn--sm strip, behind its label", () => {
    const host = at(".page__actions .btn", TOUCH);
    expect(host).toBeDefined();
    expect(decl(host!.body, "position")).toBe("relative");
    expect(decl(host!.body, "isolation")).toBe("isolate");
    const strip = at(".page__actions .btn::before", TOUCH);
    expect(strip).toBeDefined();
    expect(decl(strip!.body, "content")).toBe('""');
    expect(decl(strip!.body, "inset-block")).toBe("calc((100% - var(--control-md)) / 2)");
    expect(decl(strip!.body, "z-index")).toBe("calc(var(--z-base) - 1)");
  });
});

describe("a filter panel folds behind one toggle on a phone (AW-08)", () => {
  it("the toggle is hidden at every width above the phone line — the panel is simply open there", () => {
    expect(decl(top(".filter-panel__toggle")!.body, "display")).toBe("none");
    expect(decl(at(".filter-panel__toggle", PHONE)!.body, "display")).toBe("inline-flex");
  });

  it("on a phone a closed panel shows only its toggle: no fields, no card around it", () => {
    const body = at('.filter-panel[data-open="false"] .filter-panel__body', PHONE);
    expect(body).toBeDefined();
    expect(decl(body!.body, "display")).toBe("none");
    const card = at('.filter-panel[data-open="false"]', PHONE);
    expect(card).toBeDefined();
    expect(decl(card!.body, "padding")).toBe("0");
    expect(decl(card!.body, "border")).toBe("0");
  });

  it("nothing outside the phone tier ever hides the fields", () => {
    const hides = ALL.filter(
      (r) =>
        r.selector.includes(".filter-panel__body") &&
        decl(r.body, "display") === "none" &&
        r.atRules.join() !== PHONE,
    );
    expect(hides.map((r) => r.selector)).toEqual([]);
  });
});

describe("a native disclosure (`.disclosure`, the discovery page's More filters) (AW-02)", () => {
  it("draws the brand caret, not the browser's triangle", () => {
    const summary = top(".disclosure > summary");
    expect(summary).toBeDefined();
    expect(decl(summary!.body, "list-style")).toBe("none");
    expect(decl(summary!.body, "display")).toBe("flex");
    expect(decl(top(".disclosure > summary::-webkit-details-marker")!.body, "display")).toBe(
      "none",
    );
  });

  it("its whole summary row is a 44px toggle on touch", () => {
    const summary = at(".disclosure > summary", TOUCH);
    expect(summary).toBeDefined();
    expect(decl(summary!.body, "min-block-size")).toBe("var(--control-md)");
  });
});
