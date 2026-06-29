import { describe, it, expect } from "vitest";
import { randomBytes, createCipheriv } from "node:crypto";
import { encryptPii, decryptPii, isEncryptedPii, hashPin, verifyPin, isPinHash } from "./crypto";

const KEY = randomBytes(32).toString("base64"); // a valid AES-256 key
const OTHER_KEY = randomBytes(32).toString("base64");

describe("PII crypto (AES-256-GCM, explicit authTagLength)", () => {
  it("round-trips plaintext under the same key", () => {
    const token = encryptPii("+919876543210", KEY);
    expect(token.startsWith("v1.")).toBe(true);
    expect(isEncryptedPii(token)).toBe(true);
    expect(decryptPii(token, KEY)).toBe("+919876543210");
  });

  it("is non-deterministic (fresh IV per call → different ciphertexts)", () => {
    expect(encryptPii("same", KEY)).not.toBe(encryptPii("same", KEY));
  });

  it("token carries exactly 4 dot-separated parts (v1.iv.tag.ct)", () => {
    expect(encryptPii("x", KEY).split(".")).toHaveLength(4);
  });

  it("rejects decryption under a wrong key (GCM auth fails closed)", () => {
    const token = encryptPii("secret", KEY);
    expect(() => decryptPii(token, OTHER_KEY)).toThrow();
  });

  it("rejects a tampered ciphertext (auth tag mismatch fails closed)", () => {
    const [v, iv, tag, ct] = encryptPii("secret", KEY).split(".");
    const flipped = Buffer.from(ct!, "base64");
    flipped[0] = (flipped[0]! ^ 0x01) & 0xff; // flip one bit of the ciphertext
    const tampered = [v, iv, tag, flipped.toString("base64")].join(".");
    expect(() => decryptPii(tampered, KEY)).toThrow();
  });

  it("rejects a truncated auth tag (explicit 16-byte tag enforced)", () => {
    const [v, iv, tag, ct] = encryptPii("secret", KEY).split(".");
    const shortTag = Buffer.from(tag!, "base64").subarray(0, 8).toString("base64"); // 8 bytes, not 16
    const bad = [v, iv, shortTag, ct].join(".");
    expect(() => decryptPii(bad, KEY)).toThrow();
  });

  it("rejects a malformed token shape", () => {
    expect(() => decryptPii("not-a-token", KEY)).toThrow(/malformed/i);
    expect(() => decryptPii("v1.only.three", KEY)).toThrow(/malformed/i);
  });

  it("decrypts a legacy token written WITHOUT an explicit authTagLength (at-rest back-compat)", () => {
    // Reproduce exactly how encryptPii minted tokens BEFORE authTagLength was
    // pinned: createCipheriv with no options. GCM's default tag is already 16
    // bytes, so this proves phone/email ciphertext already in the DB still
    // decrypts under the now-pinned authTagLength — no data-loss regression.
    const key = Buffer.from(KEY, "base64");
    const iv = randomBytes(12);
    const legacy = createCipheriv("aes-256-gcm", key, iv); // no { authTagLength }
    const ct = Buffer.concat([legacy.update("+919876543210", "utf8"), legacy.final()]);
    const tag = legacy.getAuthTag();
    expect(tag.length).toBe(16); // GCM default == the value we now pin
    const legacyToken = [
      "v1",
      iv.toString("base64"),
      tag.toString("base64"),
      ct.toString("base64"),
    ].join(".");
    expect(decryptPii(legacyToken, KEY)).toBe("+919876543210");
  });
});

describe("PIN hashing (scrypt-v1, peppered, per-PIN salt, constant-time)", () => {
  const PEPPER = "a-server-side-pin-pepper-min-16";
  const OTHER_PEPPER = "a-different-pin-pepper-value-16!";

  it("verifies the correct PIN under the same pepper", () => {
    const token = hashPin("1357", PEPPER);
    expect(isPinHash(token)).toBe(true);
    expect(token.startsWith("scrypt-v1.")).toBe(true);
    expect(token.split(".")).toHaveLength(3); // scrypt-v1.<salt>.<derived>
    expect(verifyPin("1357", token, PEPPER)).toBe(true);
  });

  it("rejects a wrong PIN", () => {
    const token = hashPin("1357", PEPPER);
    expect(verifyPin("1358", token, PEPPER)).toBe(false);
    expect(verifyPin("", token, PEPPER)).toBe(false);
  });

  it("rejects the correct PIN under a WRONG pepper (a row leak can't brute-force without the server pepper)", () => {
    const token = hashPin("1357", PEPPER);
    expect(verifyPin("1357", token, OTHER_PEPPER)).toBe(false);
  });

  it("is non-deterministic (fresh per-PIN salt → equal PINs hash differently)", () => {
    expect(hashPin("1357", PEPPER)).not.toBe(hashPin("1357", PEPPER));
  });

  it("never embeds the raw PIN or the pepper in the token", () => {
    const token = hashPin("4826", PEPPER);
    expect(token).not.toContain("4826");
    expect(token).not.toContain(PEPPER);
  });

  it("verifyPin fails CLOSED (false, never throws) on a malformed/wrong-version token", () => {
    expect(verifyPin("1357", "not-a-token", PEPPER)).toBe(false);
    expect(verifyPin("1357", "scrypt-v1.onlytwo", PEPPER)).toBe(false);
    expect(verifyPin("1357", "argon2id.salt.derived", PEPPER)).toBe(false); // future algo not yet supported
    expect(isPinHash("not-a-token")).toBe(false);
  });
});
