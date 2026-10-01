import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

/**
 * ICON FENCE — every glyph in the admin portal goes through @badabhai/icons.
 *
 * The console's allow-list is EMPTY: there is no raw `<i className="ph-fill ph-…">` (an untyped
 * string — a typo renders an empty box) and no hand-copied inline-SVG icon (the retired `PhIcon`
 * carried Phosphor path data in this repo; every new glyph meant pasting another path). New code
 * renders `<Icon name="…">` or the `IconButton`. Counted in CODE only (comments stripped).
 */
const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
const countRawIcons = (code: string): number => (code.match(/\bph-fill\b/g) ?? []).length;
const hasInlineSvg = (code: string): boolean => /<svg[\s>]/.test(code);

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
const CODE = new Map(shippedSources().map((f) => [rel(f), stripComments(readFileSync(f, "utf8"))]));

describe("icon fence (admin) — the detectors catch what they must", () => {
  it("counts a raw glyph in every form, and not the typed element", () => {
    expect(countRawIcons('<i className="ph-fill ph-gear" />')).toBe(1);
    expect(countRawIcons("<i className={`ph-fill ph-${n}`} />")).toBe(1);
    expect(countRawIcons('<Icon name="gear" />')).toBe(0);
  });

  it("spots an inline SVG icon", () => {
    expect(hasInlineSvg('<svg className="ph-icon" viewBox="0 0 256 256">')).toBe(true);
    expect(hasInlineSvg("<svg>")).toBe(true);
    expect(hasInlineSvg('<Icon name="list" />')).toBe(false);
  });

  it("walks the shipped sources", () => {
    expect(CODE.size).toBeGreaterThan(50);
  });
});

describe("icon fence (admin) — no raw glyph and no hand-copied SVG icon anywhere", () => {
  it("no source renders a raw `ph-fill` class string (allow-list: empty)", () => {
    const raw = [...CODE].filter(([, code]) => countRawIcons(code) > 0).map(([f]) => f);
    console.info(
      `[icon-fence] admin-web: ${raw.length} files with raw ph-fill class strings (allow-list: 0)`,
    );
    expect(raw, "render <Icon name=…> from @badabhai/icons instead").toEqual([]);
  });

  it("no source draws an inline <svg> (icons come from the shared font)", () => {
    const svg = [...CODE].filter(([, code]) => hasInlineSvg(code)).map(([f]) => f);
    expect(svg).toEqual([]);
  });

  it("the retired inline-SVG PhIcon is gone", () => {
    expect(existsSync(join(srcRoot, "components", "ph-icon.tsx"))).toBe(false);
    expect([...CODE.values()].some((code) => code.includes("PhIcon"))).toBe(false);
  });
});
