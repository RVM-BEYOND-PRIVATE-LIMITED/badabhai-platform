import { describe, expect, it, vi } from "vitest";
import type { ServerConfig } from "@badabhai/config";
import { PiiCryptoService } from "./pii-crypto.service";
import {
  CURRENT_PASSWORD_PEPPER_VERSION,
  DUMMY_PASSWORD_HASH,
  PasswordPolicySchema,
  PresentedPasswordSchema,
  generateTemporaryPassword,
  matchesStoredPassword,
} from "./password-policy";
import { CURRENT_PASSWORD_PEPPER_VERSION as PAYER_REEXPORT } from "../payers/payers.repository";

const pii = new PiiCryptoService({
  PII_HASH_PEPPER: "test-pepper",
  PII_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
} as unknown as ServerConfig);

describe("PasswordPolicySchema — the ONE policy (payer #2497 + admin 0144)", () => {
  it("accepts 8..128 chars with at least one letter and one digit", () => {
    for (const ok of ["abcdefg1", "A1bcdefg", "x".repeat(127) + "1"]) {
      expect(PasswordPolicySchema.safeParse(ok).success, ok).toBe(true);
    }
  });

  it("rejects too short, too long, letters-only and digits-only — with the #2497 messages", () => {
    const msg = (v: string) => PasswordPolicySchema.safeParse(v).error?.issues[0]?.message;
    expect(msg("abc1")).toBe("Password must be at least 8 characters");
    expect(msg("a1".repeat(65))).toBe("Password must be at most 128 characters");
    expect(msg("abcdefgh")).toBe("Password must include at least one letter and one digit");
    expect(msg("12345678")).toBe("Password must include at least one letter and one digit");
  });

  it("a PRESENTED password is bounded but not policy-checked (no weak-guess oracle)", () => {
    expect(PresentedPasswordSchema.safeParse("a").success).toBe(true);
    expect(PresentedPasswordSchema.safeParse("").success).toBe(false);
    expect(PresentedPasswordSchema.safeParse("x".repeat(129)).success).toBe(false);
  });

  it("the payer repository still exports the SAME pepper version (re-export, not a copy)", () => {
    expect(PAYER_REEXPORT).toBe(CURRENT_PASSWORD_PEPPER_VERSION);
  });
});

describe("matchesStoredPassword — fail closed, constant KDF cost", () => {
  const hash = pii.hashPassword("Correct-horse-9");

  it("true only for the right password on a current-pepper hash", () => {
    const stored = { passwordHash: hash, passwordPepperVersion: CURRENT_PASSWORD_PEPPER_VERSION };
    expect(matchesStoredPassword(pii, "Correct-horse-9", stored)).toBe(true);
    expect(matchesStoredPassword(pii, "Wrong-horse-9", stored)).toBe(false);
  });

  it("an UNKNOWN pepper version fails closed even with the right password", () => {
    expect(
      matchesStoredPassword(pii, "Correct-horse-9", {
        passwordHash: hash,
        passwordPepperVersion: 99,
      }),
    ).toBe(false);
  });

  it("NO hash (no password set) still burns one full KDF — timing matches a wrong password", () => {
    const verify = vi.fn(() => false);
    expect(
      matchesStoredPassword({ verifyPassword: verify }, "anything-1", {
        passwordHash: null,
        passwordPepperVersion: null,
      }),
    ).toBe(false);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(verify).toHaveBeenCalledWith("anything-1", DUMMY_PASSWORD_HASH);
  });

  it("the dummy hash is well-formed but matches nothing", () => {
    expect(DUMMY_PASSWORD_HASH.startsWith("password-v1.")).toBe(true);
    expect(pii.verifyPassword("", DUMMY_PASSWORD_HASH)).toBe(false);
    expect(pii.verifyPassword("Correct-horse-9", DUMMY_PASSWORD_HASH)).toBe(false);
  });
});

describe("generateTemporaryPassword (#2563)", () => {
  it("is 14 characters, passes the shared policy, and avoids ambiguous glyphs", () => {
    for (let i = 0; i < 50; i++) {
      const pw = generateTemporaryPassword();
      expect(pw).toHaveLength(14);
      expect(PasswordPolicySchema.safeParse(pw).success).toBe(true);
      expect(pw).not.toMatch(/[0O1lI]/);
    }
  });

  it("is crypto-random: 200 calls produce 200 distinct values", () => {
    const seen = new Set(Array.from({ length: 200 }, () => generateTemporaryPassword()));
    expect(seen.size).toBe(200);
  });
});
