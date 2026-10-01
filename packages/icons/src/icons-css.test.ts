import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TOOLTIP_DISMISSED_ATTRIBUTE, TOOLTIP_PLACEMENTS } from "./control";

/**
 * `icons.css` — the one stylesheet both portals import. CSS is read as a string (comments
 * stripped), flattened into rules (keeping the enclosing at-rule), and checked for the
 * properties the apps rely on. No RegExp is ever built from a selector or a property name.
 */
const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RAW = readFileSync(join(PKG_ROOT, "icons.css"), "utf8");
const CSS = RAW.replace(/\/\*[\s\S]*?\*\//g, "");
const require = createRequire(import.meta.url);

interface Rule {
  selector: string;
  body: string;
  at: string;
}

function parseRules(css: string, at = ""): Rule[] {
  const out: Rule[] = [];
  let prelude = "";
  let i = 0;
  while (i < css.length) {
    const ch = css[i]!;
    if (ch === "{") {
      let depth = 1;
      let j = i + 1;
      for (; j < css.length && depth > 0; j++) {
        if (css[j] === "{") depth++;
        else if (css[j] === "}") depth--;
      }
      const selector = prelude.trim().replace(/\s+/g, " ");
      const body = css.slice(i + 1, j - 1);
      if (selector.startsWith("@media")) out.push(...parseRules(body, selector));
      else out.push({ selector, body, at });
      prelude = "";
      i = j;
      continue;
    }
    if (ch === "}" || ch === ";") prelude = "";
    else prelude += ch;
    i++;
  }
  return out;
}

const RULES = parseRules(CSS);

/** Last declared value of `prop` across every rule (in `at`) whose selector LIST contains `sel`. */
function decl(sel: string, prop: string, at = ""): string | null {
  let value: string | null = null;
  for (const r of RULES) {
    if (r.at !== at || !r.selector.split(",").some((p) => p.trim() === sel)) continue;
    for (const part of r.body.split(";")) {
      const colon = part.indexOf(":");
      if (colon >= 0 && part.slice(0, colon).trim() === prop) value = part.slice(colon + 1).trim();
    }
  }
  return value;
}
const indexOf = (sel: string, at = "") =>
  RULES.findIndex((r) => r.at === at && r.selector.split(",").some((p) => p.trim() === sel));

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

  it("the import site records the tracked cost (subset follow-up to PR #1886)", () => {
    const at = RAW.indexOf('@import "@phosphor-icons/web/fill";');
    const header = RAW.slice(0, at);
    expect(header).toContain("KNOWN COST, TRACKED");
    expect(header).toContain("#1886");
    expect(header).toContain("#1893");
  });
});

describe("icons.css size tokens", () => {
  it("declares the three sizes and the gap as aliases of the token scale", () => {
    expect(decl(":root", "--icon-size-sm")).toBe("var(--text-base)");
    expect(decl(":root", "--icon-size-md")).toBe("var(--text-lg)");
    expect(decl(":root", "--icon-size-lg")).toBe("var(--text-xl)");
    expect(decl(":root", "--icon-gap")).toBe("var(--space-2)");
  });

  it("each <Icon size> class sets font-size from its token", () => {
    for (const size of ["sm", "md", "lg"]) {
      expect(decl(`.bb-icon--${size}`, "font-size")).toBe(`var(--icon-size-${size})`);
    }
  });

  it("carries no raw px, hex, rgb() or hsl() value (DS adherence)", () => {
    expect(CSS).not.toMatch(/\b\d+(\.\d+)?px\b/);
    expect(CSS).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(CSS).not.toMatch(/\b(?:rgb|rgba|hsl|hsla)\(/);
  });
});

describe("the icon-only control's tooltip", () => {
  it("is hidden with display:none — no click target and no scroll overflow while hidden", () => {
    expect(decl(".bb-icon-tip", "display")).toBe("none");
    expect(decl(".bb-icon-tip", "position")).toBe("absolute");
    expect(decl(".bb-icon-tip", "z-index")).toBe("var(--z-tooltip)");
    // Click-through by default; only the hover trigger turns pointer events on.
    expect(decl(".bb-icon-tip", "pointer-events")).toBe("none");
  });

  it("fades in with an animation (a transition cannot start from display:none)", () => {
    expect(decl(".bb-icon-tip", "animation")).toBe(
      "bb-icon-tip-in var(--duration-fast) var(--ease-out)",
    );
    expect(CSS).toContain("@keyframes bb-icon-tip-in");
  });

  it("keyboard focus shows it at every width — and leaves it click-through", () => {
    expect(decl(":focus-visible > .bb-icon-tip", "display")).toBe("block");
    // A focus-opened tooltip must not sit over the control beneath it and swallow its click.
    expect(decl(":focus-visible > .bb-icon-tip", "pointer-events")).toBeNull();
  });

  it("hover shows it only where hover exists, and only then is it hoverable", () => {
    expect(indexOf(":hover > .bb-icon-tip")).toBe(-1);
    const at = "@media (hover: hover)";
    expect(decl(":hover > .bb-icon-tip", "display", at)).toBe("block");
    expect(decl(":hover > .bb-icon-tip", "pointer-events", at)).toBe("auto");
  });

  it("the Escape rule keys on the shared attribute and comes after both triggers", () => {
    const sel = `[${TOOLTIP_DISMISSED_ATTRIBUTE}] > .bb-icon-tip`;
    expect(decl(sel, "display")).toBe("none");
    expect(indexOf(sel)).toBeGreaterThan(indexOf(":focus-visible > .bb-icon-tip"));
    expect(indexOf(sel)).toBeGreaterThan(indexOf(":hover > .bb-icon-tip", "@media (hover: hover)"));
  });

  it("every placement is positioned and has a gap bridge the pointer can cross", () => {
    expect(decl(".bb-icon-tip::before", "content")).toBe('""');
    for (const p of TOOLTIP_PLACEMENTS) {
      const tip = `.bb-icon-tip--${p}`;
      expect(indexOf(tip), p).toBeGreaterThanOrEqual(0);
      expect(indexOf(`${tip}::before`), p).toBeGreaterThanOrEqual(0);
    }
  });

  it("the edge-aware placements align an EDGE (grow inward), the plain ones centre", () => {
    expect(decl(".bb-icon-tip--top", "transform")).toBe("translateX(-50%)");
    expect(decl(".bb-icon-tip--bottom-start", "inset-inline-start")).toBe("0");
    expect(decl(".bb-icon-tip--bottom-end", "inset-inline-end")).toBe("0");
    expect(decl(".bb-icon-tip--top-end", "inset-inline-end")).toBe("0");
    expect(decl(".bb-icon-tip--bottom-end", "transform")).toBeNull();
    expect(decl(".bb-icon-tip--bottom-end", "top")).toBe("100%");
  });
});
