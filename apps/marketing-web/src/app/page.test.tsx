import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import HomePage from "./page";

/**
 * HomePage is a pure Server Component (no hooks, no client state) — rendered here via
 * `react-dom/server` in plain "node", same pattern the rest of the monorepo uses for a
 * static page (no jsdom/RTL needed).
 */
describe("HomePage", () => {
  const html = renderToStaticMarkup(<HomePage />);

  it("renders the hero headline and value proposition", () => {
    expect(html).toContain("Skilled workers. Verified employers. Matched by AI.");
    expect(html).toContain("no resume required");
  });

  it("has no visible skip link (removed at the owner's request)", () => {
    expect(html).not.toContain("Skip to content");
  });

  it("represents both audiences with a labelled section each", () => {
    expect(html).toContain('id="workers"');
    expect(html).toContain('id="for-workers-title"');
    expect(html).toContain("For workers");
    expect(html).toContain('id="employers"');
    expect(html).toContain('id="for-employers-title"');
    expect(html).toContain("For employers");
  });

  it("never claims a worker's contact is shown before an employer unlocks it", () => {
    expect(html).toContain("faceless until you choose to unlock");
    expect(html).not.toMatch(/instant(ly)? (see|contact|call)/i);
  });

  it("CTA links are real relative hrefs, never a dead '#' placeholder", () => {
    const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1] ?? "");
    const ctaHrefs = hrefs.filter((h) => h !== "#main-content" && h !== "/");
    expect(ctaHrefs.length).toBeGreaterThan(0);
    for (const href of ctaHrefs) {
      expect(href).not.toBe("#");
      expect(href.startsWith("/") || href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("tel:")).toBe(true);
    }
    expect(hrefs).toContain("/workers");
    expect(hrefs).toContain("/employers");
  });

  it("footer states the consent invariant and carries real support channels", () => {
    expect(html).toContain("collected with consent");
    // Razorpay compliance: verifiable operational channels (domain-matched email + phone).
    expect(html).toContain("mailto:support@badabhai.ai");
    expect(html).toContain("tel:");
  });

  it("footer links all five Razorpay-mandatory pages (1 click from homepage)", () => {
    for (const href of ["/pricing", "/contact", "/terms", "/privacy", "/refund-policy"]) {
      expect(html).toContain(`href="${href}"`);
    }
  });

  it("shows INR pricing with GST disclosure on the landing section", () => {
    expect(html).toContain("₹");
    expect(html).toContain("GST");
  });

  it("renders exactly one h1 (single clear page title, WCAG heading structure)", () => {
    const h1Count = (html.match(/<h1[ >]/g) ?? []).length;
    expect(h1Count).toBe(1);
  });
});
