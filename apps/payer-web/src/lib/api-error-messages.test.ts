import { describe, expect, it } from "vitest";
import {
  SAFE_ERROR_MESSAGE,
  messageFor,
  withCommon,
} from "./api-error-messages";
import { postingsErrorMessage } from "./postings-messages";
import { agencyErrorMessage } from "./agency-messages";
import { creditsErrorMessage } from "./credits-messages";
import { candidatesErrorMessage } from "./candidates-messages";

const catalogue = withCommon(
  { price_mismatch: "The price changed." },
  { 418: "That is not available." },
  "A safe fallback.",
);

describe("messageFor — API codes/statuses become human copy", () => {
  it("maps a known code, ignoring case, spaces and hyphens", () => {
    expect(messageFor("price_mismatch", catalogue)).toBe("The price changed.");
    expect(messageFor("PRICE-MISMATCH", catalogue)).toBe("The price changed.");
  });

  it("maps a status number or a status-looking string", () => {
    expect(messageFor(418, catalogue)).toBe("That is not available.");
    expect(messageFor("418", catalogue)).toBe("That is not available.");
    expect(messageFor("error 429", catalogue)).toContain("Too many attempts");
  });

  it("gives the safe fallback for an unknown code — never the raw input", () => {
    expect(messageFor("some_unknown_code", catalogue)).toBe("A safe fallback.");
    expect(messageFor("UNMAPPED_REASON", catalogue)).toBe("A safe fallback.");
  });

  it("strips raw server text, exception strings, stack traces and JSON", () => {
    for (const raw of [
      "Error: connect ECONNREFUSED 127.0.0.1:3000",
      "TypeError: Cannot read properties of undefined",
      "at handler (/app/dist/main.js:12:34)",
      '{"statusCode":500,"message":"boom"}',
      "500 Internal Server Error",
    ]) {
      expect(messageFor(raw, catalogue)).toBe("A safe fallback.");
    }
  });

  it("passes through copy a caller already wrote as a sentence", () => {
    expect(messageFor("Could not save the changes right now. Please retry.", catalogue)).toBe(
      "Could not save the changes right now. Please retry.",
    );
  });

  it("null/empty input is the catalogue fallback", () => {
    expect(messageFor(null, catalogue)).toBe("A safe fallback.");
    expect(messageFor("", catalogue)).toBe("A safe fallback.");
    expect(messageFor(undefined, catalogue)).toBe("A safe fallback.");
  });

  it("an unknown 4xx uses the domain fallback, never a leaked status", () => {
    expect(messageFor(422, catalogue)).toBe("A safe fallback.");
  });
});

describe("domain catalogues", () => {
  it("postings understands the trade reason and its own fallback", () => {
    expect(postingsErrorMessage("posting_trade_required")).toContain("16 trades");
    expect(postingsErrorMessage("mystery_posting_code")).toBe(
      "We couldn't complete that posting change right now. Please try again.",
    );
  });

  it("agency keeps cap/failure neutral and masks unknown codes", () => {
    expect(agencyErrorMessage("rate_limited")).toContain("Too many attempts");
    expect(agencyErrorMessage("mystery_agency_code")).toBe(
      "Could not complete that request right now. Please try again shortly.",
    );
  });

  it("credits understands in-flight, price-change and forbidden", () => {
    expect(creditsErrorMessage("in_flight")).toContain("still processing");
    expect(creditsErrorMessage("price_mismatch")).toContain("price changed");
    expect(creditsErrorMessage("purchase_forbidden")).toContain("isn't available");
    expect(creditsErrorMessage("mystery_credits_code")).toContain("couldn't complete that purchase");
  });

  it("candidates masks an unknown code with the retryable line", () => {
    expect(candidatesErrorMessage("mystery_candidate_code")).toBe(
      "Couldn't reach BadaBhai. Please retry.",
    );
  });

  it("every catalogue has the shared unknown-code fallback", () => {
    for (const resolve of [
      postingsErrorMessage,
      agencyErrorMessage,
      creditsErrorMessage,
      candidatesErrorMessage,
    ]) {
      expect(resolve("THIS_CODE_DOES_NOT_EXIST")).not.toContain("THIS_CODE_DOES_NOT_EXIST");
      expect(resolve("THIS_CODE_DOES_NOT_EXIST")).not.toBe(SAFE_ERROR_MESSAGE + "x");
    }
  });
});
