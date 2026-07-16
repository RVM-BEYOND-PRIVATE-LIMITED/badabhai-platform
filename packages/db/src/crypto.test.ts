import { describe, it, expect } from "vitest";
import { randomBytes, createCipheriv } from "node:crypto";
import {
  encryptPii,
  decryptPii,
  encryptPiiWithKeyring,
  decryptPiiWithKeyring,
  isEncryptedPii,
  hashPin,
  verifyPin,
  isPinHash,
  type PiiKeyring,
} from "./crypto";

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

describe("PII token v2 (kid + keyring, read-both — TD22-1)", () => {
  const ACTIVE_KID = "k2026a";
  const OLDER_KID = "k2025-old_1";
  const ACTIVE_KEY = randomBytes(32).toString("base64");
  const OLDER_KEY = randomBytes(32).toString("base64");
  const KEYRING: PiiKeyring = {
    activeKid: ACTIVE_KID,
    keys: { [ACTIVE_KID]: ACTIVE_KEY, [OLDER_KID]: OLDER_KEY },
  };

  it("v2 round-trips and carries the active kid as the 2nd token segment", () => {
    const token = encryptPiiWithKeyring("+919876543210", KEYRING);
    const parts = token.split(".");
    expect(parts).toHaveLength(5); // v2.<kid>.<iv>.<tag>.<ct>
    expect(parts[0]).toBe("v2");
    expect(parts[1]).toBe(ACTIVE_KID);
    expect(decryptPiiWithKeyring(token, KEYRING, KEY)).toBe("+919876543210");
  });

  it("is non-deterministic (fresh IV per call → different v2 ciphertexts)", () => {
    expect(encryptPiiWithKeyring("same", KEYRING)).not.toBe(encryptPiiWithKeyring("same", KEYRING));
  });

  it("decrypts a v2 token written under a NON-active kid still in the map (staged rotation)", () => {
    const olderRing: PiiKeyring = { activeKid: OLDER_KID, keys: { [OLDER_KID]: OLDER_KEY } };
    const token = encryptPiiWithKeyring("secret", olderRing);
    expect(token.split(".")[1]).toBe(OLDER_KID);
    // After rotation the active kid moved on, but the older kid stays readable.
    expect(decryptPiiWithKeyring(token, KEYRING, KEY)).toBe("secret");
  });

  it("a v1 token still decrypts WHILE a v2 keyring is active (the read-both §8 lock)", () => {
    const legacyToken = encryptPii("+919876543210", KEY);
    expect(legacyToken.startsWith("v1.")).toBe(true);
    expect(decryptPiiWithKeyring(legacyToken, KEYRING, KEY)).toBe("+919876543210");
  });

  it("a v1 token WITHOUT a legacy key fails closed (no silent keyring guess)", () => {
    const legacyToken = encryptPii("secret", KEY);
    expect(() => decryptPiiWithKeyring(legacyToken, KEYRING)).toThrow(/legacy/i);
  });

  it("unknown kid throws fail-closed WITHOUT echoing it and WITHOUT enumerating known kids", () => {
    const goneRing: PiiKeyring = {
      activeKid: "gone_kid_zz",
      keys: { gone_kid_zz: randomBytes(32).toString("base64") },
    };
    const orphan = encryptPiiWithKeyring("secret", goneRing);
    let message = "";
    try {
      decryptPiiWithKeyring(orphan, KEYRING, KEY);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toBe("unknown PII key id");
    expect(message).not.toContain("gone_kid_zz"); // the unknown kid is never echoed
    expect(message).not.toContain(ACTIVE_KID); // known kids are never enumerated
    expect(message).not.toContain(OLDER_KID);
  });

  it("rejects a dotted / oversized / empty active kid at ENCRYPT time (fail-closed, no token minted)", () => {
    for (const badKid of ["bad.kid", "a".repeat(33), ""]) {
      const ring: PiiKeyring = { activeKid: badKid, keys: { [badKid]: ACTIVE_KEY } };
      let message = "";
      try {
        encryptPiiWithKeyring("secret", ring);
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toMatch(/invalid PII key id/i);
      if (badKid.length > 0) expect(message).not.toContain(badKid); // never echoed
    }
  });

  it("rejects a tampered v2 auth tag AND a tampered v2 ciphertext (GCM fails closed)", () => {
    const token = encryptPiiWithKeyring("secret", KEYRING);
    const [v, kid, iv, tag, ct] = token.split(".");

    const flippedCt = Buffer.from(ct!, "base64");
    flippedCt[0] = (flippedCt[0]! ^ 0x01) & 0xff;
    const tamperedCt = [v, kid, iv, tag, flippedCt.toString("base64")].join(".");
    expect(() => decryptPiiWithKeyring(tamperedCt, KEYRING, KEY)).toThrow();

    const flippedTag = Buffer.from(tag!, "base64");
    flippedTag[0] = (flippedTag[0]! ^ 0x01) & 0xff;
    const tamperedTag = [v, kid, iv, flippedTag.toString("base64"), ct].join(".");
    expect(() => decryptPiiWithKeyring(tamperedTag, KEYRING, KEY)).toThrow();
  });

  it("a v2 token hitting the LEGACY decrypt path names the keyring rollback, not corruption (LOW-1)", () => {
    // Operator rollback: keyring enabled → v2 rows written → BOTH env vars unset
    // (boot passes). Every v2 row then routes through legacy decryptPii — the
    // error must say "re-configure the keyring", never look like data corruption.
    const token = encryptPiiWithKeyring("secret", KEYRING);
    let message = "";
    try {
      decryptPii(token, KEY);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toBe("v2 PII token but no keyring is configured");
    expect(message).not.toContain(ACTIVE_KID); // the kid is never echoed
    expect(message).not.toMatch(/malformed/i); // distinct from the corruption throw
  });

  it("rejects malformed v2 token shapes with no secret material in the message", () => {
    // Wrong part count (4-part v2), 6 parts (a dotted kid would land here), empty kid.
    for (const bad of ["v2.kid.only.four", "v2.bad.kid.iv.tag.ct", "v2..aaaa.bbbb.cccc"]) {
      expect(() => decryptPiiWithKeyring(bad, KEYRING, KEY)).toThrow(/malformed/i);
    }
  });

  it("isEncryptedPii accepts BOTH shipped formats and rejects plaintext/garbage (the backfill discriminator)", () => {
    expect(isEncryptedPii(encryptPii("x", KEY))).toBe(true); // v1, 4 parts
    expect(isEncryptedPii(encryptPiiWithKeyring("x", KEYRING))).toBe(true); // v2, 5 parts
    expect(isEncryptedPii("+919876543210")).toBe(false); // plaintext
    expect(isEncryptedPii("not-a-token")).toBe(false); // garbage
    expect(isEncryptedPii("v2.bad kid.iv.tag.ct")).toBe(false); // invalid kid charset
    expect(isEncryptedPii("v2..iv.tag.ct")).toBe(false); // empty kid
    expect(isEncryptedPii("v9.a.b.c.d")).toBe(false); // unknown version
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
