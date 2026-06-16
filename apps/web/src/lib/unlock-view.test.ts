import { describe, it, expect } from "vitest";
import type { UnlockResult, RevealResult } from "./api";
import {
  mapUnlockResult,
  mapRevealResult,
  NEUTRAL_UNAVAILABLE_MESSAGE,
  NEUTRAL_REVEAL_UNAVAILABLE_MESSAGE,
  isUuid,
} from "./unlock-view";

/**
 * Security-critical tests for the NO-ORACLE mapping (ADR-0010, F-1/F-3).
 *
 * The whole point: the UI mapper CANNOT distinguish WHY an unlock was
 * "unavailable". The API collapses no-consent / capped / insufficient-credits /
 * unknown-worker / already-unlocked into ONE byte-identical
 * `{ status: "unavailable" }`, so the mapper has only that one shape to act on —
 * and must produce one identical view for all of them.
 */

// All of these are the SAME wire shape the API returns for EVERY failure cause.
// We name them by the (hidden) scenario only to make the assertion intent clear;
// the inputs are intentionally indistinguishable.
const cappedResponse: UnlockResult = { status: "unavailable" };
const consentAbsentResponse: UnlockResult = { status: "unavailable" };
const noCreditsResponse: UnlockResult = { status: "unavailable" };

describe("mapUnlockResult — no-oracle", () => {
  it("maps a granted unlock to the granted view", () => {
    const view = mapUnlockResult({
      ok: true,
      unlock_id: "11111111-1111-4111-8111-111111111111",
      status: "granted",
      expires_at: "2026-07-01T00:00:00.000Z",
    });
    expect(view).toEqual({
      kind: "granted",
      unlockId: "11111111-1111-4111-8111-111111111111",
      expiresAt: "2026-07-01T00:00:00.000Z",
    });
  });

  it("maps capped to the single neutral state", () => {
    expect(mapUnlockResult(cappedResponse)).toEqual({
      kind: "unavailable",
      message: NEUTRAL_UNAVAILABLE_MESSAGE,
    });
  });

  it("maps consent-absent to the single neutral state", () => {
    expect(mapUnlockResult(consentAbsentResponse)).toEqual({
      kind: "unavailable",
      message: NEUTRAL_UNAVAILABLE_MESSAGE,
    });
  });

  it("maps no-credits to the single neutral state", () => {
    expect(mapUnlockResult(noCreditsResponse)).toEqual({
      kind: "unavailable",
      message: NEUTRAL_UNAVAILABLE_MESSAGE,
    });
  });

  it("produces IDENTICAL output for capped, consent-absent, and no-credits (cannot distinguish)", () => {
    const a = mapUnlockResult(cappedResponse);
    const b = mapUnlockResult(consentAbsentResponse);
    const c = mapUnlockResult(noCreditsResponse);
    expect(a).toEqual(b);
    expect(b).toEqual(c);
    // Stronger: byte-identical serialization — no hidden cause field anywhere.
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(b)).toBe(JSON.stringify(c));
  });

  it("the neutral message does not name any specific cause as the actual reason", () => {
    // It may EXPLAIN that causes are indistinguishable, but must not assert which one occurred.
    expect(NEUTRAL_UNAVAILABLE_MESSAGE).toContain("does not disclose the reason");
  });
});

describe("mapRevealResult", () => {
  it("maps a reveal handle to the handle view (relay handle, channel, expiry — no phone)", () => {
    const result: RevealResult = {
      relay_handle: "relay_abc123",
      channel: "in_app_relay",
      expires_at: "2026-07-01T00:00:00.000Z",
    };
    expect(mapRevealResult(result)).toEqual({
      kind: "handle",
      relayHandle: "relay_abc123",
      channel: "in_app_relay",
      expiresAt: "2026-07-01T00:00:00.000Z",
    });
  });

  it("maps proxy_number channel through unchanged", () => {
    const result: RevealResult = {
      relay_handle: "+proxy-token-xyz",
      channel: "proxy_number",
      expires_at: "2026-07-01T00:00:00.000Z",
    };
    const view = mapRevealResult(result);
    expect(view.kind).toBe("handle");
    if (view.kind === "handle") expect(view.channel).toBe("proxy_number");
  });

  it("maps an unavailable reveal to the neutral state", () => {
    expect(mapRevealResult({ status: "unavailable" })).toEqual({
      kind: "unavailable",
      message: NEUTRAL_REVEAL_UNAVAILABLE_MESSAGE,
    });
  });
});

describe("isUuid", () => {
  it("accepts a v4-shaped uuid", () => {
    expect(isUuid("00000000-0000-4000-8000-000000000001")).toBe(true);
  });
  it("rejects garbage / empty", () => {
    expect(isUuid("not-a-uuid")).toBe(false);
    expect(isUuid("")).toBe(false);
  });
});
