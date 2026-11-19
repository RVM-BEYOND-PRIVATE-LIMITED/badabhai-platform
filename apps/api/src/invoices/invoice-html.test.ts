import { describe, expect, it } from "vitest";
import { buildTaxDocumentHtml, formatPaise, formatRate, istDate, type TaxDocumentView } from "./invoice-html";

/** #2749 part 4 — the one tax-document template. Every party value is a FAKE fixture. */
const view = (over: Partial<TaxDocumentView> = {}): TaxDocumentView => ({
  kind: "invoice",
  number: "BB/2026-27/0001",
  issuedAt: new Date("2026-11-18T20:00:00Z"), // 19 Nov in IST
  originalInvoice: null,
  seller: {
    legalName: "Fake Seller Private Limited",
    address: "1 Test Road\nTestpur",
    gstin: "06AAAAA0000A1Z6",
    pan: "AAAAA0000A",
    stateCode: "06",
  },
  buyer: { legalName: "Buyer <script>alert(1)</script>", address: "A & B \"Lane\"", gstin: "27AAAAA0000A1Z2", stateCode: "27" },
  sacCode: "998512",
  description: "Credit pack — Starter, 20 contact credits, valid 30 days",
  supplyType: "inter",
  gstRateBps: 1800,
  taxablePaise: 99_900,
  cgstPaise: 0,
  sgstPaise: 0,
  igstPaise: 18_000,
  totalPaise: 117_900,
  ...over,
});

describe("buildTaxDocumentHtml", () => {
  it("output-encodes every value a person typed", () => {
    const html = buildTaxDocumentHtml(view());
    expect(html).not.toContain("<script>");
    expect(html).toContain("Buyer &lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("A &amp; B &quot;Lane&quot;");
  });

  it("an invoice across states: IGST at the full rate, the place of supply, the total in words", () => {
    const html = buildTaxDocumentHtml(view());
    expect(html).toContain("Tax Invoice");
    expect(html).toContain("IGST @ 18%");
    expect(html).not.toContain("CGST");
    expect(html).toContain("Place of supply: Maharashtra (27)");
    expect(html).toContain("State: Haryana (06)");
    expect(html).toContain("PAN: AAAAA0000A");
    expect(html).toContain("SAC 998512");
    expect(html).toContain("₹1,179.00");
    expect(html).toContain("Rupees One Thousand One Hundred Seventy Nine Only");
    expect(html).toContain("19 Nov 2026");
  });

  it("inside the state: CGST and SGST at half the rate each; never a round-off line", () => {
    const html = buildTaxDocumentHtml(
      view({ supplyType: "intra", cgstPaise: 9000, sgstPaise: 9000, igstPaise: 0, buyer: { ...view().buyer, stateCode: "06" } }),
    );
    expect(html).toContain("CGST @ 9%");
    expect(html).toContain("SGST @ 9%");
    expect(html).not.toContain("IGST");
    expect(html.toLowerCase()).not.toContain("round");
  });

  it("an unregistered buyer prints no name or GSTIN, only the place of supply", () => {
    const html = buildTaxDocumentHtml(
      view({ buyer: { legalName: null, address: null, gstin: null, stateCode: "06" } }),
    );
    expect(html).toContain("GSTIN: Unregistered");
    expect(html).toContain("Place of supply: Haryana (06)");
  });

  it("a credit note names itself and the original invoice", () => {
    const html = buildTaxDocumentHtml(
      view({
        kind: "credit_note",
        number: "CN/2026-27/0001",
        originalInvoice: { number: "BB/2026-27/0001", issuedAt: new Date("2026-11-10T06:00:00Z") },
      }),
    );
    expect(html).toContain("Credit Note");
    expect(html).toContain("CN/2026-27/0001");
    expect(html).toContain("Original invoice no.: BB/2026-27/0001 dated 10 Nov 2026");
  });

  it("formats money, rates and IST dates", () => {
    expect(formatPaise(11_799_00)).toBe("₹11,799.00");
    expect(formatPaise(100_050)).toBe("₹1,000.50");
    expect(formatRate(900)).toBe("9%");
    expect(formatRate(450)).toBe("4.5%");
    expect(istDate(new Date("2027-03-31T18:30:00Z"))).toBe("01 Apr 2027");
  });
});
