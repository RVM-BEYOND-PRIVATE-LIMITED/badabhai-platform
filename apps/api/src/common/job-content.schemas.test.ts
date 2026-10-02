import { describe, expect, it } from "vitest";
import { z } from "zod";

import { benefitsSchema, requirementsSchema, screenWorkerVisibleText } from "./job-content.schemas";

/**
 * THE ONE WORKER-VISIBLE FREE-TEXT SCREEN (ADR-0024; #1823 B3). Every worker-visible text
 * field on both demand surfaces runs through `screenWorkerVisibleText`, so these cases pin
 * the screen itself. The per-route matrices live in `agency.dto.test.ts` and
 * `job-postings.dto.test.ts`.
 */
const NAME = { from: "the widget", subject: "widget" } as const;
const screened = screenWorkerVisibleText(z.string().min(1).max(40), NAME);

const messages = (value: unknown): string[] => {
  const r = screened.safeParse(value);
  return r.success ? [] : r.error.issues.map((i) => i.message);
};

describe("screenWorkerVisibleText", () => {
  it.each([
    ["a phone number", "Call 98765 43210", "remove contact details from the widget"],
    ["an email", "hr@acme.example", "remove contact details from the widget"],
    ["a legal-entity name", "Acme Pvt Ltd", "widget must not contain a company name"],
    ["a link", "Apply at www.acme.in", "widget must not contain links"],
  ])("rejects %s with the field-naming message", (_label, value, message) => {
    expect(messages(value)).toEqual([message]);
  });

  it("reports EVERY screen a value trips, in pii → company → link order", () => {
    expect(messages("Acme Pvt Ltd 9876543210 acme.in")).toEqual([
      "remove contact details from the widget",
      "widget must not contain a company name",
      "widget must not contain links",
    ]);
  });

  it("never echoes the offending value in a message", () => {
    const value = "Sharma Pvt Ltd 9876543210";
    for (const m of messages(value)) {
      expect(m).not.toContain("Sharma");
      expect(m).not.toContain("9876543210");
    }
  });

  it("keeps the base shape: length caps still apply, and a clean value passes unchanged", () => {
    expect(screened.safeParse("").success).toBe(false);
    expect(screened.safeParse("x".repeat(41)).success).toBe(false);
    expect(screened.parse("CNC Operator — Night Shift")).toBe("CNC Operator — Night Shift");
  });

  it("keeps a trimming base trimming (the screen adds refines only)", () => {
    const trimmed = screenWorkerVisibleText(z.string().trim().min(1), NAME);
    expect(trimmed.parse("  Welder  ")).toBe("Welder");
  });

  it("the chip schemas run it with their shipped messages", () => {
    const chip = (s: z.ZodTypeAny, value: string) => {
      const r = s.safeParse([value]);
      return r.success ? [] : r.error.issues.map((i) => i.message);
    };
    expect(chip(benefitsSchema, "PF at Acme Pvt Ltd")).toEqual([
      "benefits must not contain a company name",
    ]);
    expect(chip(benefitsSchema, "Call 98765 43210")).toEqual([
      "remove contact details from benefits",
    ]);
    expect(chip(requirementsSchema, "see acme.com")).toEqual([
      "requirements must not contain links",
    ]);
    expect(chip(requirementsSchema, "Fanuc control")).toEqual([]);
  });
});
