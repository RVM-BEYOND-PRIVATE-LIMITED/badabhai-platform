import { describe, expect, it } from "vitest";
import {
  DUPLICATE_ADMIN,
  INVALID_DETAILS,
  RECORD_CHANGED,
  RECORD_GONE,
  SAFE_ACTION_ERROR,
  SERVICE_UNAVAILABLE,
  SESSION_ENDED,
  adminActionErrorCopy,
} from "./admin-action-messages";

/**
 * #2689 rule 3 — one catalogue for every admin action. The raw API text, status and exception
 * strings are LOOKUP INPUTS only; an unknown code must get safe copy, never the input back.
 */
describe("adminActionErrorCopy", () => {
  it("maps a known code before the raw message", () => {
    expect(
      adminActionErrorCopy({
        status: 401,
        code: "unauthorized",
        message: "jwt expired at /srv/app/auth.ts:22",
      }),
    ).toBe(SESSION_ENDED);
  });

  it("maps a known status when there is no code", () => {
    expect(adminActionErrorCopy({ status: 404, message: "Payer not found" })).toBe(RECORD_GONE);
    expect(adminActionErrorCopy({ status: 409, message: "conflict happened" })).toBe(
      RECORD_CHANGED,
    );
    expect(adminActionErrorCopy({ status: 400, message: "Validation failed" })).toBe(
      INVALID_DETAILS,
    );
  });

  it("maps a recognisable refusal's MEANING, never its text", () => {
    const copy = adminActionErrorCopy({
      status: 409,
      message: "An admin with that email already exists",
    });
    expect(copy).toBe(DUPLICATE_ADMIN);
  });

  it("an unknown code and unknown message get the safe generic line, never raw text", () => {
    const raw = "Error 418: teapot at /srv/internal/admin.ts:88";
    const copy = adminActionErrorCopy({ status: 418, code: "brand_new_code", message: raw });
    expect(copy).toBe(SAFE_ACTION_ERROR);
    expect(copy).not.toContain(raw);
    expect(copy).not.toContain("418");
    expect(copy).not.toContain("/srv/internal");
  });

  it("a 5xx or transport failure always collapses, even when its text looks like a known rule", () => {
    for (const status of [0, 500, 502, 503]) {
      const copy = adminActionErrorCopy({
        status,
        message: "relation admin_users does not exist\n    at PostgresQueryRunner.query (/srv/app)",
      });
      expect(copy).toBe(SERVICE_UNAVAILABLE);
      expect(copy).not.toContain("admin_users");
      expect(copy).not.toContain("/srv/app");
    }
  });

  it("every fallback is a sentence, never a bare status or exception", () => {
    for (const status of [400, 401, 403, 404, 409, 418, 429, 500, 0]) {
      const copy = adminActionErrorCopy({ status, message: "raw" });
      expect(copy.length).toBeGreaterThan(20);
      expect(copy).not.toMatch(/^Error\b/);
      expect(copy).not.toMatch(/^\d{3}$/);
    }
  });
});
