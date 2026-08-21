import { describe, it, expect } from "vitest";
import { describeAdminActionError } from "./describe-admin-error";
import {
  AdminForbiddenError,
  AdminRequestError,
  AdminUnauthorizedError,
} from "./admin-http";

/**
 * `describeAdminActionError` is the ONE place a governed admin mutation decides what the
 * operator sees. The property that matters: a real, specific backend refusal (409/404/400)
 * is shown VERBATIM — that is what makes "surface the last-active-super_admin / self-suspend
 * rejection text" (the admins-directory self-guard requirement) true — while a transport
 * failure or a 5xx collapses to one safe, generic message rather than whatever an internal
 * error happened to say.
 */
describe("describeAdminActionError", () => {
  it("shows a 409's message verbatim — the server's own business-conflict explanation", () => {
    const err = new AdminRequestError(409, "Cannot demote the last active super_admin");
    expect(describeAdminActionError(err)).toBe("Cannot demote the last active super_admin");
  });

  it("shows a 404's message verbatim", () => {
    const err = new AdminRequestError(404, "Payer not found");
    expect(describeAdminActionError(err)).toBe("Payer not found");
  });

  it("shows a 400's message verbatim", () => {
    const err = new AdminRequestError(400, "Validation failed");
    expect(describeAdminActionError(err)).toBe("Validation failed");
  });

  it("collapses a 5xx to one generic, safe message — never the backend's own text", () => {
    const err = new AdminRequestError(500, "internal detail nobody should see");
    expect(describeAdminActionError(err)).not.toContain("internal detail");
    expect(describeAdminActionError(err)).toBe(
      "The admin API is unreachable or returned an error. Try again.",
    );
  });

  it("collapses a transport failure (status 0) the same way", () => {
    const err = new AdminRequestError(0, "The admin API is unreachable.");
    expect(describeAdminActionError(err)).toBe(
      "The admin API is unreachable or returned an error. Try again.",
    );
  });

  it("a dead session gets its own copy, not the generic one", () => {
    expect(describeAdminActionError(new AdminUnauthorizedError())).toMatch(/sign in again/);
  });

  it("a role that no longer holds the capability gets its own copy", () => {
    expect(describeAdminActionError(new AdminForbiddenError())).toMatch(/permission/);
  });

  it("an unrecognised thrown value falls back to the generic message", () => {
    expect(describeAdminActionError(new Error("something else"))).toBe(
      "The admin API is unreachable or returned an error. Try again.",
    );
    expect(describeAdminActionError("not even an Error")).toBe(
      "The admin API is unreachable or returned an error. Try again.",
    );
  });
});
