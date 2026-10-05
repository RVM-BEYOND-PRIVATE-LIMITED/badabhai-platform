import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import {
  ADMIN_PII_REVEAL_NOTE_MAX,
  AdminPiiRevealParamsSchema,
  AdminPiiRevealSchema,
  noteHasResidualPii,
} from "./admin-pii-reveal.dto";

/**
 * DTO control tests for ADMIN-3b (ADR-0025 Decision 4):
 *   Control 2 — reason-required, CLOSED enum (missing/invalid → reject).
 *   Control 3 — the optional note is length-bounded AND residual-PII-rejected; `.strict()` rejects
 *               any extra (PII-shaped) key.
 *   Control 6 — the path param is a single uuid (no list/range/wildcard).
 */

describe("ADMIN-3b reveal DTO — reason-required closed enum (Control 2)", () => {
  it("accepts each of the three sanctioned reason codes", () => {
    for (const reason_code of ["worker_support_callback", "dispute_resolution", "safety_escalation"]) {
      expect(AdminPiiRevealSchema.safeParse({ reason_code }).success).toBe(true);
    }
  });

  it("rejects a MISSING reason_code (no reveal without a reason)", () => {
    expect(AdminPiiRevealSchema.safeParse({}).success).toBe(false);
  });

  it("rejects an UNKNOWN reason_code (closed enum — no free text)", () => {
    expect(AdminPiiRevealSchema.safeParse({ reason_code: "because_i_can" }).success).toBe(false);
    expect(AdminPiiRevealSchema.safeParse({ reason_code: "" }).success).toBe(false);
  });
});

describe("ADMIN-3b reveal DTO — note PII-safe + bounded (Control 3, must-fix #6)", () => {
  const reason_code = "worker_support_callback";

  it("accepts a short, PII-free note", () => {
    const r = AdminPiiRevealSchema.safeParse({ reason_code, note: "Worker requested a callback re application." });
    expect(r.success).toBe(true);
  });

  it("accepts an omitted note (optional)", () => {
    expect(AdminPiiRevealSchema.safeParse({ reason_code }).success).toBe(true);
  });

  it("rejects a note over the length bound (≤280)", () => {
    const long = "a".repeat(ADMIN_PII_REVEAL_NOTE_MAX + 1);
    expect(AdminPiiRevealSchema.safeParse({ reason_code, note: long }).success).toBe(false);
  });

  it("REJECTS a note containing a phone-shaped digit run (residual PII → 400)", () => {
    for (const note of [
      "call back on 9876543210",
      "his number is +91 98765 43210",
      "ph: 080-2345-6789",
    ]) {
      expect(AdminPiiRevealSchema.safeParse({ reason_code, note }).success, note).toBe(false);
    }
  });

  it("REJECTS a note containing a long digit run (Aadhaar/account — residual numeric PII)", () => {
    expect(AdminPiiRevealSchema.safeParse({ reason_code, note: "aadhaar 123456789012" }).success).toBe(
      false,
    );
  });

  it("REJECTS a note containing an email (another contact channel)", () => {
    expect(
      AdminPiiRevealSchema.safeParse({ reason_code, note: "reach at worker@example.com" }).success,
    ).toBe(false);
  });

  it("rejects an extra (PII-shaped) key — .strict() (no value can ride in)", () => {
    expect(
      AdminPiiRevealSchema.safeParse({ reason_code, phone: "+919876543210" }).success,
    ).toBe(false);
    expect(AdminPiiRevealSchema.safeParse({ reason_code, worker_id: "x" }).success).toBe(false);
  });

  it("noteHasResidualPii flags contact-shaped notes and passes clean ones", () => {
    expect(noteHasResidualPii("9876543210")).toBe(true);
    expect(noteHasResidualPii("a@b.com")).toBe(true);
    expect(noteHasResidualPii("123456789012")).toBe(true);
    expect(noteHasResidualPii("safety concern raised at the unit, follow up")).toBe(false);
  });
});

// #1924 — the note's email shape is linear, and no verdict moved.
describe("ADMIN-3b reveal DTO — the note's email shape (#1924)", () => {
  const reason_code = "worker_support_callback";
  // THE PRE-#1924 email pattern, frozen as the oracle. It is the quadratic one, so it only
  // ever sees short strings here.
  const PRE_1924_EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

  it.each([
    "worker@example.com",
    "a.b+c@mail.example.co.in",
    `${"l".repeat(300)}@acme.in`,
    "@@a@b.co",
  ])("flags the email shape %j", (note) => {
    expect(noteHasResidualPii(note)).toBe(true);
    expect(PRE_1924_EMAIL_RE.test(note)).toBe(true);
  });

  it("agrees with the pre-#1924 pattern on every digit-free note up to 8 characters", () => {
    // No digits, so the phone and digit-run checks cannot fire: the verdict is the email's.
    const alphabet = ["a", "_", "@", ".", " "];
    let flagged = 0;
    let level = [""];
    for (let len = 0; len <= 8; len++) {
      for (const note of level) {
        const verdict = noteHasResidualPii(note);
        if (verdict !== PRE_1924_EMAIL_RE.test(note)) expect.fail(JSON.stringify(note));
        if (verdict) flagged++;
      }
      level = level.flatMap((p) => alphabet.map((c) => p + c));
    }
    expect(flagged).toBeGreaterThan(100); // not vacuous
  });

  it("matches ONE character before the @, never a run that re-scans from every start", () => {
    // Classes collapse to one token first, so the "@" found is the literal one.
    const src = readFileSync(join(__dirname, "admin-pii-reveal.dto.ts"), "utf8");
    const pattern = /^const EMAIL_RE = \/(.+)\/;\r?$/m.exec(src)?.[1];
    expect(pattern).toBeDefined();
    const tokens = pattern!.replace(/\[(?:\\.|[^\]\\])*\]/g, "C");
    expect(tokens.slice(0, tokens.indexOf("@"))).toBe("C");
  });

  // Before the fix a 100,000-character note cost ~4.2 s: Zod 3 runs the refine after `.max()`
  // fails, so the cap did not bound it. About a millisecond now. The oracle and the pin above
  // are the guard; this generous bound is the backstop, still ~8x under the old cost.
  it.each([
    ["a run with no whitespace or @", "a".repeat(100_000)],
    ["an @ before dotted words", `a@${"b.".repeat(49_999)}`],
    ["repeated @s", "a@".repeat(50_000)],
    ["digit-dash pairs", "1-".repeat(50_000)],
  ])("refuses a 100,000-character note (%s) fast", (_shape, note) => {
    const started = performance.now();
    expect(AdminPiiRevealSchema.safeParse({ reason_code, note }).success).toBe(false);
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe("ADMIN-3b reveal params — single uuid (Control 6, no IDOR)", () => {
  it("accepts a uuid path param", () => {
    expect(
      AdminPiiRevealParamsSchema.safeParse({ id: "dddddddd-0000-4000-8000-000000000004" }).success,
    ).toBe(true);
  });

  it("rejects a non-uuid id (no list/range/wildcard)", () => {
    expect(AdminPiiRevealParamsSchema.safeParse({ id: "all" }).success).toBe(false);
    expect(AdminPiiRevealParamsSchema.safeParse({ id: "1,2,3" }).success).toBe(false);
    expect(AdminPiiRevealParamsSchema.safeParse({ id: "*" }).success).toBe(false);
  });

  it("rejects an extra param key (.strict)", () => {
    expect(
      AdminPiiRevealParamsSchema.safeParse({
        id: "dddddddd-0000-4000-8000-000000000004",
        id2: "x",
      }).success,
    ).toBe(false);
  });
});
