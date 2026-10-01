import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import ts from "typescript";

/**
 * ICON FENCE — every glyph in the admin portal goes through @badabhai/icons.
 *
 * Two things are refused, both counted in CODE only:
 *   1. A raw `ph-fill` class string (`<i className="ph-fill ph-…">` takes an untyped name, so a typo
 *      renders an empty box). The console's allow-list is EMPTY: render `<Icon>` / `IconButton`.
 *   2. A hand-drawn SVG ICON — the retired `PhIcon` carried Phosphor path data in this repo, and
 *      every new glyph meant pasting another path. NOT every inline `<svg>`: a chart, sparkline or
 *      logo is content, not an icon, and stays allowed. An `<svg>` counts as an ICON when it
 *        - sits inside an interactive element (`<button>`, `<a>`, `<Link>`, or anything with an
 *          `onClick`) — the place an icon-only control would draw one;
 *        - carries an icon-ish class (a class token containing "icon" or starting `ph-`);
 *        - uses Phosphor's 256-unit grid (`viewBox="0 0 256 256"`); or
 *        - is glyph-sized: every literal `width` / `height` it declares is 32 or less (a
 *          120×32 sparkline is not; a 16×16 square is).
 *      A genuine exception goes in SVG_ICON_ALLOWLIST with its reason (empty today).
 */
const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
const countRawIcons = (code: string): number => (code.match(/\bph-fill\b/g) ?? []).length;

/** `file:line` → why this inline SVG icon is allowed. */
const SVG_ICON_ALLOWLIST: Readonly<Record<string, string>> = {};

const INTERACTIVE = new Set(["button", "a", "Link"]);

/** Inline SVG ICONS in a TSX source, as `line: reason` strings (see the header for the rules). */
function svgIcons(fileName: string, source: string): string[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: string[] = [];
  const attr = (el: ts.JsxOpeningLikeElement, name: string): ts.JsxAttribute | undefined =>
    el.attributes.properties.find(
      (a): a is ts.JsxAttribute => ts.isJsxAttribute(a) && a.name.getText(sf) === name,
    );
  const literal = (a: ts.JsxAttribute | undefined): string | null => {
    const init = a?.initializer;
    if (!init) return null;
    if (ts.isStringLiteral(init)) return init.text;
    if (ts.isJsxExpression(init) && init.expression) {
      const e = init.expression;
      if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e) || ts.isNumericLiteral(e))
        return e.text;
    }
    return null;
  };
  const isInteractive = (el: ts.JsxOpeningLikeElement) =>
    INTERACTIVE.has(el.tagName.getText(sf)) || attr(el, "onClick") !== undefined;

  const visit = (node: ts.Node, insideInteractive: boolean): void => {
    let inside = insideInteractive;
    const opening = ts.isJsxElement(node)
      ? node.openingElement
      : ts.isJsxSelfClosingElement(node)
        ? node
        : null;
    if (opening) {
      if (opening.tagName.getText(sf) === "svg") {
        const line = sf.getLineAndCharacterOfPosition(opening.getStart(sf)).line + 1;
        const cls = literal(attr(opening, "className")) ?? "";
        const size = [literal(attr(opening, "width")), literal(attr(opening, "height"))]
          .filter((v): v is string => v !== null)
          .map(Number);
        const reasons = [
          inside && "inside an interactive element",
          cls.split(/\s+/).some((t) => /icon/i.test(t) || t.startsWith("ph-")) && "icon class",
          literal(attr(opening, "viewBox"))?.trim() === "0 0 256 256" && "Phosphor 256 grid",
          size.length > 0 && size.every((n) => n > 0 && n <= 32) && "glyph-sized",
        ].filter(Boolean);
        if (reasons.length) found.push(`${line}: ${reasons.join(", ")}`);
      }
      if (isInteractive(opening)) inside = true;
    }
    ts.forEachChild(node, (child) => visit(child, inside));
  };
  visit(sf, false);
  return found;
}

function shippedSources(): string[] {
  const out: string[] = [];
  (function walk(dir: string): void {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (/\.(tsx|ts)$/.test(ent.name) && !/\.(test|spec)\.(tsx|ts)$/.test(ent.name))
        out.push(full);
    }
  })(srcRoot);
  return out;
}

