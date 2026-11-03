import { describe, it, expect } from "vitest";
import { meSecuritySchema, toAccountSecurity } from "./account";

/**
 * The Account page's read of `GET /admin/me` (ADR-0060). The three fields are ADDITIVE on the
 * API, so their absence must read as "not reported" (null), never as a guessed false — the page
 * would otherwise tell an admin with a password to "set" one, or one with MFA on that it is off.
 */
const parse = (raw: unknown) => toAccountSecurity(meSecuritySchema.parse(raw));

describe("readAccountSecurity's parsing", () => {
  it("reads the three fields from a current API", () => {
    expect(
      parse({
        admin_id: "a-1",
        role: "ops_admin",
        capabilities: [],
        has_password: true,
        must_change_password: false,
        mfa_enabled: true,
      }),
    ).toEqual({ hasPassword: true, mustChangePassword: false, mfaEnabled: true });
  });

  it("an older API (fields absent) is 'not reported', never a guessed false", () => {
    expect(parse({ admin_id: "a-1", role: "ops_admin", capabilities: [] })).toEqual({
      hasPassword: null,
      mustChangePassword: false,
      mfaEnabled: null,
    });
  });

  it("a temporary password is flagged", () => {
    expect(parse({ has_password: true, must_change_password: true, mfa_enabled: false })).toEqual({
      hasPassword: true,
      mustChangePassword: true,
      mfaEnabled: false,
    });
  });

  it("a wrongly-typed field fails the read rather than being coerced", () => {
    expect(meSecuritySchema.safeParse({ has_password: "yes" }).success).toBe(false);
  });
});
