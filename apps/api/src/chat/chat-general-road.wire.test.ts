/**
 * The general road's two chat response fields (ADR-0045) — `gate_kind` and `general_form_offer`.
 *
 * WHY THEY ARE `.optional()` AND NOT `.nullable().default(null)` like every earlier extension:
 * with the flag off every response must be BYTE-IDENTICAL to today's, so the keys are absent, not
 * null. That is also why this file exists — nothing else would stop a later "tidy-up" to the
 * defaulted form, which would add two `null` keys to every chat response in production.
 */
import { describe, expect, it } from "vitest";

import { PostMessageResponseSchema } from "./chat.dto";

/** A body with only the keys a server predating the general road would have sent. */
function legacyBody(over: Record<string, unknown> = {}) {
  return {
    session_id: "11111111-1111-4111-8111-111111111111",
    reply: "Aap kaun sa kaam karte hain?",
    blocked: false,
    is_mock: false,
    ...over,
  };
}

describe("chat wire — the general road's fields are ABSENT unless set", () => {
  it("a legacy body parses and carries neither key", () => {
    const parsed = PostMessageResponseSchema.parse(legacyBody());
    expect(Object.prototype.hasOwnProperty.call(parsed, "gate_kind")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(parsed, "general_form_offer")).toBe(false);
  });

  it("refuses null for either — absent is the only 'not set'", () => {
    expect(() => PostMessageResponseSchema.parse(legacyBody({ gate_kind: null }))).toThrow();
    expect(() =>
      PostMessageResponseSchema.parse(legacyBody({ general_form_offer: null })),
    ).toThrow();
  });

  it("accepts the skills gate, and nothing outside the closed set", () => {
    expect(PostMessageResponseSchema.parse(legacyBody({ gate_kind: "skills" })).gate_kind).toBe(
      "skills",
    );
    expect(() =>
      PostMessageResponseSchema.parse(legacyBody({ gate_kind: "experience" })),
    ).toThrow();
  });

  it("accepts the general-form card, which needs both its headline and its button label", () => {
    const card = { headline: "Ab kuch aur jaankari", cta_label: "Form bharein" };
    expect(
      PostMessageResponseSchema.parse(legacyBody({ general_form_offer: card })).general_form_offer,
    ).toEqual(card);
    expect(() =>
      PostMessageResponseSchema.parse(legacyBody({ general_form_offer: { headline: "x" } })),
    ).toThrow();
  });

  it("leaves the trade-form card untouched — it is a separate field", () => {
    const parsed = PostMessageResponseSchema.parse(legacyBody());
    expect(parsed.form_offer).toBeNull();
  });
});