const rel = (f: string) => relative(srcRoot, f).replace(/\\/g, "/");
const SOURCES = new Map(shippedSources().map((f) => [rel(f), readFileSync(f, "utf8")]));
const CODE = new Map([...SOURCES].map(([f, src]) => [f, stripComments(src)]));

describe("icon fence (admin) — the detectors catch what they must, and only that", () => {
  it("counts a raw glyph in every form, and not the typed element", () => {
    expect(countRawIcons('<i className="ph-fill ph-gear" />')).toBe(1);
    expect(countRawIcons("<i className={`ph-fill ph-${n}`} />")).toBe(1);
    expect(countRawIcons('<Icon name="gear" />')).toBe(0);
  });

  it("flags an SVG icon by placement, class, Phosphor grid or glyph size", () => {
    const hits = (src: string) => svgIcons("t.tsx", src).length;
    expect(
      hits('const a = <button onClick={f}><svg viewBox="0 0 10 10"><path /></svg></button>;'),
    ).toBe(1);
    expect(hits('const a = <Link href="/"><svg viewBox="0 0 10 10" /></Link>;')).toBe(1);
    expect(hits('const a = <div onClick={f}><span><svg viewBox="0 0 9 9" /></span></div>;')).toBe(
      1,
    );
    expect(hits('const a = <svg className="ph-icon" viewBox="0 0 1 1" />;')).toBe(1);
    expect(hits('const a = <svg className="row-icon" viewBox="0 0 1 1" />;')).toBe(1);
    expect(hits('const a = <svg viewBox="0 0 256 256"><path d="M0" /></svg>;')).toBe(1);
    expect(hits("const a = <svg width={16} height={16} />;")).toBe(1);
  });

  it("leaves content SVG alone: a chart, a sparkline, a large logo", () => {
    const hits = (src: string) => svgIcons("t.tsx", src).length;
    expect(
      hits('const a = <div><svg viewBox="0 0 600 200" className="chart"><path /></svg></div>;'),
    ).toBe(0);
    // 32 tall but 120 wide: a sparkline, not a glyph — only an svg glyph-sized on EVERY axis counts.
    expect(hits('const a = <svg className="sparkline" width="120" height="32" />;')).toBe(0);
    expect(hits('const a = <svg className="sparkline" width="120" height="40" />;')).toBe(0);
    expect(
      hits('const a = <figure><svg role="img" aria-label="Logo" width={160} /></figure>;'),
    ).toBe(0);
  });

  it("walks the shipped sources", () => {
    expect(CODE.size).toBeGreaterThan(50);
  });
});

describe("icon fence (admin) — no raw glyph and no hand-drawn SVG icon anywhere", () => {
  it("no source renders a raw `ph-fill` class string (allow-list: empty)", () => {
    const raw = [...CODE].filter(([, code]) => countRawIcons(code) > 0).map(([f]) => f);
    console.info(
      `[icon-fence] admin-web: ${raw.length} files with raw ph-fill class strings (allow-list: 0)`,
    );
    expect(raw, "render <Icon name=…> from @badabhai/icons instead").toEqual([]);
  });

  it("no source draws an inline SVG ICON (content SVG is fine)", () => {
    const icons = [...SOURCES]
      .filter(([f]) => f.endsWith(".tsx"))
      .flatMap(([f, src]) => svgIcons(f, src).map((hit) => `${f}:${hit}`))
      .filter((hit) => !(hit.slice(0, hit.indexOf(": ")) in SVG_ICON_ALLOWLIST));
    expect(icons, "render <Icon name=…> instead, or allow-list it with a reason").toEqual([]);
  });

  it("the allow-list carries a reason for every entry", () => {
    for (const [site, why] of Object.entries(SVG_ICON_ALLOWLIST))
      expect(why.trim(), site).not.toBe("");
  });

  it("the retired inline-SVG PhIcon is gone", () => {
    expect(existsSync(join(srcRoot, "components", "ph-icon.tsx"))).toBe(false);
    expect([...CODE.values()].some((code) => code.includes("PhIcon"))).toBe(false);
  });
});
