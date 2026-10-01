import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ALL_ICON_NAMES, ICON_NAMES, LEGACY_ICON_NAMES } from "./names";

/**
 * Every `IconName` must exist in the INSTALLED fill sheet — the exact file the apps bundle.
 *
 * Resolved through the package's own `exports` (`@phosphor-icons/web/fill`), the same specifier
 * `icons.css` imports, so this reads precisely what ships. Parsed as a string with a static
 * pattern (no `RegExp` built from a variable).
 */
const require = createRequire(import.meta.url);
const FILL_CSS_PATH = require.resolve("@phosphor-icons/web/fill");
const FILL_CSS = readFileSync(FILL_CSS_PATH, "utf8");
const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** name → the `content` codepoint of its `.ph-fill.ph-<name>:before` rule. */
function glyphRules(css: string): Map<string, string> {
  const rules = new Map<string, string>();
  for (const m of css.matchAll(/\.ph-fill\.ph-([a-z0-9-]+):before\s*\{\s*content:\s*"([^"]+)"/g)) {
    rules.set(m[1]!, m[2]!);
  }
  return rules;
}

const RULES = glyphRules(FILL_CSS);

describe("the fill sheet parse is real (so a pass below means something)", () => {
  it("finds the whole sheet — Phosphor ships ~1,500 fill glyphs", () => {
    expect(RULES.size).toBeGreaterThan(1500);
  });

  it("finds a known glyph and rejects a misspelt one", () => {
    expect(RULES.get("plus")).toMatch(/^\\[0-9a-f]{4}$/);
    expect(RULES.has("plsu")).toBe(false);
  });
});

describe("IconName ⊂ installed Phosphor FILL glyphs", () => {
  it("every canonical and legacy name has a `.ph-fill.ph-<name>:before` rule with a codepoint", () => {
    const missing = ALL_ICON_NAMES.filter((n) => !RULES.has(n));
    expect(missing, `not in ${FILL_CSS_PATH}`).toEqual([]);
  });

  it("names are sorted and unique (reviewable diffs, no accidental duplicates)", () => {
    for (const list of [ICON_NAMES, LEGACY_ICON_NAMES] as const) {
      expect([...list]).toEqual([...new Set(list)].sort());
    }
  });

  it("a retired (legacy) name is never also canonical", () => {
    const canonical = new Set<string>(ICON_NAMES);
    expect(LEGACY_ICON_NAMES.filter((n) => canonical.has(n))).toEqual([]);
  });
});

describe("the dependency is pinned and self-hostable", () => {
  const manifest = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8")) as {
    dependencies: Record<string, string>;
  };
  const installed = JSON.parse(
    readFileSync(join(dirname(FILL_CSS_PATH), "..", "..", "package.json"), "utf8"),
  ) as { name: string; version: string };

  it("pins an EXACT version (no range) and that version is what is installed", () => {
    const spec = manifest.dependencies["@phosphor-icons/web"];
    expect(spec).toMatch(/^\d+\.\d+\.\d+$/);
    expect(installed.name).toBe("@phosphor-icons/web");
    expect(installed.version).toBe(spec);
  });

  it("the sheet's @font-face points at a RELATIVE woff2 that ships beside it", () => {
    expect(FILL_CSS).toContain('url("./Phosphor-Fill.woff2") format("woff2")');
    expect(existsSync(join(dirname(FILL_CSS_PATH), "Phosphor-Fill.woff2"))).toBe(true);
  });

  it("the sheet references no absolute or third-party URL (nothing leaves the app's origin)", () => {
    for (const m of FILL_CSS.matchAll(/url\(\s*["']?([^"')]+)/g)) {
      expect(m[1], "every font url must be relative").toMatch(/^\.\//);
    }
    expect(FILL_CSS).not.toMatch(/https?:|\/\/[a-z]/i);
  });
});
