import { describe, it, expect } from "vitest";
import { hashPhone, hashIp, hmacValue, encryptPii, decryptPii, isEncryptedPii } from "./crypto";

const KEY = Buffer.alloc(32, 7).toString("base64");
const PEPPER = "unit-test-pepper-1234567890";
const PHONE = "+919081083269";

describe("PII crypto", () => {
  it("hashPhone: deterministic, peppered, never echoes the number", () => {
    const a = hashPhone(PHONE, PEPPER);
    expect(hashPhone(PHONE, PEPPER)).toBe(a); // stable → usable as lookup/dedup key
    expect(a).not.toContain("9081083269");
    expect(hashPhone(PHONE, "different-pepper")).not.toBe(a); // pepper actually keys it
    expect(hashPhone(PHONE, PEPPER)).not.toBe(hashIp(PHONE, PEPPER)); // domain-separated
  });

  it("encrypt/decrypt: round-trips, non-deterministic, hides the number", () => {
    const c1 = encryptPii(PHONE, KEY);
    const c2 = encryptPii(PHONE, KEY);
    expect(c1).not.toBe(c2); // fresh IV per call
    expect(c1).not.toContain("9081083269");
    expect(isEncryptedPii(c1)).toBe(true);
    expect(decryptPii(c1, KEY)).toBe(PHONE);
    expect(decryptPii(c2, KEY)).toBe(PHONE);
  });

  it("authenticated: rejects wrong key and tampered ciphertext", () => {
    const c = encryptPii("secret", KEY);
    const wrongKey = Buffer.alloc(32, 9).toString("base64");
    expect(() => decryptPii(c, wrongKey)).toThrow();
    const tampered = c.slice(0, -1) + (c.endsWith("A") ? "B" : "A");
    expect(() => decryptPii(tampered, KEY)).toThrow();
  });

  it("rejects a non-32-byte key (fail closed)", () => {
    expect(() => encryptPii("x", Buffer.alloc(16).toString("base64"))).toThrow();
  });

  it("hmacValue: deterministic, peppered, never echoes the code, domain-separated", () => {
    const CODE = "428913";
    const a = hmacValue(CODE, PEPPER);
    expect(hmacValue(CODE, PEPPER)).toBe(a); // stable → constant-time comparable
    expect(a).not.toContain(CODE); // the plaintext code never appears in the digest
    expect(hmacValue(CODE, "other-pepper")).not.toBe(a); // pepper actually keys it
    expect(a).not.toBe(hashPhone(CODE, PEPPER)); // separate domain from phone hashes
  });
});
