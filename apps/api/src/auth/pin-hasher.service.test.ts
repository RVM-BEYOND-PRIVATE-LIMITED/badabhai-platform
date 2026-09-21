import "reflect-metadata";
import { describe, it, expect } from "vitest";
import type { ServerConfig } from "@badabhai/config";
import { PinHasher, CURRENT_PIN_PEPPER_VERSION } from "./pin-hasher.service";

/**
 * SERVICE-level tests for the PinHasher boundary (ADR-0026 Phase 3). The scrypt round-trip
 * itself (pepper-required, fail-closed on a malformed/wrong-version token) is already covered
 * in packages/db/src/crypto.test.ts — here we exercise ONLY the boundary's own behaviour:
 * the format gate (the ONLY policy left since #1462 removed the strength rules) and that
 * hash/verify thread the pepper version. The PII crypto is a deterministic in-memory double (no real pepper, no
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

/**
 * #1462 — THE STRENGTH POLICY IS GONE, AND THIS IS THE LOCK THAT KEEPS IT GONE.
 *
 * Owner ruling 2026-09-08: "the worker chooses their own PIN. No strength policy, client or
 * server. 1234, 1111, 0000 — all must be accepted." This suite used to assert the opposite,
 * denylist entry by denylist entry, so deleting it outright would have left NOTHING saying the
 * removal was deliberate — and a weak-PIN check is exactly the kind of thing a well-meaning
 * security pass re-adds. The assertions are therefore INVERTED rather than deleted: the class
 * must not carry a strength check at all, and the format gate above must keep working.
 */
describe("PinHasher — no strength policy (#1462)", () => {
  const hasher = build();

  it("has no isWeakPin method any more, under any name", () => {
    // The property check is the load-bearing one: re-adding `isWeakPin` to the class turns this
    // red at the definition, before any call site exists to catch it.
    expect((hasher as unknown as Record<string, unknown>).isWeakPin).toBeUndefined();
    const surface = Object.getOwnPropertyNames(Object.getPrototypeOf(hasher));
    for (const name of surface) {
      expect(name, `${name} looks like a re-added strength rule`).not.toMatch(
        /weak|strength|denylist|blacklist|guessable/i,
      );
    }
  });

  it("still gates FORMAT for the values a strength rule used to catch", () => {
    // The point of the ruling is that a guessable PIN is a worker's own call — not that anything
    // goes. A malformed value is still refused, and that is the whole of the remaining policy.
    for (const pin of ["0000", "1111", "1234", "4321", "2580", "6969"]) {
      expect(hasher.isCorrectFormat(pin), `${pin} must be accepted as well-formed`).toBe(true);
    }
    for (const pin of ["12a4", "", "123", "12345"]) {
      expect(hasher.isCorrectFormat(pin), `${pin} must still be refused`).toBe(false);
    }
  });

  it("hashes a guessable PIN like any other — nothing downstream special-cases it", () => {
    const { pinHash, pepperVersion } = hasher.hash("1234");
    expect(pinHash).not.toBe("1234");
    expect(pepperVersion).toBe(CURRENT_PIN_PEPPER_VERSION);
    expect(hasher.verify("1234", pinHash, pepperVersion)).toBe(true);
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
