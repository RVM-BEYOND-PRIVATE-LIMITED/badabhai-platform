import { describe, expect, it } from "vitest";
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
  it("covers the fonts + all three icon sheets (the four that were blocking)", () => {
    expect(ASYNC_STYLESHEETS).toHaveLength(4);
    expect(ASYNC_STYLESHEETS.some((u) => u.includes("fonts.googleapis.com"))).toBe(true);
    expect(ASYNC_STYLESHEETS.filter((u) => u.includes("@phosphor-icons/web"))).toHaveLength(3);
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
