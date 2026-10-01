import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import ts from "typescript";
import { decl, parseRules, stripComments, type Rule } from "../../../test/css-rules";

/**
 * The icon system in the DS component layer (ds-components.css): button icons size from the
 * shared tokens per control size and inherit colour, and the IconButton SKIN holds its half of the
 * icon-only-control contract (brand colours, the ≥44px coarse-pointer hit area, a positioned
 * anchor). The tooltip itself is shared — `.bb-icon-tip`, tested in @badabhai/icons
 * (icons-css.test.ts). Declared rules only — the layout was measured in Chromium.
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
 *
 * WHAT IT READS. Every JSX element in the shipped .tsx sources, parsed with the TypeScript
 * compiler (not a regex, so `onClick={() => …}` before `className` cannot end a tag early). A
 * GLYPH element is `<Icon …>` or any element whose className contains the `ph-fill` token. Its
 * classes are every static token of its className — before or after `ph-fill`, in a plain string,
 * a template (a `ph-${…}` interpolation is a glyph NAME and is skipped), a conditional, or an
 * array joined into a string.
 *
 * WHAT IT CANNOT SEE, and therefore REFUSES: a glyph element whose className is a variable, a
 * call, or anything else that is not literal text, and a glyph element with a `{...spread}`.
 * Those fail the "readable" check below, so the guard never passes on classes it did not read.
 * (Out of reach entirely: classes added at runtime through the DOM, and elements built without
 * JSX — neither pattern exists in this app.)
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

  /** Static text pieces of a className expression, or null where some part is not literal. */
  function staticPieces(expr: ts.Expression): string[] | null {
    if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return [expr.text];
    if (ts.isParenthesizedExpression(expr)) return staticPieces(expr.expression);
    if (ts.isTemplateExpression(expr)) {
      const out = [expr.head.text];
      let prev = expr.head.text;
      for (const span of expr.templateSpans) {
        // `ph-${…}` / `ph-caret-${…}` interpolate a GLYPH NAME, not a class: skipped.
        const nameSlot = /(^|\s)ph-[a-z0-9-]*$/.test(prev);
        const inner = nameSlot ? [] : staticPieces(span.expression);
        if (inner === null) return null;
        out.push(...inner, span.literal.text);
        prev = span.literal.text;
      }
      return out;
    }
    if (ts.isConditionalExpression(expr)) {
      const a = staticPieces(expr.whenTrue);
      const b = staticPieces(expr.whenFalse);
      return a && b ? [...a, ...b] : null;
    }
    if (ts.isArrayLiteralExpression(expr)) {
      const out: string[] = [];
      for (const e of expr.elements) {
        const p = staticPieces(e);
        if (p === null) return null;
        out.push(...p);
      }
      return out;
    }
    // `[…].join(" ")` / `[…].filter(Boolean).join(" ")`
    if (ts.isCallExpression(expr) && ts.isPropertyAccessExpression(expr.expression)) {
      const method = expr.expression.name.text;
      if (method === "join" || method === "filter") return staticPieces(expr.expression.expression);
    }
    if (expr.kind === ts.SyntaxKind.FalseKeyword || expr.kind === ts.SyntaxKind.NullKeyword) {
      return [];
    }
    return null;
  }

  /** Whole class tokens (a token cut by an interpolation, `ph-` / `ph-caret-`, is dropped). */
  const tokens = (pieces: string[]) =>
    pieces.flatMap((p) => p.split(/\s+/)).filter((t) => /^[a-z][\w-]*[a-z0-9]$/i.test(t));

  const glyphClasses = new Set<string>(["ph-fill"]);
  const unresolved: string[] = [];
  for (const f of tsx) {
    const sf = ts.createSourceFile(
      f,
      readFileSync(f, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const rel = relative(srcRoot, f).replace(/\\/g, "/");
    const visit = (node: ts.Node): void => {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const tag = node.tagName.getText(sf);
        const attrs = node.attributes.properties;
        const cn = attrs.find(
          (a): a is ts.JsxAttribute => ts.isJsxAttribute(a) && a.name.getText(sf) === "className",
        );
        let pieces: string[] | null = [];
        if (cn?.initializer) {
          if (ts.isStringLiteral(cn.initializer)) pieces = [cn.initializer.text];
          else if (ts.isJsxExpression(cn.initializer) && cn.initializer.expression)
            pieces = staticPieces(cn.initializer.expression);
        }
        // `ph-fill` anywhere in the attribute's source text marks a glyph even when the rest of
        // the className is unreadable — that is exactly the case that must not pass silently.
        const isGlyph = tag === "Icon" || (cn?.getText(sf).includes("ph-fill") ?? false);
        if (isGlyph) {
          const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
          if (pieces === null) unresolved.push(`${rel}:${line} <${tag}> className is not literal`);
          if (attrs.some((a) => ts.isJsxSpreadAttribute(a)))
            unresolved.push(`${rel}:${line} <${tag}> has a {...spread}`);
          for (const t of tokens(pieces ?? [])) glyphClasses.add(t);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  /** Phosphor's `.ph-fill` base declarations an app rule could tie with, and their values. */
  const PHOSPHOR_BASE: Readonly<Record<string, string>> = {
    "line-height": "1",
    "letter-spacing": "0",
    "font-style": "normal",
    "font-weight": "normal",
    "font-variant": "normal",
    "text-transform": "none",
    "font-feature-settings": '"liga"',
    "font-variant-ligatures": "discretionary-ligatures",
  };

  const appRules = [
    ...parseRules(stripComments(readFileSync(join(srcRoot, "app", "globals.css"), "utf8"))),
    ...RULES,
  ];

  it("finds the glyph-bearing classes (so an empty pass means something)", () => {
    for (const c of ["ph-fill", "alert__icon", "attention__icon", "pnav__icon", "bb-toast__icon"])
      expect(glyphClasses.has(c), c).toBe(true);
  });

  it("every glyph element's classes are readable (no variable className, no spread)", () => {
    expect(unresolved, "make the className literal, or teach this guard the new form").toEqual([]);
  });

  it("a single-class rule on a glyph element repeats Phosphor's value or leaves it alone", () => {
    const clashes: string[] = [];
    for (const r of appRules) {
      for (const part of r.selector.split(",").map((s) => s.trim())) {
        if (!part.startsWith(".") || part.slice(1).includes(".") || /[\s:[>+~#]/.test(part))
          continue;
        if (!glyphClasses.has(part.slice(1))) continue;
        // The `font` shorthand resets line-height, weight, style and variant at once: a clash
        // whatever its value.
        const font = decl(r, "font");
        if (font !== null) clashes.push(`${r.at} ${part} { font: ${font} }`.trim());
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
