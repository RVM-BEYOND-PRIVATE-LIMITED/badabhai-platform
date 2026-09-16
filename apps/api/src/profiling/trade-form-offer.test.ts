import { describe, expect, it } from "vitest";

import { FORM_OFFER_OPTIONS, offerPrompt, readFormOfferReply } from "./trade-form-offer";
import { TRADE_FORM_OFFERS } from "./trade-form-router";

/**
 * The offer's own module — the reader, the chips, the copy.
 *
 * The chips are asserted by their CONTRACT (keys and boolean values), because the client
 * renders labels but answers with keys: a label edit is cosmetic, a key edit is a wire
 * change. The reader is asserted through both doors it promises — the chip key and typed
 * text — and through the one outcome that is a safety property: an unreadable reply is a
 * DECLINE, never an accept.
 */
describe("the trade-form offer module", () => {
  it("offers the handover's own headline, so the trade is spelled one way across the pause", () => {
    expect(offerPrompt("cnc_turner")).toBe(
      `${TRADE_FORM_OFFERS.cnc_turner.headline}. Form bharkar resume pura karna chahenge?`,
    );
    // A second kind, so a hardcoded copy cannot pass.
    expect(offerPrompt("welder")).toContain(TRADE_FORM_OFFERS.welder.headline);
  });

  it("carries exactly two chips — yes and no — with boolean values and stable keys", () => {
    expect(FORM_OFFER_OPTIONS).toHaveLength(2);
    expect(FORM_OFFER_OPTIONS.map((o) => o.option_key)).toEqual([
      "form_offer_yes",
      "form_offer_no",
    ]);
    expect(FORM_OFFER_OPTIONS.map((o) => o.value)).toEqual([true, false]);
  });

  it("reads the chips by their own keys", () => {
    expect(readFormOfferReply("form_offer_yes")).toBe("accept");
    expect(readFormOfferReply("form_offer_no")).toBe("decline");
  });

  it("reads typed and spoken Haan/Nahi through the one lexicon parser", () => {
    expect(readFormOfferReply("haan")).toBe("accept");
    expect(readFormOfferReply("haan ji form kholo")).toBe("accept");
    expect(readFormOfferReply("nahi")).toBe("decline");
    // The lexicon resolves negation, so this is a NO for the same reason it is one everywhere.
    expect(readFormOfferReply("haan nahi karta")).toBe("decline");
    // AND "PATA NAHI" IS A DECLINE, NOT AN UNCLEAR — the lexicon classifies "don't know" as a
    // negative, and the safe direction is preserved: it is never an accept, and the offer is
    // settled so it is never re-asked.
    expect(readFormOfferReply("pata nahi")).toBe("decline");
  });

  it("returns 'unclear' — never 'accept' — for a reply it cannot read", () => {
    for (const text of ["kya keh rahe ho", "...", "form kya hota hai bhai", "hello?"]) {
      expect(readFormOfferReply(text)).toBe("unclear");
    }
  });
});
