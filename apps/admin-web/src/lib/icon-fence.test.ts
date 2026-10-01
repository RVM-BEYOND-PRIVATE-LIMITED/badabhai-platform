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
 *        - is a DIRECT child of an interactive element (`<button>`, `<a>`, `<Link>`, `<summary>`,
 *          `role="button"|"link"`, or anything with a click/pointer handler) — the place an
 *          icon-only control draws one (a sparkline deeper inside a linked tile is content);
 *        - carries an icon-ish class (a class token with an `icon`/`icons` segment — `row__icon`,
 *          `icon-sm`, not `lexicon-chart` — or starting `ph-`);
 *        - uses Phosphor's 256-unit grid (`viewBox="0 0 256 256"`);
 *        - draws on a small square grid (`viewBox` w = h ≤ 48: the 16/20/24/32 icon grids) — this
 *          also catches a glyph wrapped in its own component and placed in a button elsewhere; or
 *        - is glyph-sized: every literal `width` / `height` it declares is ≤ 32 (px or unitless)
 *          or ≤ 2 (em/rem) — a 120×32 sparkline is not; a 16×16 square or a `1em` icon is.
 *      A genuine exception goes in SVG_ICON_ALLOWLIST with its reason (empty today).
 */
const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
const countRawIcons = (code: string): number => (code.match(/\bph-fill\b/g) ?? []).length;

/** `file:line` → why this inline SVG icon is allowed. */
const SVG_ICON_ALLOWLIST: Readonly<Record<string, string>> = {};

const INTERACTIVE = new Set(["button", "a", "Link", "summary"]);
const INTERACTIVE_ROLES = new Set(["button", "link"]);
const INTERACTIVE_HANDLERS = ["onClick", "onPointerDown", "onPointerUp", "onMouseDown"];

/** A literal width/height is glyph-sized: ≤ 32 unitless or px, ≤ 2 em/rem; null if not readable. */
function glyphSized(value: string): boolean | null {
  const m = /^\s*(\d*\.?\d+)\s*(px|em|rem)?\s*$/i.exec(value);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = (m[2] ?? "px").toLowerCase();
  return n > 0 && (unit === "px" ? n <= 32 : n <= 2);
}

/** A class token names an icon: an `icon`/`icons` segment (BEM or kebab) or a `ph-` prefix. */
const iconishClass = (token: string) =>
  token.startsWith("ph-") ||
  token
    .toLowerCase()
    .split(/[-_]+/)
    .some((segment) => segment === "icon" || segment === "icons");

/** A `viewBox` drawing on a small square grid (w = h ≤ 48) — the shape of an icon grid. */
function smallSquareGrid(viewBox: string | null): boolean {
  if (viewBox === null) return false;
  const parts = viewBox.trim().split(/[\s,]+/).map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return false;
  const [, , w, h] = parts as [number, number, number, number];
  return w > 0 && w === h && w <= 48;
}

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
    INTERACTIVE.has(el.tagName.getText(sf)) ||
    INTERACTIVE_ROLES.has(literal(attr(el, "role")) ?? "") ||
    INTERACTIVE_HANDLERS.some((h) => attr(el, h) !== undefined);

  /** The JSX element whose children include `node` directly (fragments and `{…}` see through). */
  const jsxParent = (node: ts.Node): ts.JsxOpeningLikeElement | null => {
    let p = node.parent;
    while (p && (ts.isJsxExpression(p) || ts.isJsxFragment(p) || ts.isParenthesizedExpression(p)))
      p = p.parent;
    return p && ts.isJsxElement(p) ? p.openingElement : null;
  };

  const visit = (node: ts.Node): void => {
    const opening = ts.isJsxElement(node)
      ? node.openingElement
      : ts.isJsxSelfClosingElement(node)
        ? node
        : null;
    if (opening && opening.tagName.getText(sf) === "svg") {
      const line = sf.getLineAndCharacterOfPosition(opening.getStart(sf)).line + 1;
      const cls = literal(attr(opening, "className")) ?? "";
      const viewBox = literal(attr(opening, "viewBox"));
      const sizes = [literal(attr(opening, "width")), literal(attr(opening, "height"))]
        .filter((v): v is string => v !== null)
        .map(glyphSized);
      const parent = jsxParent(node);
      const reasons = [
        parent !== null && isInteractive(parent) && "direct child of an interactive element",
        cls.split(/\s+/).some(iconishClass) && "icon class",
        viewBox?.trim() === "0 0 256 256" && "Phosphor 256 grid",
        smallSquareGrid(viewBox) && "small square icon grid",
        sizes.length > 0 && sizes.every((s) => s === true) && "glyph-sized",
      ].filter(Boolean);
      if (reasons.length) found.push(`${line}: ${reasons.join(", ")}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
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
    expect(hits('const a = <svg className="row__icon" />;')).toBe(1);
    expect(hits('const a = <svg viewBox="0 0 256 256"><path d="M0" /></svg>;')).toBe(1);
    expect(hits("const a = <svg width={16} height={16} />;")).toBe(1);
    // The retired-PhIcon shape on a 24 / 20 / 16 grid, sized only by CSS — wherever it is drawn
    // (a component that a button renders elsewhere is still caught at its own definition).
    expect(hits('const Close = () => <svg viewBox="0 0 24 24"><path /></svg>;')).toBe(1);
    expect(hits('const a = <svg className="glyph" viewBox="0 0 20 20" />;')).toBe(1);
    // react-icons style em sizing, and px strings.
    expect(hits('const a = <svg width="1em" height="1em" />;')).toBe(1);
    expect(hits('const a = <svg width="16px" height="16px" />;')).toBe(1);
    // Other interactive parents.
    expect(hits('const a = <span role="button"><svg viewBox="0 0 90 30" /></span>;')).toBe(1);
    expect(hits('const a = <div onPointerDown={f}><svg viewBox="0 0 90 30" /></div>;')).toBe(1);
    expect(hits('const a = <summary><svg viewBox="0 0 90 30" /></summary>;')).toBe(1);
  });

  it("does not flag content that merely sits inside a link or a clickable row", () => {
    const hits = (src: string) => svgIcons("t.tsx", src).length;
    // A sparkline deeper inside a linked tile, a chart in a clickable row, a logo in a home link
    // nested in its own figure — content, not an icon (only DIRECT children count).
    expect(
      hits(
        'const a = <Link href="/x"><div className="tile"><svg className="sparkline" width="120" height="32" /></div></Link>;',
      ),
    ).toBe(0);
    expect(
      hits(
        'const a = <tr onClick={f}><td><svg viewBox="0 0 600 200" className="chart" /></td></tr>;',
      ),
    ).toBe(0);
    // A class token that merely CONTAINS "icon" is not an icon class.
    expect(hits('const a = <svg className="lexicon-chart" viewBox="0 0 600 200" />;')).toBe(0);
    // A wide or large-square viewBox is not an icon grid.
    expect(hits('const a = <svg viewBox="0 0 120 32" />;')).toBe(0);
    expect(hits('const a = <svg viewBox="0 0 400 400" />;')).toBe(0);
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
