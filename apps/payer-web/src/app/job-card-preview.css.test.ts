import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { decl, parseRules, stripComments, tokenValue } from "../../test/css-rules";
import type { Rule } from "../../test/css-rules";
import { JOB_CARD_CLAMPS, REFERENCE_PHONE } from "../lib/job-card-view";

/**
 * JOB-CARD PREVIEW — LAYOUT + PHONE-PARITY FENCE (source level; the env is node, no layout engine).
 *
 * What was measured in Chromium (see the PR) depends on DECLARED geometry, so this pins it:
 *   · THE CARD IS THE PHONE'S — width 332dp and the clip at 386dp (REFERENCE_PHONE), the phone's
 *     type sizes × one unit, the phone's line clamps (JOB_CARD_CLAMPS), and nothing can overflow it.
 *   · THE RAIL STICKS BELOW THE HEADER — its offset is built from the header's own token (it was
 *     `--space-5` = 20px under a 61px header: the title hid under it at ~80% of scroll positions),
 *     it is capped to the viewport, and the actions are a pinned footer.
 *   · PHONES GET THE DOCK — the rail is not drawn above the form; a sticky dock is, and the desktop
 *     rule that hides the dock comes AFTER its base rule (it once didn't, and the dock showed).
 *   · NOTHING CLIPS THE STICKY — the agency panel clips with `overflow: clip`, not `hidden`.
 */

const here = dirname(fileURLToPath(import.meta.url));
const read = (...p: string[]) => stripComments(readFileSync(join(here, ...p), "utf8"));
const G = parseRules(read("globals.css"));
const D = parseRules(read("..", "styles", "ds-components.css"));
const TOKENS = read("..", "..", "..", "..", "packages", "design-tokens", "tokens.css");

const DESKTOP = "min-width: 1024px";
const PHONE = "max-width: 1023px";

function indexOf(rules: Rule[], selector: string, at = ""): number {
  const norm = (s: string) => s.replace(/,\s*/g, ",");
  const hits = rules
    .map((r, i) => ({ r, i }))
    .filter(
      ({ r }) =>
        norm(r.selector) === norm(selector) && (at === "" ? r.at === "" : r.at.includes(at)),
    );
  expect(hits, `exactly one rule for \`${selector}\`${at ? ` in ${at}` : ""}`).toHaveLength(1);
  return hits[0]!.i;
}
const g = (selector: string, at = "") => G[indexOf(G, selector, at)]!;
const d = (selector: string, at = "") => D[indexOf(D, selector, at)]!;

