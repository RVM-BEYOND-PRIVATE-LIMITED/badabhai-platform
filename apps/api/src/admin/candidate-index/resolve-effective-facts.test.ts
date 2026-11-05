import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { applyEffectiveFacts, resolveEffectiveFacts } from "./resolve-effective-facts";

describe("resolveEffectiveFacts seam (B4, #2557 — overlay lands in #2561)", () => {
  it("resolves no overrides while the correction layer does not exist", async () => {
    await expect(resolveEffectiveFacts("11111111-1111-4111-8111-111111111111")).resolves.toEqual(
      new Map(),
    );
  });

  it("is identity on empty overrides (base values flow through unchanged)", () => {
    const inputs = { workersCity: "Pune", attributes: { a: 1 } };
    expect(applyEffectiveFacts(inputs, new Map())).toBe(inputs);
  });

  it("fails CLOSED on an unknown override key — #2561 must handle each fact key explicitly", () => {
    expect(() =>
      applyEffectiveFacts({ workersCity: null }, new Map([["current_city", "Mumbai"]])),
    ).toThrow(/extend applyEffectiveFacts in #2561/);
  });
});
