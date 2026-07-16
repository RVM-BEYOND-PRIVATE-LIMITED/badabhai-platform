import { describe, it, expect } from "vitest";
import { loadServerConfig } from "@badabhai/config";
import { PiiCryptoService } from "./pii-crypto.service";
import { encryptPii, decryptPii } from "./crypto";

/**
 * TD22-1 — PiiCryptoService keyring wiring:
 *   - keyring NOT configured → byte-format-identical legacy v1 behavior;
 *   - keyring configured     → v2 writes under the active kid + READ-BOTH decrypt
 *                              (old v1 rows keep decrypting via PII_ENCRYPTION_KEY);
 *   - half-set/invalid keyring → the constructor fails loudly (defense-in-depth
 *     behind the assertPiiCryptoConfig boot gate), never a silent legacy fallback.
 */
const LEGACY_KEY = Buffer.alloc(32, 7).toString("base64");
const ACTIVE_KEY = Buffer.alloc(32, 9).toString("base64");
const KEYRING_ENV = {
  PII_ENCRYPTION_KEYS: JSON.stringify({ k2026a: ACTIVE_KEY }),
  PII_ENCRYPTION_ACTIVE_KID: "k2026a",
};

const cfg = (over: Record<string, string> = {}) =>
  loadServerConfig({
    DATABASE_URL: "postgresql://u:p@localhost:5432/db",
    PII_ENCRYPTION_KEY: LEGACY_KEY,
    ...over,
  });

describe("PiiCryptoService (TD22-1 keyring wiring)", () => {
  it("UNCONFIGURED keyring: encrypt emits the legacy v1 byte-format and round-trips", () => {
    const pii = new PiiCryptoService(cfg());
    const token = pii.encrypt("+919876543210");
    expect(token.startsWith("v1.")).toBe(true);
    expect(token.split(".")).toHaveLength(4);
    expect(pii.decrypt(token)).toBe("+919876543210");
    // Byte-format compat both ways with the pure helpers under the same key.
    expect(decryptPii(token, LEGACY_KEY)).toBe("+919876543210");
    expect(pii.decrypt(encryptPii("+919876543210", LEGACY_KEY))).toBe("+919876543210");
  });

  it("CONFIGURED keyring: encrypt emits v2 under the active kid and round-trips", () => {
    const pii = new PiiCryptoService(cfg(KEYRING_ENV));
    const token = pii.encrypt("+919876543210");
    const parts = token.split(".");
    expect(parts).toHaveLength(5); // v2.<kid>.<iv>.<tag>.<ct>
    expect(parts[0]).toBe("v2");
    expect(parts[1]).toBe("k2026a");
    expect(pii.decrypt(token)).toBe("+919876543210");
  });

  it("CONFIGURED keyring: an old v1 row still decrypts (read-both — no re-encrypt needed)", () => {
    const legacyService = new PiiCryptoService(cfg());
    const oldRow = legacyService.encrypt("+919876543210"); // a pre-keyring v1 token
    const keyringService = new PiiCryptoService(cfg(KEYRING_ENV));
    expect(keyringService.decrypt(oldRow)).toBe("+919876543210");
  });

  it("unknown kid fails closed and never echoes the kid (§2)", () => {
    const otherRing = new PiiCryptoService(
      cfg({
        PII_ENCRYPTION_KEYS: JSON.stringify({ gone_kid_zz: Buffer.alloc(32, 4).toString("base64") }),
        PII_ENCRYPTION_ACTIVE_KID: "gone_kid_zz",
      }),
    );
    const orphan = otherRing.encrypt("secret");
    const pii = new PiiCryptoService(cfg(KEYRING_ENV));
    let message = "";
    try {
      pii.decrypt(orphan);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toBe("unknown PII key id");
    expect(message).not.toContain("gone_kid_zz");
    expect(message).not.toContain("k2026a");
  });

  it("a half-set keyring config makes the constructor throw (never a silent legacy fallback)", () => {
    expect(
      () => new PiiCryptoService(cfg({ PII_ENCRYPTION_KEYS: JSON.stringify({ k1: ACTIVE_KEY }) })),
    ).toThrow(/fail closed/);
    expect(() => new PiiCryptoService(cfg({ PII_ENCRYPTION_ACTIVE_KID: "k1" }))).toThrow(
      /fail closed/,
    );
  });
});