/** Resolve a token / px / rem / `calc(a + b + …)` expression to px (16px root). */
function px(expr: string): number {
  const e = expr.trim();
  const v = /^var\((--[\w-]+)\)$/.exec(e);
  if (v) {
    const value = tokenValue(TOKENS, v[1]!);
    expect(value, `token ${v[1]}`).not.toBeNull();
    return px(value!.replace(/\/\*[\s\S]*?\*\//g, ""));
  }
  const lit = /^(-?[\d.]+)px$/.exec(e);
  if (lit) return Number(lit[1]);
  const rem = /^(-?[\d.]+)rem$/.exec(e);
  if (rem) return Number(rem[1]) * 16;
  const calc = /^calc\(([\s\S]+)\)$/.exec(e);
  if (calc) return calc[1]!.split(" + ").reduce((sum, term) => sum + px(term), 0);
  throw new Error(`cannot resolve ${e}`);
}

/** `calc(N * var(--jcp-u))` — the phone's own dp number N. */
const dp = (n: number) => `calc(${n} * var(--jcp-u))`;

describe("the card is the reference phone's card", () => {
  it("one unit drives every size: 1dp at scale 1", () => {
    const root = d(".jcp");
    expect(decl(root, "--jcp-scale")).toBe("1");
    expect(decl(root, "--jcp-u")).toBe("calc(var(--jcp-scale) * 0.0625rem)");
  });

  it("is 332dp wide (never wider than its column) and clips at 386dp — the measured phone", () => {
    expect(REFERENCE_PHONE).toEqual({
      widthDp: 360,
      heightDp: 800,
      cardWidthDp: 332,
      contentHeightDp: 386,
    });
    expect(decl(d(".jcp__card"), "width")).toBe(`min(100%, ${dp(REFERENCE_PHONE.cardWidthDp)})`);
    const content = d(".jcp__content");
    expect(decl(content, "max-height")).toBe(dp(REFERENCE_PHONE.contentHeightDp));
    expect(decl(content, "overflow")).toBe("hidden");
    expect(decl(d(".jcp__foldline"), "top")).toBe(dp(REFERENCE_PHONE.contentHeightDp));
    // Showing all lifts the clip.
    expect(decl(d(".jcp:has(.jcp__fold[open]) .jcp__content"), "max-height")).toBe("none");
  });

  it("uses the phone's type sizes (design1_job_card.dart) × the unit", () => {
    const sizes: Array<[string, number]> = [
      [".jcp__title", 17],
      [".jcp__place", 13],
      [".jcp__salary-label", 11],
      [".jcp__paytype", 10],
      [".jcp__salary-band", 20],
      [".jcp__duty-label", 12],
      [".jcp__chip-text", 12],
    ];
    for (const [selector, n] of sizes) expect(decl(d(selector), "font-size"), selector).toBe(dp(n));
    expect(decl(d(".jcp__titlerow"), "min-height")).toBe(dp(48));
  });

  it("clamps exactly where the phone clamps (JOB_CARD_CLAMPS)", () => {
    for (const [selector, lines] of [
      [".jcp__title", JOB_CARD_CLAMPS.title],
      [".jcp__chip-text", JOB_CARD_CLAMPS.chip],
    ] as const) {
      const r = d(selector);
      expect(decl(r, "-webkit-line-clamp"), selector).toBe(String(lines));
      expect(decl(r, "line-clamp"), selector).toBe(String(lines));
      expect(decl(r, "display"), selector).toBe("-webkit-box");
      expect(decl(r, "overflow"), selector).toBe("hidden");
    }
    // One-line slots: no wrap, an ellipsis.
    expect(JOB_CARD_CLAMPS.place).toBe(1);
    expect(JOB_CARD_CLAMPS.pay_band).toBe(1);
    expect(JOB_CARD_CLAMPS.pay_label).toBe(1);
    for (const selector of [".jcp__place-text", ".jcp__salary-band", ".jcp__salary-label"]) {
      const r = d(selector);
      expect(decl(r, "white-space"), selector).toBe("nowrap");
      expect(decl(r, "text-overflow"), selector).toBe("ellipsis");
      expect(decl(r, "overflow"), selector).toBe("hidden");
      expect(decl(r, "min-width"), selector).toBe("0");
    }
  });

  it("nothing can push the card sideways: long words break, flex children may shrink", () => {
    for (const selector of [
      ".jcp__title",
      ".jcp__chip-text",
      ".jcp__salary-issue",
      ".jcp__fold-summary",
    ]) {
      expect(decl(d(selector), "overflow-wrap"), selector).toBe("anywhere");
    }
    for (const selector of [
      ".jcp__title",
      ".jcp__chip",
      ".jcp__chip-text",
      ".jcp__place",
      ".jcp__salary-top",
    ]) {
      expect(decl(d(selector), "min-width"), selector).toBe("0");
    }
    expect(decl(d(".jcp__chip"), "max-width")).toBe("100%");
  });

  it("the fold control is hidden until the browser has counted a cut", () => {
    expect(decl(d('.jcp__fold:not([data-cut]), .jcp__fold[data-cut="0"]'), "display")).toBe("none");
  });
});

/** The ONE rule that declares custom property `name` (several `:root` blocks exist). */
function declaring(name: string): Rule {
  const hits = G.filter((r) => decl(r, name) !== null);
  expect(hits, `exactly one rule declares ${name}`).toHaveLength(1);
  return hits[0]!;
}

describe("desktop: the rail sticks BELOW the header, capped to the viewport, actions pinned", () => {
  it("the offset is built from the header's own token and clears it (≥ header + hairline)", () => {
    expect(decl(g(".pshell__header"), "min-height")).toBe("var(--shell-header-h)");
    const root = declaring("--posting-rail-top");
    expect(root.selector).toBe(":root"); // shared: the agency hosts scroll to the same line
    const top = decl(root, "--posting-rail-top")!;
    expect(top).toBe("calc(var(--shell-header-h) + var(--border-hairline) + var(--space-4))");
    expect(px(top)).toBeGreaterThanOrEqual(
      px("var(--shell-header-h)") + px("var(--border-hairline)"),
    );
    const rail = g(".posting-preview", DESKTOP);
    expect(decl(rail, "position")).toBe("sticky");
    expect(decl(rail, "top")).toBe("var(--posting-rail-top)");
    // Capped to the viewport (the dvh line is the last, winning declaration).
    expect(decl(rail, "max-height")).toBe(
      "calc(100dvh - var(--posting-rail-top) - var(--space-4))",
    );
    expect(decl(rail, "display")).toBe("flex");
    expect(decl(rail, "flex-direction")).toBe("column");
  });

  it("an agency editor's rail leaves room for its host card's padding (it starts one padding low)", () => {
    const agency = g(
      ".agency-jobs__createcard .posting-preview, .agency-job--editing .posting-preview",
      DESKTOP,
    );
    expect(decl(agency, "max-height")).toBe(
      "calc(100dvh - var(--posting-rail-top) - var(--space-4) - var(--space-5))",
    );
    // …and the host lands on the sticky line when the editor opens (revealEditor).
    expect(decl(g(".agency-jobs__createcard, .agency-job--editing"), "scroll-margin-top")).toBe(
      "var(--posting-rail-top)",
    );
  });

  it("the card + facts scroll inside the rail only when they must; the actions are a pinned footer", () => {
    const scroll = g(".posting-preview__scroll", DESKTOP);
    expect(decl(scroll, "overflow-y")).toBe("auto");
    expect(decl(scroll, "min-height")).toBe("0");
    expect(decl(scroll, "flex")).toBe("0 1 auto");
    expect(decl(g(".posting-preview__foot", DESKTOP), "flex")).toBe("none");
  });

  it("while the region overflows, a 'More below' bar sits on its bottom edge (zero height, no shift)", () => {
    const cue = g(".posting-preview__more");
    expect(decl(cue, "display")).toBe("none");
    expect(decl(cue, "position")).toBe("sticky");
    expect(decl(cue, "bottom")).toBe("0");
    expect(decl(cue, "height")).toBe("0");
    expect(
      decl(g('.posting-preview__scroll[data-more="true"] > .posting-preview__more'), "display"),
    ).toBe("block");
  });

  it("the form keeps its measure and the rail sits right beside it (no dead gap at 1920)", () => {
    expect(decl(g(".posting-layout"), "--posting-rail-w")).toBe("24rem");
    const editor = g(".posting-layout--editor", DESKTOP);
    expect(decl(editor, "grid-template-columns")).toBe(
      "minmax(0, var(--reading-max)) var(--posting-rail-w)",
    );
    expect(decl(editor, "justify-content")).toBe("start");
  });

  it("the card is drawn at 1.0–1.2× the phone on desktop (readable, wrap points kept)", () => {
    const scale = Number(decl(g(".posting-preview .jcp", DESKTOP), "--jcp-scale"));
    expect(scale).toBeGreaterThan(1);
    expect(scale).toBeLessThanOrEqual(1.2);
  });

  it("the desktop pay-type pill is floored at the 12px text token (the phone sheet keeps 10dp)", () => {
    expect(decl(g(".posting-preview .jcp__paytype", DESKTOP), "font-size")).toBe(
      "max(var(--text-xs), calc(10 * var(--jcp-u)))",
    );
    expect(px("var(--text-xs)")).toBeGreaterThanOrEqual(12);
    expect(decl(d(".jcp__paytype"), "font-size")).toBe(dp(10));
  });

  it("END-ROOM: the form column runs ~half a viewport past its last field (Chrome centres focus)", () => {
    expect(
      decl(g(".posting-layout--editor > .posting-layout__main", DESKTOP), "padding-bottom"),
    ).toBe("calc(50vh - var(--space-7))");
    // No bottom scroll-margin on the fields: on desktop it parked the last field 128px up and
    // pushed the rail past its grid row (agency forms: the title under the header, 8/21 stops).
    expect(
      decl(g(".posting-layout--editor :is(input, select, textarea)"), "scroll-margin-bottom"),
    ).toBeNull();
  });

  it("a company editor may run into the shell's bottom padding — by exactly that padding", () => {
    const padding = (decl(g(".pshell__content"), "padding") ?? "").split(" ");
    const bottom = padding[2]!;
    expect(bottom).toBe("var(--space-10)");
    expect(
      decl(g(".pshell__content > .posting-layout--editor:last-child", DESKTOP), "margin-bottom"),
    ).toBe(`calc(-1 * ${bottom})`);
    expect(
      decl(
        g(".pshell__content > .posting-layout--editor:last-child > .posting-layout__main", DESKTOP),
        "padding-bottom",
      ),
    ).toBe(`calc(50vh - var(--space-7) + ${bottom})`);
  });

  it("the breakpoints are the shell's own desktop line (rail ≥1024px, dock below)", () => {
    expect(
      G.some((r) => r.at.includes("max-width: 1023px") && r.selector.startsWith(".pshell")),
    ).toBe(true);
    expect(decl(g(".posting-dock, .posting-layout__end", DESKTOP), "display")).toBe("none");
    // ORDER: the desktop hide must come AFTER the dock's base rule (same specificity).
    expect(indexOf(G, ".posting-dock, .posting-layout__end", DESKTOP)).toBeGreaterThan(
      indexOf(G, ".posting-dock"),
    );
    expect(decl(g(".posting-dock"), "display")).toBe("flex");
  });
});

describe("phones: no rail above the form — a sticky dock and a sheet", () => {
  it("the editor's rail is not drawn; the dock sticks to the bottom of the form's cell", () => {
    expect(decl(g(".posting-layout--editor > .posting-preview", PHONE), "display")).toBe("none");
    const dock = g(".posting-dock", PHONE);
    expect(decl(dock, "position")).toBe("sticky");
    expect(decl(dock, "bottom")).toBe("var(--space-2)");
    expect(decl(dock, "grid-row")).toBe("1");
    expect(decl(dock, "align-self")).toBe("end");
    const main = g(".posting-layout--editor > .posting-layout__main", PHONE);
    expect(decl(main, "grid-row")).toBe("1");
    expect(decl(main, "padding-bottom")).toBe("calc(var(--posting-dock-h) + var(--space-4))");
    expect(declaring("--posting-dock-h").selector).toBe(":root");
  });

  it("the room kept for the dock is its MEASURED height + its bottom offset, never below 7rem", () => {
    // Two status lines after a refused save made the dock 153–168px against a fixed 7rem (fields
    // sat up to 24px under it). lib/dock-reserve.ts publishes the real height on the root.
    expect(decl(declaring("--posting-dock-h"), "--posting-dock-h")).toBe(
      "max(7rem, calc(var(--posting-dock-measured, 0) * 1px + var(--space-2)))",
    );
    // …and the offset it adds is the dock's own sticky bottom.
    expect(decl(g(".posting-dock", PHONE), "bottom")).toBe("var(--space-2)");
  });

  it("focus scrolling keeps a field clear of the header and of the dock (the root reserves its room)", () => {
    expect(decl(g(".posting-dock__summary"), "min-height")).toBe("var(--control-md)");
    const fields = g(".posting-layout--editor :is(input, select, textarea)");
    expect(decl(fields, "scroll-margin-top")).toBe("var(--posting-rail-top)");
    expect(decl(g("html:has(.posting-dock)", PHONE), "scroll-padding-bottom")).toBe(
      "calc(var(--posting-dock-h) + var(--space-8))",
    );
    // Phone-only: on desktop the dock exists (hidden) and must not reserve anything.
    expect(G.filter((r) => r.selector === "html:has(.posting-dock)").map((r) => r.at)).toEqual([
      "@media (max-width: 1023px)",
    ]);
  });

  it("the dock is ONE unwrapped row whose primary shrinks and wraps its label (no sideways scroll)", () => {
    expect(decl(g(".posting-dock"), "flex-direction")).toBe("column");
    expect(decl(g(".posting-dock__row"), "flex-wrap")).toBe("nowrap");
    expect(decl(g(".posting-dock__summary"), "flex")).toBe("1 1 0");
    const primary = g(".posting-dock__primary");
    expect(decl(primary, "flex")).toBe("0 1 auto");
    expect(decl(primary, "min-width")).toBe("0");
    const label = g(".posting-dock__primary .bb-btn, .posting-actions__buttons .bb-btn");
    expect(decl(label, "white-space")).toBe("normal");
    expect(decl(label, "max-width")).toBe("100%");
    expect(decl(label, "height")).toBe("auto");
    // In the dock the zero-reach detail is visually hidden (it stays in the accessible name).
    expect(decl(g(".posting-dock .posting-cta__detail"), "clip")).toBe("rect(0, 0, 0, 0)");
  });

  it("a detail page's card still leads on a phone (only the EDITOR's rail is replaced)", () => {
    expect(decl(g(".posting-preview"), "order")).toBe("-1");
  });
});

describe("nothing between the rail and the page turns the sticky off", () => {
  it("the agency panel clips with `overflow: clip` (no scroll container) and keeps its BFC", () => {
    expect(decl(g(".panel"), "overflow")).toBe("hidden"); // every other panel unchanged
    const panel = g(".panel:has(.posting-layout)");
    expect(decl(panel, "overflow")).toBe("clip");
    expect(decl(panel, "display")).toBe("flow-root");
  });

  it("no wrapper of the editor declares a scrolling/hidden overflow", () => {
    const wrappers = [
      ".posting-layout",
      ".posting-layout__main",
      ".posting-layout--editor",
      ".agency-job-form",
      ".agency-jobs__createcard",
      ".agency-job",
      ".agency-job--editing",
      ".agency-job__lead",
    ];
    for (const r of G) {
      if (!wrappers.includes(r.selector)) continue;
      for (const prop of ["overflow", "overflow-x", "overflow-y"]) {
        expect(["hidden", "auto", "scroll"], `${r.selector} ${prop}`).not.toContain(decl(r, prop));
      }
      expect(decl(r, "transform"), `${r.selector} transform`).toBeNull();
      expect(decl(r, "contain"), `${r.selector} contain`).toBeNull();
    }
  });

  it("an agency vacancy being edited IS the editor: block row, header leading the form column", () => {
    expect(decl(g(".agency-job--editing"), "display")).toBe("block");
    expect(decl(g(".agency-job__lead"), "display")).toBe("flex");
  });

  it("a long unbroken chip wraps inside its pill (it widened the page by up to 698px)", () => {
    expect(decl(g(".chip-editor__chips .bb-chip"), "max-width")).toBe("100%");
    expect(decl(g(".chip-editor__chips .bb-chip > span"), "min-width")).toBe("0");
    expect(decl(g(".chip-editor__text"), "overflow-wrap")).toBe("anywhere");
  });
});

describe("M3 — the outcome's live region is always in the page (announced, and only once)", () => {
  const LIVE = [".posting-actions__live", ".posting-dock__live"];

  it("no rule ever hides a live slot (a region must exist BEFORE its text lands to be announced)", () => {
    const hiding = G.filter((r) => LIVE.some((sel) => r.selector.includes(sel))).filter(
      (r) => decl(r, "display") === "none" || decl(r, "visibility") === "hidden",
    );
    expect(hiding.map((r) => `${r.at} ${r.selector}`.trim())).toEqual([]);
  });

  it("the slots are spaced by their own margin, not the container's gap (an empty item takes a gap)", () => {
    expect(decl(g(".posting-actions"), "gap")).toBeNull();
    expect(decl(g(".posting-dock"), "gap")).toBeNull();
    expect(decl(g(".posting-actions__status, .posting-actions__live:not(:empty)"), "margin-block-end")).toBe(
      "var(--space-2)",
    );
    expect(decl(g(".posting-dock__status, .posting-dock__live:not(:empty)"), "margin-block-end")).toBe(
      "var(--space-1)",
    );
    // The field-owned status is NOT live, so it may collapse when empty.
    expect(decl(g(".posting-dock__status:empty"), "display")).toBe("none");
    expect(decl(g(".posting-actions__status:empty"), "display")).toBe("none");
  });

  it("an outcome in the dock is clamped like the status (two lines above the button)", () => {
    const clamp = g(".posting-dock__status .posting-actions__msg, .posting-dock__live .posting-actions__msg");
    expect(decl(clamp, "-webkit-line-clamp")).toBe("2");
  });
});

describe("CR-L1 — a removable chip's remove is a real, sized, named button", () => {
  const TOUCH = "max-width: 600px), (pointer: coarse";

  it("draws a 24px round target, positioned (it anchors the tooltip and the hit area)", () => {
    const btn = d(".bb-chip__remove");
    expect(decl(btn, "width")).toBe("var(--space-6)");
    expect(decl(btn, "height")).toBe("var(--space-6)");
    expect(px("var(--space-6)")).toBeGreaterThanOrEqual(24); // WCAG 2.5.8 minimum
    expect(decl(btn, "position")).toBe("relative");
    expect(decl(btn, "border-radius")).toBe("var(--radius-round)");
    // A secondary icon at rest — the 60% step-down token, never an opacity (that would dim the
    // tooltip and the focus ring with it).
    expect(decl(btn, "color")).toBe("var(--icon-secondary)");
    expect(decl(btn, "opacity")).toBeNull();
  });

  it("clears a 44px hit area on a phone or coarse pointer (the drawn size stays)", () => {
    const hit = d(".bb-chip__remove::before", TOUCH);
    expect(decl(hit, "position")).toBe("absolute");
    expect(decl(hit, "inset")).toBe("calc((100% - var(--control-md)) / 2)");
    expect(px("var(--control-md)")).toBeGreaterThanOrEqual(44);
  });

  it("shows the focus ring on keyboard focus", () => {
    expect(decl(d(".bb-chip__remove:focus-visible"), "box-shadow")).toBe("var(--ring-focus)");
  });

  it("its tooltip (the item's name) wraps inside a box no wider than 20rem, the page or the ROW", () => {
    const tip = d(".bb-chip__remove > .bb-icon-tip");
    // An absolutely positioned tip inside a 24px button would shrink to one word per line: its
    // width is its content's, capped (the shared tip is `nowrap` — this one may wrap).
    expect(decl(tip, "white-space")).toBe("normal");
    expect(decl(tip, "width")).toBe("max-content");
    expect(decl(tip, "max-width")).toBe("min(20rem, 100cqi, calc(100vw - 2 * var(--space-4)))");
    // …and it slides right by the overrun chip-tip.ts measures (0 until measured).
    expect(decl(tip, "translate")).toBe("calc(var(--bb-tip-shift, 0) * 1px) 0");
    // The row is the container its `100cqi` reads.
    expect(decl(g(".chip-editor__chips"), "container-type")).toBe("inline-size");
  });

  it("a removable chip is static content: no pointer, and hover/press belong to BUTTON chips only", () => {
    expect(decl(d(".bb-chip--removable"), "cursor")).toBe("default");
    expect(D.filter((r) => r.selector === ".bb-chip:hover" || r.selector === ".bb-chip:active")).toEqual([]);
    expect(decl(d(".bb-chip:where(button):hover"), "background")).toBe("var(--surface-sunken)");
    expect(decl(d(".bb-chip:where(button):active"), "transform")).toBe("scale(0.97)");
  });
});

describe("L4/L5 — focusing the sticky dock never scrolls the page", () => {
  it("the dock's buttons cancel the page's bottom scroll padding EXACTLY (it moved the page ~435px)", () => {
    const pad = decl(g("html:has(.posting-dock)", PHONE), "scroll-padding-bottom")!;
    const margin = decl(g(".posting-dock button", PHONE), "scroll-margin-bottom")!;
    const inner = /^calc\((.+)\)$/.exec(pad)![1]!;
    expect(margin).toBe(`calc(-1 * (${inner}))`);
  });
});

describe("an agency row's header keeps a readable measure while it leads the editor", () => {
  it("the header text has a 24rem basis in the lead, so the buttons wrap under it (not crush it)", () => {
    expect(decl(g(".agency-job__lead"), "flex-wrap")).toBe("wrap");
    expect(decl(g(".agency-job__lead > .agency-job__main"), "flex")).toBe("1 1 24rem");
    // The plain row keeps its zero-basis text (full-width row: the buttons always fit beside it).
    expect(decl(g(".agency-job__main"), "flex")).toBe("1");
  });
});

describe("the rail's More-below fade ends in the colour of what the rail sits on", () => {
  it("the page by default, the card when an agency editor's card hosts the rail", () => {
    expect(decl(g(".posting-preview"), "--posting-cue-bg")).toBe("var(--surface-page)");
    expect(decl(g(":is(.bb-card, .panel) .posting-preview"), "--posting-cue-bg")).toBe(
      "var(--surface-card)",
    );
    expect(decl(g(".posting-preview__more > span"), "background")).toBe(
      "linear-gradient(transparent, var(--posting-cue-bg) 55%)",
    );
  });
});

describe("a NARROW phone dock stacks its summary over its button", () => {
  const NARROW = "@container posting-dock (width < 17rem)";
  const c = (selector: string) => {
    const hits = G.filter((r) => r.selector === selector && r.at === NARROW);
    expect(hits, `${selector} in ${NARROW}`).toHaveLength(1);
    return hits[0]!;
  };

  it("the dock is the container its own width is read from", () => {
    expect(decl(g(".posting-dock"), "container")).toBe("posting-dock / inline-size");
  });

  it("below 17rem the row wraps: the summary takes the full width, the button a full row under it", () => {
    expect(decl(c(".posting-dock__row"), "flex-wrap")).toBe("wrap");
    expect(decl(c(".posting-dock__summary"), "flex-basis")).toBe("100%");
    expect(decl(c(".posting-dock__primary"), "flex")).toBe("1 1 100%");
    expect(decl(c(".posting-dock__primary"), "max-width")).toBe("none");
    expect(decl(c(".posting-dock__primary .bb-btn"), "width")).toBe("100%");
    // Measured dock content widths: agency 170 (320) / 225 (375), company 254 (320) stack; a
    // company dock from 375 (309) keeps its one row.
    expect(px("17rem")).toBeGreaterThan(254);
    expect(px("17rem")).toBeLessThan(309);
  });
});
