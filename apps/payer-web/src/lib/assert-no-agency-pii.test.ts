import { describe, expect, it, vi, afterEach } from "vitest";
import { assertNoAgencyPII } from "./assert-no-agency-pii";

/**
 * FACELESS-boundary tests (CLAUDE.md §2 #2 + #6 / B-R2). The agency surface must be
 * faceless: opaque ids / counts / status / timestamps only. `assertNoAgencyPII`:
 *  - in dev/test THROWS on any forbidden worker-PII key (so a regression fails CI),
 *  - in prod STRIPS the offending keys and returns a faceless payload (never crash).
 */

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("assertNoAgencyPII — passes faceless data", () => {
  it("returns identical data when no forbidden key is present", () => {
    const faceless = {
      workerId: "11111111-1111-4111-8111-111111111111",
      status: "granted",
      createdAt: "2026-06-22T00:00:00.000Z",
      rank: 3,
      count: 7,
    };
    expect(assertNoAgencyPII(faceless)).toBe(faceless);
  });

  it("allows the agency's OWN identifiers + masked artifacts (not worker PII)", () => {
    const own = {
      payerId: "22222222-2222-4222-8222-222222222222",
      payer_id: "22222222-2222-4222-8222-222222222222",
      displayLabel: "HireFast Agency",
      orgName: "HireFast Agency",
      roleTitle: "CNC Operator",
      relay_handle: "rl_opaque_handle",
      displayInitials: "R***** K.",
    };
    expect(() => assertNoAgencyPII(own)).not.toThrow();
  });
});

describe("assertNoAgencyPII — dev/test THROWS on worker PII", () => {
  it("throws on a worker name", () => {
    expect(() => assertNoAgencyPII({ workerId: "x", name: "Ramesh Kumar" })).toThrow(
      /forbidden PII key/i,
    );
  });

  it("throws on a phone (incl. phone_e164)", () => {
    expect(() => assertNoAgencyPII({ phone_e164: "+919812345678" })).toThrow(/forbidden PII key/i);
  });

  it("throws on nested PII inside an array", () => {
    expect(() => assertNoAgencyPII({ applicants: [{ workerId: "x", full_name: "A B" }] })).toThrow(
      /applicants\[0\]\.full_name/,
    );
  });

  it("does NOT leak the PII VALUE in the error message (path/key only)", () => {
    try {
      assertNoAgencyPII({ phone: "+919812345678" });
      throw new Error("should have thrown");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).not.toContain("+919812345678");
      expect(msg).toContain("phone");
    }
  });
});

describe("assertNoAgencyPII — production STRIPS instead of throwing", () => {
  it("omits forbidden keys and returns a faceless payload in prod", () => {
    vi.stubEnv("NODE_ENV", "production");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = assertNoAgencyPII({
      workerId: "11111111-1111-4111-8111-111111111111",
      name: "Ramesh Kumar",
      phone: "+919812345678",
      status: "granted",
    }) as Record<string, unknown>;

    expect(out).toEqual({
      workerId: "11111111-1111-4111-8111-111111111111",
      status: "granted",
    });
    expect(out.name).toBeUndefined();
    expect(out.phone).toBeUndefined();
    // The warning names the PATH only, never the value.
    expect(warn).toHaveBeenCalledOnce();
    const warned = String(warn.mock.calls[0]?.[0] ?? "");
    expect(warned).not.toContain("+919812345678");
    expect(warned).not.toContain("Ramesh Kumar");
    warn.mockRestore();
  });
});
