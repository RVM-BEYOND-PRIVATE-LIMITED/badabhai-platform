import { describe, it, expect } from "vitest";
import {
  loadServerConfig,
  assertPiiCryptoConfig,
  getPiiKeyring,
  piiKeyringConfigProblems,
} from "./server";

const REAL_PEPPER = "a".repeat(40);
const REAL_KEY = Buffer.alloc(32, 1).toString("base64");
const cfg = (over: Record<string, string> = {}) =>
  loadServerConfig({ DATABASE_URL: "postgresql://u:p@localhost:5432/db", ...over });

describe("assertPiiCryptoConfig (fail-closed PII guard)", () => {
  it("allows dev defaults ONLY when NODE_ENV is explicitly development/test", () => {
    expect(() => assertPiiCryptoConfig(cfg(), "development")).not.toThrow();
    expect(() => assertPiiCryptoConfig(cfg(), "test")).not.toThrow();
  });

  it("throws on dev defaults in production", () => {
    expect(() => assertPiiCryptoConfig(cfg(), "production")).toThrow(/PII secret/i);
  });

  it("treats UNSET NODE_ENV as non-dev (fails closed)", () => {
    // Real "unset" = process.env.NODE_ENV is undefined; the guard then enforces.
    // (Passing undefined as the arg would trigger the default param, so mutate env.)
    const prev = process.env.NODE_ENV;
    delete process.env.NODE_ENV;
    try {
      expect(() => assertPiiCryptoConfig(cfg())).toThrow(/PII secret/i);
    } finally {
      if (prev === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prev;
    }
  });

  it("throws on dev defaults in staging/preview", () => {
    expect(() => assertPiiCryptoConfig(cfg(), "staging")).toThrow();
  });

  it("passes in production with real secrets", () => {
    const c = cfg({ PII_HASH_PEPPER: REAL_PEPPER, PII_ENCRYPTION_KEY: REAL_KEY });
    expect(() => assertPiiCryptoConfig(c, "production")).not.toThrow();
  });

  it("rejects an all-zero AES key in production", () => {
    const c = cfg({ PII_HASH_PEPPER: REAL_PEPPER, PII_ENCRYPTION_KEY: Buffer.alloc(32).toString("base64") });
    expect(() => assertPiiCryptoConfig(c, "production")).toThrow(/PII_ENCRYPTION_KEY/i);
  });
});

describe("PII keyring config (TD22-1 — kid + keyring, fail closed at BOOT)", () => {
  const K1 = Buffer.alloc(32, 2).toString("base64");
  const K2 = Buffer.alloc(32, 3).toString("base64");
  const KEYS = JSON.stringify({ k2026a: K1, "k2025-old_1": K2 });
  const VALID = { PII_ENCRYPTION_KEYS: KEYS, PII_ENCRYPTION_ACTIVE_KID: "k2026a" };

  it("both vars unset → keyring is null (feature off, zero behavior change)", () => {
    expect(getPiiKeyring(cfg())).toBeNull();
    expect(piiKeyringConfigProblems(cfg())).toEqual([]);
    expect(() => assertPiiCryptoConfig(cfg(), "development")).not.toThrow();
  });

  it("a valid pair parses and passes boot validation (dev AND production)", () => {
    const keyring = getPiiKeyring(cfg(VALID));
    expect(keyring).toEqual({ activeKid: "k2026a", keys: { k2026a: K1, "k2025-old_1": K2 } });
    expect(() => assertPiiCryptoConfig(cfg(VALID), "development")).not.toThrow();
    const prod = cfg({ ...VALID, PII_HASH_PEPPER: REAL_PEPPER, PII_ENCRYPTION_KEY: REAL_KEY });
    expect(() => assertPiiCryptoConfig(prod, "production")).not.toThrow();
  });

  it("KEYS set without ACTIVE_KID fails boot (both-or-neither)", () => {
    const c = cfg({ PII_ENCRYPTION_KEYS: KEYS });
    expect(() => assertPiiCryptoConfig(c, "development")).toThrow(/PII_ENCRYPTION_ACTIVE_KID is not set/);
    expect(() => getPiiKeyring(c)).toThrow(/fail closed/);
  });

  it("ACTIVE_KID set without KEYS fails boot (both-or-neither)", () => {
    const c = cfg({ PII_ENCRYPTION_ACTIVE_KID: "k2026a" });
    expect(() => assertPiiCryptoConfig(c, "development")).toThrow(/PII_ENCRYPTION_KEYS is not set/);
    expect(() => getPiiKeyring(c)).toThrow(/fail closed/);
  });

  it("an EMPTY-STRING env value is a config ERROR, never 'silently off' (TD67 lesson)", () => {
    // "" for either var — including "" for KEYS alone — must fail boot, not act unset.
    expect(() =>
      assertPiiCryptoConfig(cfg({ PII_ENCRYPTION_KEYS: "", PII_ENCRYPTION_ACTIVE_KID: "k2026a" }), "development"),
    ).toThrow(/PII_ENCRYPTION_KEYS must not be an empty string/);
    expect(() =>
      assertPiiCryptoConfig(cfg({ PII_ENCRYPTION_KEYS: KEYS, PII_ENCRYPTION_ACTIVE_KID: "" }), "development"),
    ).toThrow(/PII_ENCRYPTION_ACTIVE_KID must not be an empty string/);
    expect(() =>
      assertPiiCryptoConfig(cfg({ PII_ENCRYPTION_KEYS: "", PII_ENCRYPTION_ACTIVE_KID: "" }), "development"),
    ).toThrow(/empty string/);
    expect(() => assertPiiCryptoConfig(cfg({ PII_ENCRYPTION_KEYS: "" }), "development")).toThrow(
      /empty string/,
    );
  });

  it("malformed KEYS fails boot: bad JSON, a JSON array, a non-string value, an empty map", () => {
    for (const bad of ["not json", "[1,2]", '{"k1": 42}', "{}"]) {
      const c = cfg({ PII_ENCRYPTION_KEYS: bad, PII_ENCRYPTION_ACTIVE_KID: "k1" });
      expect(() => assertPiiCryptoConfig(c, "development")).toThrow(/PII_ENCRYPTION_KEYS/);
    }
  });

  it("a malformed key in the map fails boot: not base64-32, and all-zero", () => {
    const short = cfg({
      PII_ENCRYPTION_KEYS: JSON.stringify({ k1: Buffer.alloc(16, 1).toString("base64") }),
      PII_ENCRYPTION_ACTIVE_KID: "k1",
    });
    expect(() => assertPiiCryptoConfig(short, "development")).toThrow(/not base64 of exactly 32 bytes/);

    const garbage = cfg({
      PII_ENCRYPTION_KEYS: JSON.stringify({ k1: "!!!not-base64!!!" }),
      PII_ENCRYPTION_ACTIVE_KID: "k1",
    });
    expect(() => assertPiiCryptoConfig(garbage, "development")).toThrow(/not base64 of exactly 32 bytes/);

    const allZero = cfg({
      PII_ENCRYPTION_KEYS: JSON.stringify({ k1: Buffer.alloc(32).toString("base64") }),
      PII_ENCRYPTION_ACTIVE_KID: "k1",
    });
    expect(() => assertPiiCryptoConfig(allZero, "development")).toThrow(/all-zero key/);
  });

  it("a bad kid (dotted / oversized) fails boot", () => {
    const dotted = cfg({
      PII_ENCRYPTION_KEYS: JSON.stringify({ "has.dot": K1 }),
      PII_ENCRYPTION_ACTIVE_KID: "has.dot",
    });
    expect(() => assertPiiCryptoConfig(dotted, "development")).toThrow(/invalid key id/);

    const oversized = cfg({
      PII_ENCRYPTION_KEYS: JSON.stringify({ ["a".repeat(33)]: K1 }),
      PII_ENCRYPTION_ACTIVE_KID: "a".repeat(33),
    });
    expect(() => assertPiiCryptoConfig(oversized, "development")).toThrow(/invalid key id/);
  });

  it("an ACTIVE_KID not present in the map fails boot", () => {
    const c = cfg({ PII_ENCRYPTION_KEYS: KEYS, PII_ENCRYPTION_ACTIVE_KID: "not_in_map" });
    expect(() => assertPiiCryptoConfig(c, "development")).toThrow(
      /PII_ENCRYPTION_ACTIVE_KID is not a key id in PII_ENCRYPTION_KEYS/,
    );
  });

  it("problem strings never leak kid values or key material (§2 guardrail)", () => {
    const c = cfg({
      PII_ENCRYPTION_KEYS: JSON.stringify({ secret_kid_x: Buffer.alloc(16, 5).toString("base64") }),
      PII_ENCRYPTION_ACTIVE_KID: "other_secret_kid",
    });
    const problems = piiKeyringConfigProblems(c).join("; ");
    expect(problems.length).toBeGreaterThan(0);
    expect(problems).not.toContain("secret_kid_x");
    expect(problems).not.toContain("other_secret_kid");
    expect(problems).not.toContain(Buffer.alloc(16, 5).toString("base64"));
  });
});
