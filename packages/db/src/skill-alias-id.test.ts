import { describe, expect, it } from "vitest";

import { deterministicAliasId } from "./skill-alias-id";

// The idempotency mechanism for seed:skills (double-run row parity, ADR-0030 / TAX-2):
// a stable id per (skill_id, text, lang) → ON CONFLICT (id) DO NOTHING is a no-op on re-run.
describe("deterministicAliasId — the seed:skills idempotency key", () => {
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/;

  it("is stable: same identity → same id (so a re-run inserts nothing new)", () => {
    const a = deterministicAliasId("skill_milling", "CNC milling", "en");
    const b = deterministicAliasId("skill_milling", "CNC milling", "en");
    expect(a).toBe(b);
    expect(a).toMatch(UUID_RE);
  });

  it("is distinct across text, skill, and lang", () => {
    const base = deterministicAliasId("skill_milling", "CNC milling", "en");
    expect(deterministicAliasId("skill_milling", "milling", "en")).not.toBe(base); // text
    expect(deterministicAliasId("skill_turning", "CNC milling", "en")).not.toBe(base); // skill
    expect(deterministicAliasId("skill_milling", "CNC milling", "hi")).not.toBe(base); // lang
  });

  it("treats a null lang as stable (not the same as empty-string collisions)", () => {
    const n1 = deterministicAliasId("skill_x", "welding", null);
    const n2 = deterministicAliasId("skill_x", "welding", null);
    expect(n1).toBe(n2);
    expect(n1).toMatch(UUID_RE);
  });
});
