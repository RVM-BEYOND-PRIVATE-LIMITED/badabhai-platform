import "reflect-metadata";
import { describe, it, expect } from "vitest";
import type { ServerConfig } from "@badabhai/config";
import { PinHasher, CURRENT_PIN_PEPPER_VERSION } from "./pin-hasher.service";

/**
 * SERVICE-level tests for the PinHasher boundary (ADR-0026 Phase 3). The scrypt round-trip
 * itself (pepper-required, fail-closed on a malformed/wrong-version token) is already covered
 * in packages/db/src/crypto.test.ts — here we exercise ONLY the boundary's own behaviour:
 * the format gate, the weak-PIN denylist (explicit + structural), and that hash/verify thread
 * the pepper version. The PII crypto is a deterministic in-memory double (no real pepper, no
 * live KDF) so the test is fast and self-contained.
 */

const config = (over: Partial<ServerConfig> = {}) =>
  ({ PIN_LENGTH: 4, ...over }) as unknown as ServerConfig;

/**
 * A deterministic, reversible PII-crypto double. hashPin wraps the PIN in a non-identity
 * "pin$<pin>" envelope (so a test can assert the token is NOT the raw PIN); verifyPin unwraps
 * and compares. This mirrors the real boundary's contract (hash → opaque token; verify →
 * constant-time bool) WITHOUT the slow scrypt KDF.
 */
function makePii() {
  return {
    hashPin: (pin: string) => `pin$${Buffer.from(pin).toString("base64")}`,
    verifyPin: (pin: string, token: string) =>
      token === `pin$${Buffer.from(pin).toString("base64")}`,
  } as never;
}

function build(over: Partial<ServerConfig> = {}) {
  const pii = makePii();
  return new PinHasher(config(over), pii);
}

describe("PinHasher — format gate", () => {
  it("isCorrectFormat is true ONLY for exactly PIN_LENGTH digits", () => {
    const hasher = build({ PIN_LENGTH: 4 });
    expect(hasher.isCorrectFormat("1357")).toBe(true);
    expect(hasher.isCorrectFormat("135")).toBe(false); // too short
    expect(hasher.isCorrectFormat("13570")).toBe(false); // too long
    expect(hasher.isCorrectFormat("13a7")).toBe(false); // non-digit
    expect(hasher.isCorrectFormat("")).toBe(false);
  });

  it("isCorrectFormat tracks a non-default PIN_LENGTH", () => {
    const hasher = build({ PIN_LENGTH: 6 });
    expect(hasher.isCorrectFormat("135790")).toBe(true);
    expect(hasher.isCorrectFormat("1357")).toBe(false);
  });

  it("pinLength returns the configured length", () => {
    expect(build({ PIN_LENGTH: 6 }).pinLength()).toBe(6);
  });
});

describe("PinHasher — weak-PIN denylist (isWeakPin)", () => {
  const hasher = build();

  it("rejects every explicit-denylist PIN", () => {
    // The full WEAK_PINS set declared in pin-hasher.service.ts.
    const denylist = ["0000", "1111", "1234", "4321", "1212", "2580", "1004", "2000", "6969"];
    for (const pin of denylist) {
      expect(hasher.isWeakPin(pin), `expected ${pin} to be weak`).toBe(true);
    }
  });

  it("rejects ALL all-same-digit PINs (every digit 0-9)", () => {
    for (let d = 0; d <= 9; d += 1) {
      const pin = String(d).repeat(4);
      expect(hasher.isWeakPin(pin), `expected ${pin} (all-same) to be weak`).toBe(true);
    }
  });

  it("rejects every ascending consecutive run (1234..6789)", () => {
    for (const pin of ["1234", "2345", "3456", "4567", "5678", "6789"]) {
      expect(hasher.isWeakPin(pin), `expected ascending ${pin} to be weak`).toBe(true);
    }
  });

  it("rejects every descending consecutive run (4321, 9876, ...)", () => {
    for (const pin of ["4321", "9876", "8765", "7654", "6543", "5432"]) {
      expect(hasher.isWeakPin(pin), `expected descending ${pin} to be weak`).toBe(true);
    }
  });

  it("treats a malformed / non-numeric value as weak (never slips past as strong)", () => {
    expect(hasher.isWeakPin("12a4")).toBe(true);
    expect(hasher.isWeakPin("")).toBe(true);
  });

  it("ACCEPTS a non-trivial PIN that is neither a run nor on the denylist", () => {
    for (const pin of ["1357", "4826", "9042", "7391"]) {
      expect(hasher.isWeakPin(pin), `expected ${pin} to be strong`).toBe(false);
    }
  });
});

describe("PinHasher — hash / verify", () => {
  it("hash returns a non-identity token + the current pepper version, never the raw PIN", () => {
    const hasher = build();
    const { pinHash, pepperVersion } = hasher.hash("1357");
    expect(pepperVersion).toBe(CURRENT_PIN_PEPPER_VERSION);
    expect(pinHash).not.toBe("1357");
    expect(pinHash).not.toContain("1357");
  });

  it("verify is true for the correct PIN under the current version", () => {
    const hasher = build();
    const { pinHash, pepperVersion } = hasher.hash("1357");
    expect(hasher.verify("1357", pinHash, pepperVersion)).toBe(true);
  });

  it("verify is false for a WRONG PIN", () => {
    const hasher = build();
    const { pinHash } = hasher.hash("1357");
    expect(hasher.verify("2468", pinHash, CURRENT_PIN_PEPPER_VERSION)).toBe(false);
  });

  it("verify fails CLOSED for an unrecognized pepper version (future v2 read by old code)", () => {
    const hasher = build();
    const { pinHash } = hasher.hash("1357");
    expect(hasher.verify("1357", pinHash, CURRENT_PIN_PEPPER_VERSION + 1)).toBe(false);
  });
});
