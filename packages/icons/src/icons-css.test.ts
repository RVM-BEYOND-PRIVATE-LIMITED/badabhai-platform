import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `icons.css` — the one stylesheet both portals import. CSS is read as a string (comments
 * stripped) and checked for the properties the apps rely on.
 */
const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RAW = readFileSync(join(PKG_ROOT, "icons.css"), "utf8");
const CSS = RAW.replace(/\/\*[\s\S]*?\*\//g, "");
const require = createRequire(import.meta.url);

/** The declaration block of the first rule whose selector is exactly `selector`. */
function block(selector: string): string {
  const at = CSS.indexOf(`${selector} {`);
  if (at === -1) return "";
  return CSS.slice(CSS.indexOf("{", at) + 1, CSS.indexOf("}", at));
}

describe("icons.css self-hosts Phosphor FILL", () => {
  const imports = [...CSS.matchAll(/@import\s+"([^"]+)"/g)].map((m) => m[1]);

  it("imports exactly one sheet: the package's fill weight, first", () => {
    expect(imports).toEqual(["@phosphor-icons/web/fill"]);
    expect(CSS.trimStart().startsWith('@import "@phosphor-icons/web/fill";')).toBe(true);
  });

  it("that specifier resolves to the installed fill sheet (what the bundler will inline)", () => {
    const resolved = require.resolve(imports[0]!).replace(/\\/g, "/");
    expect(resolved).toMatch(/@phosphor-icons\/web\/src\/fill\/style\.css$/);
  });

  it("loads no other weight and nothing from another origin", () => {
    expect(CSS).not.toMatch(/\/(regular|bold|light|thin|duotone)\b/);
    expect(CSS).not.toMatch(/https?:|url\(/);
  });
});

describe("icons.css size tokens", () => {
  const root = block(":root");

  it("declares the three sizes and the gap as aliases of the token scale", () => {
    expect(root).toContain("--icon-size-sm: var(--text-base);");
    expect(root).toContain("--icon-size-md: var(--text-lg);");
    expect(root).toContain("--icon-size-lg: var(--text-xl);");
    expect(root).toContain("--icon-gap: var(--space-2);");
  });

  it("each <Icon size> class sets font-size from its token", () => {
    for (const size of ["sm", "md", "lg"]) {
      expect(block(`.bb-icon--${size}`).trim()).toBe(`font-size: var(--icon-size-${size});`);
    }
  });

  it("carries no raw px, hex, rgb() or hsl() value (DS adherence)", () => {
    expect(CSS).not.toMatch(/\b\d+(\.\d+)?px\b/);
    expect(CSS).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(CSS).not.toMatch(/\b(?:rgb|rgba|hsl|hsla)\(/);
  });
});
