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

describe("desktop: the rail sticks BELOW the header, capped to the viewport, actions pinned", () => {
  it("the offset is built from the header's own token and clears it (≥ header + hairline)", () => {
    expect(decl(g(".pshell__header"), "min-height")).toBe("var(--shell-header-h)");
    const top = decl(g(".posting-layout"), "--posting-rail-top")!;
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

  it("the card + facts scroll inside the rail only when they must; the actions are a pinned footer", () => {
    const scroll = g(".posting-preview__scroll", DESKTOP);
    expect(decl(scroll, "overflow-y")).toBe("auto");
    expect(decl(scroll, "min-height")).toBe("0");
    expect(decl(scroll, "flex")).toBe("0 1 auto");
    expect(decl(g(".posting-preview__foot", DESKTOP), "flex")).toBe("none");
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

  it("a company editor may run into the shell's bottom padding — by exactly that padding", () => {
    const padding = decl(g(".pshell__content"), "padding")!.split(/\s+/);
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
    ).toBe(bottom);
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
  });

  it("the dock's controls clear the tap floor; a focused field lands clear of header and dock", () => {
    expect(decl(g(".posting-dock__summary"), "min-height")).toBe("var(--control-md)");
    const fields = g(".posting-layout--editor :is(input, select, textarea)");
    expect(decl(fields, "scroll-margin-top")).toBe("var(--posting-rail-top)");
    expect(decl(fields, "scroll-margin-bottom")).toBe(
      "calc(var(--posting-dock-h) + var(--space-4))",
    );
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
      ".agency-job__editform",
      ".agency-job",
      ".agency-job__actions",
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

  it("an agency vacancy's edit form spans its row and reads left to right", () => {
    expect(decl(g(".agency-job__actions:has(> .agency-job__editform)"), "flex")).toBe("1 1 100%");
    expect(decl(g(".agency-job__editform"), "text-align")).toBe("start");
    expect(decl(g(".agency-job__editform"), "justify-self")).toBe("stretch");
  });
});
