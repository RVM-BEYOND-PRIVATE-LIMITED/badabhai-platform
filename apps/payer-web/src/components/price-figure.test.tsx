import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { priceFigure } from "./price-figure";

/**
 * THE PRICE FIGURE a tile prints (#2085 + #2102). A pure function over a {@link ChargedPrice},
 * so it renders straight to markup in the node env — no hooks, no DOM.
 *
 * What is pinned here:
 *  · #2085 — at list price there is ONE figure and nothing struck; under an offer the catalog
 *    list price is struck BEFORE the charged one, and a screen reader hears "was ₹X, now ₹Y"
 *    rather than two bare numbers;
 *  · #2102 — WHEN the offer ends, beside the struck figure, as a DAY (no time of day reaches
 *    the DOM). It is printed only when `chargedPrice` carried one: an unnamed discount strikes
 *    the list price and states no deadline, because there is none to state.
 */

const markup = (price: Parameters<typeof priceFigure>[0]) =>
  renderToStaticMarkup(priceFigure(price));
/** The visible text, screen-reader-only spans included (they are real text in the DOM). */
const text = (price: Parameters<typeof priceFigure>[0]) =>
  markup(price)
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();

const ENDS_AT = "2026-11-01T00:00:00.000Z";

describe("priceFigure — at list price (#2085)", () => {
  it("prints ONE figure: nothing struck, no deadline", () => {
    const out = markup({ priceInr: 8000 });
    expect(out).not.toContain("price-was");
    expect(out).not.toContain("price-offer");
    expect(text({ priceInr: 8000 })).toBe("₹8,000");
  });

  it("a list price at or BELOW the charge is not struck (never a fake saving)", () => {
    // A row whose list price is not above the charge is not an offer; striking it would show a
    // discount the charge does not give. `offerEndsAt` cannot smuggle one in either.
    for (const listPriceInr of [8000, 7000]) {
      expect(markup({ priceInr: 8000, listPriceInr, offerEndsAt: ENDS_AT })).not.toContain(
        "price-was",
      );
      expect(markup({ priceInr: 8000, listPriceInr, offerEndsAt: ENDS_AT })).not.toContain(
        "price-offer",
      );
    }
  });
});

describe("priceFigure — under an offer (#2085 struck list price, #2102 deadline)", () => {
  it("strikes the list price before the charged one, and names the offer to a screen reader", () => {
    const out = markup({ priceInr: 6000, listPriceInr: 8000 });
    expect(out).toContain('<s class="price-was">₹8,000</s>');
    expect(text({ priceInr: 6000, listPriceInr: 8000 })).toBe("Offer: was ₹8,000, now ₹6,000");
  });

  it("#2102 states WHEN it ends — a day, in its own `.price-offer` slot", () => {
    const price = { priceInr: 6000, listPriceInr: 8000, offerEndsAt: ENDS_AT };
    expect(markup(price)).toContain('<span class="price-offer">');
    expect(text(price)).toBe("Offer: was ₹8,000, now ₹6,000, offer ends 2026-11-01");
    // The time of day is never printed — only the day the catalog's `ends_at` falls on.
    expect(markup(price)).not.toContain("00:00");
  });

  it("#2102 an unnamed discount says nothing: struck price, NO date", () => {
    // `chargedPrice` omits `offerEndsAt` when the API priced below list without naming an offer.
    const out = markup({ priceInr: 6000, listPriceInr: 8000 });
    expect(out).toContain("price-was");
    expect(out).not.toContain("price-offer");
  });

  it("#2102 an unparsable `ends_at` is printed AS SENT — never a wrong date, never a crash", () => {
    const price = { priceInr: 6000, listPriceInr: 8000, offerEndsAt: "soon" };
    expect(text(price)).toContain("offer ends soon");
  });
});
