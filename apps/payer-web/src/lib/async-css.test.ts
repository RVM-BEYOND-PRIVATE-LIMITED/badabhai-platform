import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { ASYNC_CSS_SCRIPT, ASYNC_STYLESHEETS } from "./theme";

/**
 * B4 — the cross-origin stylesheets must NOT block first paint.
 *
 * MEASURED on the production build (`next start`, `/i/abcdef012345`):
 *   before — 6 render-blocking stylesheets, 4 of them cross-origin, 250,748 B of CSS
 *            pulled from two extra origins (fonts.googleapis.com + unpkg.com) before
 *            anything painted, on a page that renders ZERO icons;
 *   after  — 2 render-blocking stylesheets, 0 cross-origin, 0 third-party bytes on the
 *            critical path, for +222 gzipped bytes of HTML.
 *
 * That page is the conversion surface for the whole agent supply channel — an agent's QR
 * scan on a ₹7k handset on a congested tower — so this is a property worth a test, not a
 * one-time fix: re-adding a plain `<link rel="stylesheet">` for any of these to the root
 * layout would silently undo it.
 */
describe("async CSS loader — nothing third-party blocks first paint", () => {
  it("covers ONLY the web fonts — the icon sheet is self-hosted, never fetched from a CDN", () => {
    expect(ASYNC_STYLESHEETS).toHaveLength(1);
    expect(ASYNC_STYLESHEETS[0]).toContain("fonts.googleapis.com");
    // Phosphor used to be appended from unpkg.com here. It now ships through
    // @badabhai/icons/icons.css (globals.css), from this app's own origin.
    expect(ASYNC_STYLESHEETS.some((u) => u.includes("phosphor") || u.includes("unpkg"))).toBe(
      false,
    );
    expect(ASYNC_CSS_SCRIPT).not.toContain("unpkg");
  });

  it("every entry is CROSS-ORIGIN — same-origin app CSS must stay blocking (no FOUC)", () => {
    for (const href of ASYNC_STYLESHEETS) expect(href.startsWith("https://")).toBe(true);
  });

  it("keeps display=swap so text paints in the fallback face immediately", () => {
    const fonts = ASYNC_STYLESHEETS.find((u) => u.includes("fonts.googleapis.com"))!;
    expect(fonts).toContain("display=swap");
  });

  it("the inline loader appends each sheet at runtime (append = not render-blocking)", () => {
    for (const href of ASYNC_STYLESHEETS) expect(ASYNC_CSS_SCRIPT).toContain(href);
    expect(ASYNC_CSS_SCRIPT).toContain('rel="stylesheet"');
    expect(ASYNC_CSS_SCRIPT).toContain("appendChild");
  });

  it("cannot throw — a broken CDN must never take the install page down with it", () => {
    expect(ASYNC_CSS_SCRIPT).toContain("try{");
    expect(ASYNC_CSS_SCRIPT).toContain("catch(e){}");
  });

  it("is a self-contained IIFE with no bundler/module dependency (runs in <head>, pre-hydration)", () => {
    expect(ASYNC_CSS_SCRIPT.startsWith("(function(){")).toBe(true);
    expect(ASYNC_CSS_SCRIPT).not.toContain("import ");
    expect(ASYNC_CSS_SCRIPT).not.toContain("require(");
  });

  it("carries no raw hex/px literal (the DS adherence gate covers inline scripts too)", () => {
    expect(ASYNC_CSS_SCRIPT).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(ASYNC_CSS_SCRIPT).not.toMatch(/\b\d+px\b/);
  });
});

/**
 * Only the FILL sheet is loaded, so a glyph written in any other weight renders as an empty
 * box. This walks the shipped sources and fails on the regular (`ph ph-*`) or bold
 * (`ph-bold ph-*`) weight classes.
 */
describe("icon weight — every Phosphor glyph uses the one loaded (fill) sheet", () => {
  const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const sources: string[] = [];
  (function walk(dir: string): void {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (/\.(tsx|ts)$/.test(ent.name) && !/\.(test|spec)\.(tsx|ts)$/.test(ent.name))
        sources.push(full);
    }
  })(srcRoot);

  // A standalone `ph` class token, or any non-fill weight class.
  const OTHER_WEIGHT = /(^|["'`\s{])ph(?=["'`\s$])|\bph-(?:bold|regular|light|thin|duotone)\b/;

  /** Code only — a comment may name the retired weights. (`https://` is kept.) */
  const stripComments = (src: string) =>
    src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

  it("walks the app + component sources", () => {
    expect(sources.length).toBeGreaterThan(20);
  });

  it("the pattern catches each retired weight (so a pass below means something)", () => {
    for (const bad of [
      '<i className="ph ph-gear" />',
      "<i className={`ph ph-${icon}`} />",
      "<i className={`ph ${ok ? 'ph-check' : 'ph-x'}`} />",
      '<i className="ph-bold ph-check" />',
    ])
      expect(bad).toMatch(OTHER_WEIGHT);
    expect('<i className="ph-fill ph-gear" />').not.toMatch(OTHER_WEIGHT);
  });

  it("no source renders a regular/bold/outline Phosphor weight", () => {
    const offenders = sources
      .map((f) => {
        const hit = stripComments(readFileSync(f, "utf8")).match(OTHER_WEIGHT);
        return hit ? `${relative(srcRoot, f).replace(/\\/g, "/")} → ${hit[0].trim()}` : null;
      })
      .filter((x): x is string => x !== null);
    expect(offenders, `non-fill icon weights:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("the one sheet is imported through the bundler, from the shared icon package", () => {
    const globals = readFileSync(join(srcRoot, "app/globals.css"), "utf8");
    expect(globals).toContain('@import "@badabhai/icons/icons.css";');
    // FIRST: before the token and component layers — library rules precede the app's (an app
    // rule wins a tie with `.ph-fill`), and Next keeps tokens + components in one stylesheet.
    const at = (s: string) => globals.indexOf(s);
    expect(at('@import "@badabhai/icons/icons.css";')).toBeGreaterThanOrEqual(0);
    expect(at('@import "@badabhai/icons/icons.css";')).toBeLessThan(
      at('@import "@badabhai/design-tokens/tokens.css";'),
    );
    expect(at('@import "@badabhai/design-tokens/tokens.css";')).toBeLessThan(
      at('@import "../styles/ds-components.css";'),
    );
  });

  it("no shipped source references the unpkg CDN in code (the icon font is self-hosted)", () => {
    const offenders = sources
      .filter((f) => stripComments(readFileSync(f, "utf8")).includes("unpkg.com"))
      .map((f) => relative(srcRoot, f).replace(/\\/g, "/"));
    expect(offenders).toEqual([]);
  });

  it("no stylesheet targets a retired weight class (the selector would match nothing)", () => {
    for (const css of ["app/globals.css", "styles/ds-components.css"]) {
      const code = readFileSync(join(srcRoot, css), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
      expect(code, css).not.toMatch(/\.ph(?![\w-])|\.ph-(?:bold|regular|light|thin|duotone)\b/);
    }
  });
});
