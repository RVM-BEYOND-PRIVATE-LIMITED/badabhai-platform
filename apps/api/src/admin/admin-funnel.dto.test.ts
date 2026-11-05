import { describe, expect, it } from "vitest";
import { AdminFunnelQuerySchema } from "./admin-funnel.dto";

/**
 * The funnel query contract — what narrows the cohort, and what the defaults are.
 */
describe("AdminFunnelQuerySchema", () => {
  it("defaults to the whole base with test traffic excluded", () => {
    expect(AdminFunnelQuerySchema.parse({})).toEqual({
      testAccounts: "exclude",
    });
  });

  it("accepts a sign-up window and an explicit test-account policy", () => {
    const parsed = AdminFunnelQuerySchema.parse({
      signupFrom: "2026-09-01T00:00:00.000Z",
      signupTo: "2026-10-01T00:00:00.000Z",
      testAccounts: "include",
    });
    expect(parsed.signupFrom).toEqual(new Date("2026-09-01T00:00:00.000Z"));
    expect(parsed.signupTo).toEqual(new Date("2026-10-01T00:00:00.000Z"));
    expect(parsed.testAccounts).toBe("include");
  });

  it("rejects an inverted window (a silent empty cohort is a silent zero funnel)", () => {
    expect(() =>
      AdminFunnelQuerySchema.parse({
        signupFrom: "2026-10-01T00:00:00.000Z",
        signupTo: "2026-09-01T00:00:00.000Z",
      }),
    ).toThrow();
  });

  it("rejects an unknown test-account policy and unknown keys", () => {
    expect(() => AdminFunnelQuerySchema.parse({ testAccounts: "sometimes" })).toThrow();
    expect(() => AdminFunnelQuerySchema.parse({ limit: 10 })).toThrow();
  });
});
