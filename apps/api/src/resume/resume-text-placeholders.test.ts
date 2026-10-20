import { describe, expect, it } from "vitest";

import { RESUME_PLACEHOLDER_VALUE, withoutPlaceholderRows } from "./resume-text-placeholders";

/**
 * #2378 — a résumé stored before the builders stopped printing "(to be confirmed)" is served
 * without those rows. The shape below is a real pre-fix `build_resume` body with the name line.
 */
describe("withoutPlaceholderRows", () => {
  const stored = [
    "Ramesh Kumar",
    "WORKER PROFILE (DRAFT)",
    "",
    "Role: Senior Application Engineer",
    "Trade: (to be confirmed)",
    "Experience: 4 years",
    "Machines: (to be confirmed)",
    "Skills: React, Node.js, PostgreSQL",
    "Current location: Pune",
  ].join("\n");

  it("drops every row whose value is the placeholder", () => {
    const out = withoutPlaceholderRows(stored);
    expect(out).not.toContain(RESUME_PLACEHOLDER_VALUE);
    expect(out).not.toContain("Trade:");
    expect(out).not.toContain("Machines:");
  });

  it("keeps every other line byte-identical and in order", () => {
    expect(withoutPlaceholderRows(stored)).toBe(
      [
        "Ramesh Kumar",
        "WORKER PROFILE (DRAFT)",
        "",
        "Role: Senior Application Engineer",
        "Experience: 4 years",
        "Skills: React, Node.js, PostgreSQL",
        "Current location: Pune",
      ].join("\n"),
    );
  });

  it("drops a placeholder row however it is padded", () => {
    expect(withoutPlaceholderRows("Role:   (to be confirmed)  \r\nExperience: 3 years")).toBe(
      "Experience: 3 years",
    );
  });

  it("never touches a real value that only contains the phrase", () => {
    const text = "Skills: welding (to be confirmed by employer)\nWork history: Cook — (to be confirmed)x";
    expect(withoutPlaceholderRows(text)).toBe(text);
  });

  it("never touches a line with no label", () => {
    expect(withoutPlaceholderRows("(to be confirmed)")).toBe("(to be confirmed)");
    expect(withoutPlaceholderRows(": (to be confirmed)")).toBe(": (to be confirmed)");
  });

  it("returns a clean résumé unchanged", () => {
    const clean = "WORKER PROFILE (DRAFT)\n\nRole: Fitter\nExperience: 3 years";
    expect(withoutPlaceholderRows(clean)).toBe(clean);
  });
});
