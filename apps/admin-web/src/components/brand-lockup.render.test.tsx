import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { BrandLockup } from "./brand-lockup";

/**
 * What `BrandLockup` RENDERS — the logo on the sidebar and on the sign-in page.
 *
 * Plain function component with no hooks, so `renderToStaticMarkup` in the node env is
 * enough (same approach as the other *.render.test.tsx files).
 */

const html = (el: React.ReactElement) => renderToStaticMarkup(el);

/**
 * The text an assistive technology is left with: every `aria-hidden="true"` element dropped
 * (the mark is a void `<img>`, so a self-closing match covers it), every remaining `<img>`
 * replaced by its alt text (the logotype is an image), tags stripped, whitespace collapsed.
 * Crude, but the lockup is flat enough that it is exact here.
 */
function accessibleText(markup: string): string {
  return markup
    .replace(/<[^>]*aria-hidden="true"[^>]*\/?>/g, "")
    .replace(/<img[^>]*alt="([^"]*)"[^>]*\/?>/g, " $1 ")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

describe("BrandLockup rendering", () => {
  it("draws the brand-kit images as decorative CSS backgrounds, never as <img>", () => {
    const out = html(<BrandLockup />);
    // The images come from the token package's `.bb-lockup__mark` / `__wordmark` backgrounds,
    // so they ship content-hashed under /_next/static and cache despite the no-store catch-all.
    expect(out).not.toContain("<img");
    expect(out).toContain('<span class="bb-lockup__tile" aria-hidden="true"><span class="bb-lockup__mark"></span></span>');
    expect(out).toContain('<span class="bb-lockup__wordmark" aria-hidden="true"></span>');
  });

  it('has the accessible name "BadaBhai Admin" exactly once, word-separated', () => {
    // Without the space between the spans a screen reader announces "BadaBhaiAdmin".
    for (const surface of ["light", "ink"] as const) {
      const text = accessibleText(html(<BrandLockup surface={surface} />));
      expect(text).toBe("BadaBhai Admin");
      expect(text.match(/BadaBhai/g)).toHaveLength(1);
    }
  });

  it("uses the shared token-package classes, with the on-ink variant only on navy", () => {
    const light = html(<BrandLockup />);
    expect(light).toContain('class="bb-lockup"');
    expect(light).toContain('class="bb-lockup__text"');
    expect(light).toContain('class="bb-lockup__sub"');
    expect(light).not.toContain("bb-lockup--on-ink");
    // On the navy band the on-ink class is what swaps in the WHITE logotype (tokens.css).
    expect(html(<BrandLockup surface="ink" />)).toContain('class="bb-lockup bb-lockup--on-ink"');
  });
});
