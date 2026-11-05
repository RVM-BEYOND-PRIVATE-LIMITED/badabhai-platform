import { describe, it, expect } from "vitest";
import { describeAdminActionError } from "./describe-admin-error";
import {
  AdminForbiddenError,
  AdminRequestError,
  AdminUnauthorizedError,
} from "./admin-http";
import {
  DUPLICATE_ADMIN,
  INVALID_DETAILS,
  RECORD_CHANGED,
  RECORD_GONE,
  SAFE_ACTION_ERROR,
  SERVICE_UNAVAILABLE,
  SESSION_ENDED,
} from "./admin-action-messages";

/**
 * `describeAdminActionError` is the ONE place a governed admin mutation decides what the
 * operator sees. Every refusal goes through the copy catalogue (#2689): known refusals get a
 * specific sentence, unknown ones get a safe generic line. The API's raw text never renders.
 */
describe("describeAdminActionError", () => {
  it("maps the last-active-super-admin conflict to catalogue copy", () => {
    const err = new AdminRequestError(409, "Cannot demote the last active super_admin");
    expect(describeAdminActionError(err)).toBe(
      "You can't remove the last active super admin. Give another admin that role first.",
    );
    expect(describeAdminActionError(err)).not.toContain("Cannot demote");
  });

  it("maps a not-found refusal to the record-gone copy", () => {
    expect(describeAdminActionError(new AdminRequestError(404, "Payer not found"))).toBe(
      RECORD_GONE,
    );
  });

  it("maps a generic 400 to the validation copy, not the server's text", () => {
    expect(
      describeAdminActionError(new AdminRequestError(400, "Validation failed")),
    ).toBe(INVALID_DETAILS);
  });

  it("maps a duplicate-email conflict to its own sentence", () => {
    expect(
      describeAdminActionError(
        new AdminRequestError(409, "An admin with that email already exists"),
      ),
    ).toBe(DUPLICATE_ADMIN);
  });

  it("collapses a 5xx to one generic, safe message — never the backend's own text", () => {
    const err = new AdminRequestError(500, "internal detail nobody should see");
    expect(describeAdminActionError(err)).not.toContain("internal detail");
    expect(describeAdminActionError(err)).toBe(SERVICE_UNAVAILABLE);
  });

  it("collapses a transport failure (status 0) the same way", () => {
    const err = new AdminRequestError(0, "The admin API is unreachable.");
    expect(describeAdminActionError(err)).toBe(SERVICE_UNAVAILABLE);
  });

  it("uses a known server code before the raw message", () => {
    const err = new AdminRequestError(409, "raw text that must not render", {
      code: "last_active_super_admin",
    });
    expect(describeAdminActionError(err)).toBe(
      "You can't remove the last active super admin. Give another admin that role first.",
    );
  });

  it("an unknown code and unknown message get the safe generic line", () => {
    const err = new AdminRequestError(418, "Error 418: teapot at /srv/internal", {
      code: "new_code_this_build_does_not_know",
    });
    expect(describeAdminActionError(err)).toBe(SAFE_ACTION_ERROR);
    expect(describeAdminActionError(err)).not.toContain("418");
    expect(describeAdminActionError(err)).not.toContain("/srv/internal");
  });

  it("maps a stale conflict to the record-changed copy", () => {
    expect(
      describeAdminActionError(
        new AdminRequestError(409, "stale_expected_status: expected pending"),
      ),
    ).toBe(RECORD_CHANGED);
  });

  it("a dead session gets its own copy, not the generic one", () => {
    expect(describeAdminActionError(new AdminUnauthorizedError())).toBe(SESSION_ENDED);
  });

  it("a role that no longer holds the capability gets its own copy", () => {
    expect(describeAdminActionError(new AdminForbiddenError())).toMatch(/permission/);
  });

  it("an unrecognised thrown value falls back to the generic message", () => {
    expect(describeAdminActionError(new Error("something else"))).toBe(SAFE_ACTION_ERROR);
    expect(describeAdminActionError("not even an Error")).toBe(SAFE_ACTION_ERROR);
  });
});
