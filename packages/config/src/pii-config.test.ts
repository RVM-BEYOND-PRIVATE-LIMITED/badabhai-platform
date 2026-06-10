import { describe, it, expect } from "vitest";
import { loadServerConfig, assertPiiCryptoConfig } from "./server";

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
