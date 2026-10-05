import { describe, expect, it } from "vitest";
import { mapPostingIssues } from "./posting-field-errors";

/**
 * #1912 — the server's validation 400 names a FIELD (snake_case) with a static reason; the
 * mapper routes each to the form's camelCase input so a refused `role_title` shows inline.
 */
describe("mapPostingIssues (#1912)", () => {
  it("maps the screened posting fields to the form's camelCase keys", () => {
    const { fieldErrors, rest } = mapPostingIssues([
      { path: "role_title", message: "remove contact details from the title" },
      { path: "description", message: "description must not contain links" },
      { path: "city", message: "remove contact details from the city" },
      { path: "pay_max", message: "too large" },
    ]);
    expect(fieldErrors).toEqual({
      roleTitle: "remove contact details from the title",
      description: "description must not contain links",
      city: "remove contact details from the city",
      payMax: "too large",
    });
    expect(rest).toEqual([]);
  });

  it("collapses a chip-array path (requirements.0) onto its list field", () => {
    const { fieldErrors } = mapPostingIssues([
      { path: "requirements.0", message: "requirements must not contain a company name" },
    ]);
    expect(fieldErrors.requirements).toBe("requirements must not contain a company name");
  });

  it("keeps the FIRST message per field and separates unmapped paths", () => {
    const { fieldErrors, rest } = mapPostingIssues([
      { path: "role_title", message: "first" },
      { path: "role_title", message: "second" },
      { path: "match_skill_ids", message: "pick at least one skill" },
    ]);
    expect(fieldErrors.roleTitle).toBe("first");
    expect(rest).toEqual(["pick at least one skill"]);
  });
});
