import { describe, expect, it } from "vitest";
import { z } from "zod";

import { workerVisibleTextScreens } from "@badabhai/validators";

import {
  areaSchema,
  benefitsSchema,
  requirementsSchema,
  screenWorkerVisiblePlace,
  screenWorkerVisibleText,
  workerVisiblePlaceScreens,
} from "./job-content.schemas";

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
    const trimmed = screenWorkerVisibleText(z.string().trim().min(1).max(40), NAME);
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

  it("#1927: a bare suffix mid-sentence is a company name; posting prose using the words is not", () => {
    const description = screenWorkerVisibleText(z.string().min(1).max(500), NAME);
    const issues = (value: string): string[] => {
      const r = description.safeParse(value);
      return r.success ? [] : r.error.issues.map((i) => i.message);
    };
    expect(issues("Welder chahiye. Tata Steel Ltd mein apply kariye")).toEqual([
      "widget must not contain a company name",
    ]);
    expect(issues("Bharat Forge Limited mein fitter ki vacancy hai")).toEqual([
      "widget must not contain a company name",
    ]);
    expect(issues("Urgent requirement in a reputed Ltd company")).toEqual([]);
    expect(issues("Fresher Welder Limited Experience OK")).toEqual([]);
    expect(issues("Seats limited hain, jaldi apply kariye")).toEqual([]);
  });
});

/**
 * #1924 — the screen never runs on unbounded text. Zod 3 runs a refine after a failed
 * `.max()`, and the old email heuristic was quadratic: ~4.8 s on 100,000 characters, which
 * the JSON body limit alone admitted. A value over the base's cap is refused by the base and
 * not screened at all.
 */
describe("screenWorkerVisibleText — bounded by the base's .max() (#1924)", () => {
  const codes = (schema: z.ZodTypeAny, value: string): string[] => {
    const r = schema.safeParse(value);
    return r.success ? [] : r.error.issues.map((i) => i.code);
  };

  it("does not screen a value its base refused for length, and still refuses it", () => {
    // A phone number the screen would name, pushed one character over the cap: only the
    // base's own too_big issue comes back, so the heuristics never ran.
    const over = `Call 98765 43210 ${"x".repeat(40 - 16)}`;
    expect(over.length).toBe(41);
    expect(codes(screened, over)).toEqual(["too_big"]);
  });

  it("still screens a value at exactly the cap", () => {
    const atCap = `Call 98765 43210 ${"x".repeat(40 - 17)}`;
    expect(atCap.length).toBe(40);
    expect(messages(atCap)).toEqual(["remove contact details from the widget"]);
  });

  it("measures the cap after a trimming base trims, as the base does", () => {
    const trimmed = screenWorkerVisibleText(z.string().trim().min(1).max(40), NAME);
    const atCap = `Call 98765 43210 ${"x".repeat(40 - 17)}`;
    expect(codes(trimmed, `   ${atCap}   `)).toEqual(["custom"]);
  });

  it("refuses to build on a base with no .max(), or one that case-transforms", () => {
    expect(() => screenWorkerVisibleText(z.string().min(1), NAME)).toThrow(/needs a \.max\(\)/);
    // "ß" passes .max(5) four times over, then upper-cases to eight characters.
    expect(() => screenWorkerVisibleText(z.string().max(5).toUpperCase(), NAME)).toThrow(
      /case-transform/,
    );
    expect(() => screenWorkerVisibleText(z.string().toLowerCase().max(5), NAME)).toThrow(
      /case-transform/,
    );
  });

  it("refuses 100,000 hostile characters in well under the old cost", () => {
    // A run with no whitespace or "@" was the measured worst case: ~4.8 s per screen before
    // #1924. Both fixes make it about a millisecond. The structural test above is the guard;
    // this generous bound is the backstop, still ~10x under the old cost.
    const hostile = "a".repeat(100_000);
    const started = performance.now();
    expect(codes(screened, hostile)).toEqual(["too_big"]);
    expect(performance.now() - started).toBeLessThan(500);
  });
});

/**
 * THE PLACE SCREEN (#1848): the same three heuristics as every other worker-visible field,
 * with one waiver. `looksLikePii` strips spaces and dashes before counting digits, so a
 * sector, phase or plot number followed by a pincode read as a seven-plus digit phone run.
 * The waiver lifts the contact-details refusal ONLY when the value has fewer than ten digits,
 * holds a standalone six-digit pincode, and passes `looksLikePii` without it.
 */
