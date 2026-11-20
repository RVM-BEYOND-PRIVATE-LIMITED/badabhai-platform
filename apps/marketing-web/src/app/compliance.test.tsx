import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import HomePage from "./page";
import PricingPage from "./pricing/page";
import ContactPage from "./contact/page";
import TermsPage from "./terms/page";
import PrivacyPage from "./privacy/page";
import RefundPolicyPage from "./refund-policy/page";
import { SITE } from "../site-config";

/**
 * Razorpay website-compliance gate: every public page (landing + the five
 * mandatory pages) renders the global footer with 1-click links to all five,
 * zero lorem/placeholder copy, and entity-consistent legal details.
 */
describe("Razorpay compliance pages", () => {
  const pages: [string, () => string][] = [
    ["home", () => renderToStaticMarkup(<HomePage />)],
    ["pricing", () => renderToStaticMarkup(<PricingPage />)],
    ["contact", () => renderToStaticMarkup(<ContactPage />)],
    ["terms", () => renderToStaticMarkup(<TermsPage />)],
    ["privacy", () => renderToStaticMarkup(<PrivacyPage />)],
    ["refund-policy", () => renderToStaticMarkup(<RefundPolicyPage />)],
  ];

  for (const [name, render] of pages) {
    it(`${name}: footer links all five mandatory pages`, () => {
      const html = render();
      for (const href of ["/pricing", "/contact", "/terms", "/privacy", "/refund-policy"]) {
        expect(html, `${name} missing footer link ${href}`).toContain(`href="${href}"`);
      }
    });

    it(`${name}: zero lorem/placeholder text`, () => {
      const html = render().toLowerCase();
      expect(html, `${name} has lorem ipsum`).not.toContain("lorem ipsum");
      expect(html, `${name} has TODO`).not.toContain("todo");
      expect(html, `${name} has [company]`).not.toContain("[company]");
    });

    it(`${name}: single h1`, () => {
      const html = render();
      expect((html.match(/<h1[ >]/g) ?? []).length).toBe(1);
    });
  }

  it("contact + terms carry the exact legal entity + address", () => {
    const contact = renderToStaticMarkup(<ContactPage />);
    const terms = renderToStaticMarkup(<TermsPage />);
    for (const html of [contact, terms]) {
      expect(html).toContain(SITE.legalName);
      expect(html).toContain("Faridabad");
      expect(html).toContain("121006");
      expect(html).toContain(SITE.supportEmail);
    }
  });

  it("pricing shows INR amounts + 18% GST", () => {
    const html = renderToStaticMarkup(<PricingPage />);
    expect(html).toContain("₹2,000");
    expect(html).toContain("18% GST");
    expect(html).toContain("Razorpay");
  });

  it("privacy names Razorpay as the payment processor", () => {
    const html = renderToStaticMarkup(<PrivacyPage />);
    expect(html).toContain("Razorpay");
  });

  it("refund policy states the 5–7 business-day timeline + governing law", () => {
    const html = renderToStaticMarkup(<RefundPolicyPage />);
    expect(html).toContain("5–7 business days");
    expect(html).toContain("original payment method");
    expect(html).toContain("Faridabad");
  });

  it("terms states Indian governing law + Faridabad jurisdiction", () => {
    const html = renderToStaticMarkup(<TermsPage />);
    expect(html).toContain("laws of India");
    expect(html).toContain("Faridabad");
  });
});
