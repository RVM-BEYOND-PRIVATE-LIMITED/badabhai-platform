import { describe, expect, it } from "vitest";

import {
  OPTIONAL_OFFER_OPTIONS,
  OPTIONAL_OFFER_PROMPT_TEXT,
  readOptionalOfferReply,
} from "./optional-offer";

/**
 * The optional-depth offer module — the reader, the chips, the copy.
 *
 * Same contract as the trade-form offer (`trade-form-offer.test.ts`): chips by
 * key, typed text through the one lexicon parser, and an unreadable reply is a
 * DECLINE, never an accept and never a re-ask.
 */
describe("the optional-depth offer module", () => {
  it("asks the Bas-ho-gaya line plus the 2-minute question", () => {
    expect(OPTIONAL_OFFER_PROMPT_TEXT).toBe(
      "Bas ho gaya. Resume ban raha hai. 2 minute aur dein? Resume aur strong banega.",
    );
  });

  it("carries exactly two chips — yes and no — with boolean values and stable keys", () => {
    expect(OPTIONAL_OFFER_OPTIONS).toHaveLength(2);
    expect(OPTIONAL_OFFER_OPTIONS.map((o) => o.option_key)).toEqual([
      "optional_offer_yes",
      "optional_offer_no",
    ]);
    expect(OPTIONAL_OFFER_OPTIONS.map((o) => o.value)).toEqual([true, false]);
  });

  it("reads the chips by their own keys", () => {
    expect(readOptionalOfferReply("optional_offer_yes")).toBe("accept");
    expect(readOptionalOfferReply("optional_offer_no")).toBe("decline");
  });

  it("reads typed Haan/Nahi through the one lexicon parser", () => {
    expect(readOptionalOfferReply("haan")).toBe("accept");
    expect(readOptionalOfferReply("haan, 2 minute aur")).toBe("accept");
    expect(readOptionalOfferReply("nahi")).toBe("decline");
    expect(readOptionalOfferReply("nahi, bas ho gaya")).toBe("decline");
  });

  it("returns 'unclear' — never 'accept' — for a reply it cannot read", () => {
    for (const text of ["kya keh rahe ho", "...", "resume kya hota hai bhai", "hello?"]) {
      expect(readOptionalOfferReply(text)).toBe("unclear");
    }
  });
});