describe("workerVisiblePlaceScreens / screenWorkerVisiblePlace (#1848)", () => {
  const PLACE = { from: "the city", subject: "city" } as const;
  const place = screenWorkerVisiblePlace(z.string().min(1).max(120), PLACE);
  const placeMessages = (value: string): string[] => {
    const r = place.safeParse(value);
    return r.success ? [] : r.error.issues.map((i) => i.message);
  };

  it.each([
    "Sector 63 201301",
    "Sector 63 - 201301",
    "Phase 2 411026",
    "MIDC Phase 2 411026",
    "Plot 7 411026",
  ])("accepts the measured real locality %j that the plain screen refuses", (value) => {
    // Each is refused by the plain screen: the waiver is what this test pins.
    expect(workerVisibleTextScreens(value)).toEqual(["contact_details"]);
    expect(workerVisiblePlaceScreens(value)).toEqual([]);
    expect(placeMessages(value)).toEqual([]);
  });

  it.each([
    ["a ten-digit mobile", "Pune 9876543210"],
    ["a spaced mobile", "Pune 98765 43210"],
    ["a mobile hidden next to a pincode", "411026 9876543210"],
    // Split 6 + 4, the mobile's first six digits ARE a pincode-shaped token, and removing it
    // leaves no seven-digit run. Only the under-ten-digits rule refuses it.
    ["a mobile split six + four", "Pune 987654 3210"],
    ["a pincode then a mobile, dash-joined", "Bhosari 411026-98765-43210"],
    ["an eleven-digit landline", "Bhosari 020 2712 3456"],
    ["a seven-digit run with no pincode token", "Sector 1234567"],
  ])("still refuses %s as contact details", (_label, value) => {
    expect(placeMessages(value)).toEqual(["remove contact details from the city"]);
  });

  it("still refuses an email, even beside a pincode", () => {
    expect(placeMessages("hr@acme.example")).toEqual(["remove contact details from the city"]);
    expect(placeMessages("Pune 411018 hr@acme.example")).toEqual([
      "remove contact details from the city",
    ]);
  });

  it("leaves the company-name and link screens untouched, pincode or not", () => {
    expect(placeMessages("Kalyani Pvt Ltd 411026")).toEqual([
      "city must not contain a company name",
    ]);
    expect(placeMessages("www.acme.in 411026")).toEqual(["city must not contain links"]);
    expect(placeMessages("Sector 63 201301 acme.in")).toEqual(["city must not contain links"]);
  });

  it("waives contact details only: a value that also trips another screen keeps that one", () => {
    expect(workerVisiblePlaceScreens("Sector 63 201301 Acme Pvt Ltd")).toEqual(["company_name"]);
  });

  it("dotted co-op names stay refused as a company name (an accepted false positive)", () => {
    // The hyphenated and plain forms pass. The dotted forms are `looksLikeOrgName`'s to
    // narrow, in @badabhai/validators, not this screen's to waive.
    expect(placeMessages("Gokul Shirgaon Co-op Industrial Estate")).toEqual([]);
    expect(placeMessages("Vasai Co-operative Industrial Estate")).toEqual([]);
    expect(placeMessages("Vasai Co. Operative Industrial Estate")).toEqual([
      "city must not contain a company name",
    ]);
  });

  it("keeps the build-time guards and the base shape", () => {
    expect(() => screenWorkerVisiblePlace(z.string().min(1), PLACE)).toThrow(/needs a \.max\(\)/);
    const trimmed = screenWorkerVisiblePlace(z.string().trim().min(1).max(80), PLACE);
    expect(trimmed.parse("  Chakan  ")).toBe("Chakan");
    expect(place.safeParse("").success).toBe(false);
    expect(place.safeParse("x".repeat(121)).success).toBe(false);
  });

  it("areaSchema is the place screen with the area's own messages", () => {
    const areaMessages = (value: string): string[] => {
      const r = areaSchema.safeParse(value);
      return r.success ? [] : r.error.issues.map((i) => i.message);
    };
    expect(areaMessages("Call 98765 43210")).toEqual(["remove contact details from the area"]);
    expect(areaMessages("Acme Pvt Ltd")).toEqual(["area must not contain a company name"]);
    expect(areaMessages("acme.in")).toEqual(["area must not contain links"]);
    expect(areaMessages("Phase 2 411026")).toEqual([]);
  });
});
