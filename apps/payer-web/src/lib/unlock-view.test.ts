import { describe, expect, it } from "vitest";
import type { MaskedResumeResult, RevealResult, UnlockResult } from "./contracts";
import {
  NEUTRAL_CONTACT_MESSAGE,
  NEUTRAL_REVEAL_MESSAGE,
  NEUTRAL_UNLOCK_MESSAGE,
  mapContactResult,
  mapRevealResult,
  mapUnlockResult,
} from "./unlock-view";

describe("unlock-view (no-oracle, XB-C)", () => {
  it("maps a granted unlock to the granted view", () => {
    const r: UnlockResult = {
      ok: true,
      unlockId: "11111111-1111-4111-8111-111111111111",
      status: "granted",
      expiresAt: "2026-07-01T00:00:00.000Z",
    };
    const v = mapUnlockResult(r);
    expect(v.kind).toBe("granted");
  });

  it("maps the neutral unlock body to the SINGLE unavailable view", () => {
    const v = mapUnlockResult({ status: "unavailable" });
    expect(v).toEqual({ kind: "unavailable", message: NEUTRAL_UNLOCK_MESSAGE });
  });

  it("the neutral view carries no cause-distinguishing field", () => {
    const v = mapUnlockResult({ status: "unavailable" });
    // Only kind + message — nothing that could hint at the deny cause.
    expect(Object.keys(v).sort()).toEqual(["kind", "message"]);
  });

  it("maps a disclosed masked resume to the masked view (masked link only, no name/phone)", () => {
    const r: MaskedResumeResult = {
      ok: true,
      disclosureId: "22222222-2222-4222-8222-222222222222",
      status: "disclosed",
      resumeUrl: "https://staging.example/masked.pdf",
      expiresAt: "2026-07-01T00:00:00.000Z",
    };
    const v = mapRevealResult(r);
    expect(v.kind).toBe("masked");
    if (v.kind === "masked") {
      expect(v.resumeUrl).toBe("https://staging.example/masked.pdf");
      // The view shape has NO name/initials/phone field at all — only the masked link + expiry.
      expect(Object.keys(v).sort()).toEqual(["disclosureId", "expiresAt", "kind", "resumeUrl"]);
      expect(JSON.stringify(v)).not.toMatch(/displayInitials|name|phone|employer/i);
    }
  });

  it("maps the neutral reveal body to the single unavailable view", () => {
    const v = mapRevealResult({ status: "unavailable" });
    expect(v).toEqual({ kind: "unavailable", message: NEUTRAL_REVEAL_MESSAGE });
  });
});

describe("contact reveal (LIVE routed handle — NO RAW PHONE, ADR-0010 F-4 / XB-E)", () => {
  it("maps a routed reveal to the routed view — relay handle only, no phone field", () => {
    const r: RevealResult = {
      relay_handle: "relay_abc123opaque",
      channel: "in_app_relay",
      expires_at: "2026-07-01T00:00:00.000Z",
    };
    const v = mapContactResult(r);
    expect(v.kind).toBe("routed");
    if (v.kind === "routed") {
      // The view shape exposes ONLY the opaque relay handle, channel, and expiry —
      // there is structurally NO phone/number/name field that could leak raw PII.
      expect(Object.keys(v).sort()).toEqual(["channel", "expiresAt", "kind", "relayHandle"]);
      // The handle must not look like an Indian phone number / a raw digit run.
      expect(/\+?\d{7,}/.test(v.relayHandle)).toBe(false);
    }
  });

  it("rejects (parse-fails) any reveal wire body that carries a phone-like field", async () => {
    const { revealResultSchema } = await import("./contracts");
    // A wire body smuggling a raw phone is NOT a valid RevealResult — the union only
    // admits the routed handle or the neutral body; extra keys are stripped by Zod and
    // a `phone`-only body matches NEITHER branch.
    const smuggled = revealResultSchema.safeParse({ phone: "+919876543210" });
    expect(smuggled.success).toBe(false);
  });

  it("maps the neutral reveal body to the single unavailable view", () => {
    const v = mapContactResult({ status: "unavailable" });
    expect(v).toEqual({ kind: "unavailable", message: NEUTRAL_CONTACT_MESSAGE });
  });
});
