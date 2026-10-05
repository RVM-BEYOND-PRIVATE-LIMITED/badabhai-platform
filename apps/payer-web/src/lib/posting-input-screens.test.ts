import { describe, expect, it } from "vitest";
import { createPostingInputSchema, updatePostingInputSchema } from "./contracts";

/**
 * #1912 — the backend screens `role_title` with the SAME three ADR-0024 heuristics as the
 * description (`looksLikePii` + `looksLikeOrgName` + `looksLikeUrl`); the client schema must
 * mirror it so a refused title is caught BEFORE submit, not surfaced as a generic server error.
 */
describe("roleTitle is screened like the rest of the worker-visible text (#1912)", () => {
  const CREATE_BASE = { roleTitle: "CNC Machinist", vacancies: 3 };

  it("refuses contact details in the role title", () => {
    const res = createPostingInputSchema.safeParse({ ...CREATE_BASE, roleTitle: "Call 9876543210" });
    expect(res.success).toBe(false);
  });

  it("refuses a company name in the role title", () => {
    const res = createPostingInputSchema.safeParse({
      ...CREATE_BASE,
      roleTitle: "Tata Steel Pvt Ltd operator",
    });
    expect(res.success).toBe(false);
  });

  it("refuses a link in the role title", () => {
    const res = createPostingInputSchema.safeParse({
      ...CREATE_BASE,
      roleTitle: "Apply at https://acme.example",
    });
    expect(res.success).toBe(false);
  });

  it("still accepts a legitimate role title", () => {
    expect(createPostingInputSchema.safeParse(CREATE_BASE).success).toBe(true);
    expect(createPostingInputSchema.safeParse({ ...CREATE_BASE, roleTitle: "MIG Welder" }).success).toBe(
      true,
    );
  });

  it("the edit schema screens the role title the same way", () => {
    expect(updatePostingInputSchema.safeParse({ roleTitle: "Call 9876543210" }).success).toBe(false);
    expect(
      updatePostingInputSchema.safeParse({ roleTitle: "Tata Steel Pvt Ltd" }).success,
    ).toBe(false);
    expect(updatePostingInputSchema.safeParse({ roleTitle: "CNC Machinist" }).success).toBe(true);
  });
});
