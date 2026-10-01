import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TOOLTIP_DISMISSED_ATTRIBUTE } from "@badabhai/icons";
import { decl, parseRules, stripComments, type Rule } from "../../../test/css-rules";

/**
 * The icon system in the DS component layer (ds-components.css): button icons size from the
 * shared tokens per control size and inherit colour, and the IconButton's tooltip + hit area hold
 * the icon-only-control contract (@badabhai/icons `IconOnlyControlProps`). Declared rules only —
 * the layout itself was measured in Chromium when this was written.
 */
const here = dirname(fileURLToPath(import.meta.url));
const RULES = parseRules(
  stripComments(readFileSync(join(here, "..", "..", "styles", "ds-components.css"), "utf8")),
);
const TOUCH = "@media (max-width: 600px), (pointer: coarse)";

function find(selector: string, at = ""): Rule {
  const r = RULES.find((x) => x.selector === selector && x.at === at);
  expect(r, `${at} ${selector} must be declared`).toBeDefined();
  return r!;
}
const indexOf = (selector: string, at = "") =>
  RULES.findIndex((x) => x.selector === selector && x.at === at);

describe("button icons — one size per control size, centred, colour inherited", () => {
  it("sm / md / lg draw 16 / 20 / 24 from the shared tokens (not a ratio of the label)", () => {
    expect(decl(find(".bb-btn .ph-fill"), "font-size")).toBe("var(--icon-size-md)");
    expect(decl(find(".bb-btn--sm .ph-fill"), "font-size")).toBe("var(--icon-size-sm)");
    expect(decl(find(".bb-btn--lg .ph-fill"), "font-size")).toBe("var(--icon-size-lg)");
    // Same specificity as the md rule, so the size modifiers must come after it.
    expect(indexOf(".bb-btn--sm .ph-fill")).toBeGreaterThan(indexOf(".bb-btn .ph-fill"));
    expect(indexOf(".bb-btn--lg .ph-fill")).toBeGreaterThan(indexOf(".bb-btn .ph-fill"));
  });

  it("the icon sits on the label's centre line at the shared gap", () => {
    const btn = find(".bb-btn");
    expect(decl(btn, "display")).toBe("inline-flex");
    expect(decl(btn, "align-items")).toBe("center");
    expect(decl(btn, "gap")).toBe("var(--icon-gap)");
  });

  it("no rule colours an icon inside a button, so hover / active / disabled recolour it", () => {
    const coloured = RULES.filter(
      (r) => /\.bb-(btn|iconbtn)\b[^,{]*\.ph-fill/.test(r.selector) && decl(r, "color") !== null,
    );
    expect(coloured.map((r) => r.selector)).toEqual([]);
  });
});

describe("IconButton — brand colours", () => {
  it("rests in structural Shift Blue (--text-heading flips to paper on ink)", () => {
    expect(decl(find(".bb-iconbtn"), "color")).toBe("var(--text-heading)");
  });

  it("an active utility (pressed / expanded) takes the Safety Yellow fill with a navy glyph", () => {
    const active = find('.bb-iconbtn[aria-pressed="true"], .bb-iconbtn[aria-expanded="true"]');
    expect(decl(active, "background")).toBe("var(--brand)");
    expect(decl(active, "color")).toBe("var(--text-on-brand)");
  });

  it("disabled steps down to the 40% primary and beats the solid fill", () => {
    const disabled = find(".bb-iconbtn:disabled");
    expect(decl(disabled, "color")).toBe("var(--text-disabled)");
    expect(decl(disabled, "background")).toBe("transparent");
    expect(indexOf(".bb-iconbtn:disabled")).toBeGreaterThan(indexOf(".bb-iconbtn:hover"));
  });

  it("sizes its glyph from the shared tokens per control size", () => {
    expect(decl(find(".bb-iconbtn"), "font-size")).toBe("var(--icon-size-md)");
    expect(decl(find(".bb-iconbtn--sm"), "font-size")).toBe("var(--icon-size-sm)");
    expect(decl(find(".bb-iconbtn--lg"), "font-size")).toBe("var(--icon-size-lg)");
  });
});

describe("IconButton — the tooltip shows on hover AND keyboard focus, and Escape wins", () => {
  it("is hidden by default and catches no clicks while hidden", () => {
    const tip = find(".bb-iconbtn__tip");
    expect(decl(tip, "opacity")).toBe("0");
    expect(decl(tip, "visibility")).toBe("hidden");
    expect(decl(tip, "pointer-events")).toBe("none");
    expect(decl(tip, "z-index")).toBe("var(--z-tooltip)");
  });

  it("keyboard focus shows it at every width", () => {
    const focus = find(".bb-iconbtn:focus-visible .bb-iconbtn__tip");
    expect(decl(focus, "opacity")).toBe("1");
    expect(decl(focus, "visibility")).toBe("visible");
    expect(decl(focus, "pointer-events")).toBe("auto");
  });

  it("hover shows it only where hover exists (a tap must not leave a stuck bubble)", () => {
    expect(indexOf(".bb-iconbtn:hover .bb-iconbtn__tip")).toBe(-1);
    const hover = find(".bb-iconbtn:hover .bb-iconbtn__tip", "@media (hover: hover)");
    expect(decl(hover, "visibility")).toBe("visible");
    expect(decl(hover, "pointer-events")).toBe("auto");
  });

  it("the Escape rule keys on the shared attribute and comes after both triggers", () => {
    const sel = `.bb-iconbtn[${TOOLTIP_DISMISSED_ATTRIBUTE}] .bb-iconbtn__tip`;
    expect(decl(find(sel), "visibility")).toBe("hidden");
    expect(indexOf(sel)).toBeGreaterThan(indexOf(".bb-iconbtn:focus-visible .bb-iconbtn__tip"));
    expect(indexOf(sel)).toBeGreaterThan(
      indexOf(".bb-iconbtn:hover .bb-iconbtn__tip", "@media (hover: hover)"),
    );
  });

  it("every placement has a gap bridge so the pointer can move onto the tooltip", () => {
    for (const side of ["top", "bottom", "start", "end"]) {
      find(`.bb-iconbtn__tip--${side}`);
      find(`.bb-iconbtn__tip--${side}::before`);
    }
    expect(decl(find(".bb-iconbtn__tip::before"), "content")).toBe('""');
  });
});

describe("IconButton — 44px hit area on a phone or coarse pointer", () => {
  it("md is 44×44 and lg 52×52 at every width", () => {
    expect(decl(find(".bb-iconbtn"), "width")).toBe("var(--control-md)");
    expect(decl(find(".bb-iconbtn"), "height")).toBe("var(--control-md)");
    expect(decl(find(".bb-iconbtn--lg"), "width")).toBe("var(--control-lg)");
  });

  it("sm grows its HIT AREA to 44×44 under the touch query, not its drawn 36px", () => {
    expect(decl(find(".bb-iconbtn--sm"), "width")).toBe("var(--control-sm)");
    const strip = find(".bb-iconbtn--sm::before", TOUCH);
    expect(decl(strip, "position")).toBe("absolute");
    expect(decl(strip, "inset")).toBe("calc((100% - var(--control-md)) / 2)");
    expect(RULES.filter((r) => r.selector === ".bb-iconbtn--sm::before" && r.at !== TOUCH)).toEqual(
      [],
    );
    expect(decl(find(".bb-iconbtn"), "position")).toBe("relative");
  });
});

/**
 * CASCADE ORDER. Phosphor's `.ph-fill` base rule used to be appended from a CDN AFTER the app's
 * CSS, so on a tie (one class each, 0,1,0) it WON. It is now bundled FIRST, so on a tie the app's
 * rule wins. Any single-class rule on a class that sits on the glyph element itself and declares
 * one of Phosphor's base properties therefore changed behaviour with the move — `.alert__icon`
 * and `.attention__icon` declared `line-height: 1.35`, which had never rendered and would have
 * dropped those glyphs ~4px. This pins every such rule to what Phosphor itself sets.
 */
describe("cascade order — no app rule silently overrides Phosphor's glyph metrics", () => {
  const srcRoot = join(here, "..", "..");
  const tsx: string[] = [];
  (function walk(dir: string): void {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.name.endsWith(".tsx") && !ent.name.includes(".test.")) tsx.push(full);
    }
  })(srcRoot);

  /** Classes written on the SAME element as a glyph: raw `ph-fill ph-x …` and `<Icon className>`. */
  const glyphClasses = new Set<string>();
  for (const f of tsx) {
    const code = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const m of code.matchAll(/ph-fill ph-[a-z0-9-]*(?:\$\{[^}]*\})?([^"`]*)["`]/g))
      for (const c of m[1]!.split(/\s+/)) if (/^[a-z][\w-]*$/.test(c)) glyphClasses.add(c);
    for (const m of code.matchAll(/<Icon\b[^>]*className=["']([^"']+)["']/g))
      for (const c of m[1]!.split(/\s+/)) if (/^[a-z][\w-]*$/.test(c)) glyphClasses.add(c);
  }

  /** Phosphor's `.ph-fill` base declarations an app rule could tie with, and their values. */
  const PHOSPHOR_BASE: Readonly<Record<string, string>> = {
    "line-height": "1",
    "letter-spacing": "0",
    "font-style": "normal",
    "font-weight": "normal",
    "font-variant": "normal",
    "text-transform": "none",
  };

  const appRules = [
    ...parseRules(stripComments(readFileSync(join(srcRoot, "app", "globals.css"), "utf8"))),
    ...RULES,
  ];

  it("finds the glyph-bearing classes (so an empty pass means something)", () => {
    for (const c of ["alert__icon", "attention__icon", "pnav__icon", "bb-toast__icon"])
      expect(glyphClasses.has(c), c).toBe(true);
  });

  it("a single-class rule on a glyph element repeats Phosphor's value or leaves it alone", () => {
    const clashes: string[] = [];
    for (const r of appRules) {
      for (const part of r.selector.split(",").map((s) => s.trim())) {
        if (!part.startsWith(".") || part.slice(1).includes(".") || /[\s:[>+~#]/.test(part))
          continue;
        if (!glyphClasses.has(part.slice(1))) continue;
        for (const [prop, phosphor] of Object.entries(PHOSPHOR_BASE)) {
          const v = decl(r, prop);
          if (v !== null && v !== phosphor)
            clashes.push(`${r.at} ${part} { ${prop}: ${v} }`.trim());
        }
      }
    }
    expect(clashes).toEqual([]);
  });
});
