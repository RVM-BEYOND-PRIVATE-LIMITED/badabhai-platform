import { describe, expect, it } from "vitest";
import { PayerLoginMethodEnum } from "./payloads";
import { getEventDefinition } from "./registry";

/**
 * #2754 items 1 and 2 — a company signs in with an SMS code. `sms_otp` lives only in the v2 login
 * events; v1 keeps its closed method set. The SMS path's daily ceiling has its own aggregate
 * event. Ids and enums only: the phone, its hash and the code never ride an event.
 */
const PAYER = "0f0e0d0c-0b0a-4908-8706-050403020100";

describe("the v1 login method set is unchanged", () => {
  it("still has exactly the four v1 methods, so v1 payloads refuse sms_otp", () => {
    expect(PayerLoginMethodEnum.options).toEqual(["email_otp", "whatsapp", "supabase", "password"]);
    const v1 = getEventDefinition("payer.session_started");
    expect(v1.payload.safeParse({ payer_id: PAYER, method: "sms_otp" }).success).toBe(false);
  });
});

describe.each([["payer.login_requested_v2"], ["payer.session_started_v2"]] as const)(
  "%s",
  (name) => {
    const def = getEventDefinition(name);

    it("is registered at version 2 in the payer domain", () => {
      expect(def.version).toBe(2);
      expect(def.domain).toBe("payer");
    });

    it.each([["sms_otp"], ["email_otp"], ["password"]])("accepts method %s", (method) => {
      expect(def.payload.safeParse({ payer_id: PAYER, method }).success).toBe(true);
    });

    it("refuses a method it does not know", () => {
      expect(def.payload.safeParse({ payer_id: PAYER, method: "voice" }).success).toBe(false);
    });

    it.each([["phone"], ["phone_hash"], ["code"]])("refuses an extra %s key (strict)", (key) => {
      expect(
        def.payload.safeParse({ payer_id: PAYER, method: "sms_otp", [key]: "x" }).success,
      ).toBe(false);
    });
  },
);

describe("payer.sms_send_cap_exceeded v1", () => {
  const def = getEventDefinition("payer.sms_send_cap_exceeded");
  const VALID = { cap: "global_daily", limit: 500, window: "20261115" };

  it("is registered at version 1 in the payer domain, and takes the aggregate facts", () => {
    expect(def.version).toBe(1);
    expect(def.domain).toBe("payer");
    expect(def.payload.safeParse(VALID).success).toBe(true);
    expect(def.payload.safeParse({ ...VALID, limit: 0 }).success).toBe(true);
  });

  it("refuses an account handle or a non-day window", () => {
    expect(def.payload.safeParse({ ...VALID, payer_id: PAYER }).success).toBe(false);
    expect(def.payload.safeParse({ ...VALID, channel: "payer_sms" }).success).toBe(false);
    expect(def.payload.safeParse({ ...VALID, window: "2026-11-15" }).success).toBe(false);
  });
});
