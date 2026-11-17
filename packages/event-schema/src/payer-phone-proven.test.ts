import { describe, expect, it } from "vitest";
import { PayerPhoneProofMethodEnum } from "./payloads";
import { getEventDefinition } from "./registry";

/**
 * #2754 item 3 — `payer.phone_proven`: a company proved the phone on its account. Ids and a closed
 * method only: the number, its hash and the code never ride an event.
 */
const PAYER = "0f0e0d0c-0b0a-4908-8706-050403020100";

describe("payer.phone_proven v1", () => {
  const def = getEventDefinition("payer.phone_proven");

  it("is registered at version 1 in the payer domain", () => {
    expect(def.version).toBe(1);
    expect(def.domain).toBe("payer");
  });

  it("has exactly the two proof methods (the payer_phone_proofs CHECK)", () => {
    expect(PayerPhoneProofMethodEnum.options).toEqual(["sms_code", "campus_import"]);
  });

  it.each([["sms_code"], ["campus_import"]])("accepts method %s", (method) => {
    expect(def.payload.safeParse({ payer_id: PAYER, method }).success).toBe(true);
  });

  it("refuses an unknown method and a non-uuid payer", () => {
    expect(def.payload.safeParse({ payer_id: PAYER, method: "sms_otp" }).success).toBe(false);
    expect(def.payload.safeParse({ payer_id: "p1", method: "sms_code" }).success).toBe(false);
  });

  it.each([["phone"], ["phone_hash"], ["code"], ["phone_last4"]])(
    "refuses an extra %s key (strict)",
    (key) => {
      expect(
        def.payload.safeParse({ payer_id: PAYER, method: "sms_code", [key]: "x" }).success,
      ).toBe(false);
    },
  );
});
