import { describe, expect, it } from "vitest";

import { decryptPii, encryptPii, encryptPiiWithKeyring } from "./crypto";
import {
  countTopLevelJsonMembers,
  parsePiiKeyring,
  piiCodec,
  readOptionalPiiKeyring,
} from "./pii-keyring-env";

/**
 * The keyring an ops runner reads, and the codec built from it — shared by the TD22-2 re-encrypt
 * runner and the #1432 title-case backfill. The re-encrypt runner had these as private helpers
 * with no test; they are pinned here now that a second caller depends on them.
 */
const KEY_A = Buffer.alloc(32, 1).toString("base64");
const KEY_B = Buffer.alloc(32, 2).toString("base64");
const LEGACY = Buffer.alloc(32, 3).toString("base64");

describe("countTopLevelJsonMembers", () => {
  it("counts top-level members only, ignoring nested objects and string contents", () => {
    expect(countTopLevelJsonMembers('{"a":"x","b":"y"}')).toBe(2);
    expect(countTopLevelJsonMembers('{"a":{"n":1,"m":2},"b":"c:d"}')).toBe(2);
    expect(countTopLevelJsonMembers('{"a":"say \\"x:y\\""}')).toBe(1);
  });

  it("sees the duplicate that JSON.parse silently collapses", () => {
    const raw = `{"k1":"${KEY_A}","k1":"${KEY_B}"}`;
    expect(Object.keys(JSON.parse(raw) as object)).toHaveLength(1);
    expect(countTopLevelJsonMembers(raw)).toBe(2);
  });
});

describe("parsePiiKeyring — the re-encrypt runner's validation, unchanged", () => {
  const parse =
    (keys: string, kid = "k1") =>
    () =>
      parsePiiKeyring(keys, kid, "reencrypt");

  it("accepts a valid keyring", () => {
    expect(parsePiiKeyring(`{"k1":"${KEY_A}","k2":"${KEY_B}"}`, "k2", "reencrypt")).toEqual({
      activeKid: "k2",
      keys: { k1: KEY_A, k2: KEY_B },
    });
  });

  it.each([
    ["not JSON", "{", "[reencrypt] PII_ENCRYPTION_KEYS is not valid JSON"],
    ["an array", "[]", "[reencrypt] PII_ENCRYPTION_KEYS must be a JSON object"],
    [
      "a duplicate kid",
      `{"k1":"${KEY_A}","k1":"${KEY_B}"}`,
      "[reencrypt] PII_ENCRYPTION_KEYS contains a duplicate key id",
    ],
    [
      "a dotted kid",
      `{"k.1":"${KEY_A}"}`,
      "[reencrypt] PII_ENCRYPTION_KEYS contains an invalid key id",
    ],
    [
      "a short key",
      `{"k1":"${Buffer.alloc(16, 1).toString("base64")}"}`,
      "[reencrypt] PII_ENCRYPTION_KEYS contains a key that is not base64 of exactly 32 bytes",
    ],
    [
      "an all-zero key",
      `{"k1":"${Buffer.alloc(32).toString("base64")}"}`,
      "[reencrypt] PII_ENCRYPTION_KEYS contains an all-zero key",
    ],
  ])("refuses %s, with the message the runner always printed", (_label, keys, message) => {
    expect(parse(keys)).toThrow(message);
  });

  it("refuses an active kid that is not in the map", () => {
    expect(parse(`{"k1":"${KEY_A}"}`, "k2")).toThrow(
      "[reencrypt] PII_ENCRYPTION_ACTIVE_KID is not a valid key id present in PII_ENCRYPTION_KEYS",
    );
  });

  it("never echoes key material in a refusal", () => {
    const short = Buffer.alloc(16, 9).toString("base64");
    let message = "";
    try {
      parsePiiKeyring(`{"secret-kid":"${short}"}`, "secret-kid", "t");
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("not base64 of exactly 32 bytes");
    expect(message).not.toContain(short);
    expect(message).not.toContain("secret-kid");
  });
});

describe("readOptionalPiiKeyring — both or neither, as the API's boot gate decides", () => {
  it("is null when neither variable is set — the legacy single-key deployment", () => {
    expect(readOptionalPiiKeyring({}, "t")).toBeNull();
  });

  it("refuses half a keyring", () => {
    expect(() => readOptionalPiiKeyring({ PII_ENCRYPTION_KEYS: `{"k1":"${KEY_A}"}` }, "t")).toThrow(
      "must be set together",
    );
    expect(() => readOptionalPiiKeyring({ PII_ENCRYPTION_ACTIVE_KID: "k1" }, "t")).toThrow(
      "must be set together",
    );
  });

  it("refuses an EMPTY string rather than reading it as off (TD67)", () => {
    expect(() => readOptionalPiiKeyring({ PII_ENCRYPTION_KEYS: "" }, "t")).toThrow(
      "must not be an empty string",
    );
    expect(() =>
      readOptionalPiiKeyring(
        { PII_ENCRYPTION_KEYS: `{"k1":"${KEY_A}"}`, PII_ENCRYPTION_ACTIVE_KID: "" },
        "t",
      ),
    ).toThrow("must not be an empty string");
  });

  it("returns the validated keyring when both are set", () => {
    expect(
      readOptionalPiiKeyring(
        { PII_ENCRYPTION_KEYS: `{"k1":"${KEY_A}"}`, PII_ENCRYPTION_ACTIVE_KID: "k1" },
        "t",
      ),
    ).toEqual({ activeKid: "k1", keys: { k1: KEY_A } });
  });
});

describe("piiCodec — the token PiiCryptoService would write for the same configuration", () => {
  it("without a keyring: legacy v1 tokens, decrypted with the legacy key", () => {
    const codec = piiCodec(LEGACY, null);
    expect(codec.activeKid).toBeNull();
    const token = codec.encrypt("Sandhar Technologies");
    expect(token.startsWith("v1.")).toBe(true);
    expect(decryptPii(token, LEGACY)).toBe("Sandhar Technologies");
    expect(codec.decrypt(encryptPii("acme", LEGACY))).toBe("acme");
  });

  it("with a keyring: writes v2 under the ACTIVE kid and still reads legacy v1", () => {
    const keyring = { activeKid: "k2", keys: { k1: KEY_A, k2: KEY_B } };
    const codec = piiCodec(LEGACY, keyring);
    expect(codec.activeKid).toBe("k2");
    const token = codec.encrypt("acme");
    expect(token.startsWith("v2.k2.")).toBe(true);
    expect(codec.decrypt(token)).toBe("acme");
    expect(codec.decrypt(encryptPii("legacy row", LEGACY))).toBe("legacy row");
    expect(
      codec.decrypt(encryptPiiWithKeyring("old kid", { activeKid: "k1", keys: keyring.keys })),
    ).toBe("old kid");
  });

  it("throws — never returns garbage — on a token it cannot open", () => {
    const codec = piiCodec(LEGACY, null);
    expect(() => codec.decrypt(encryptPii("x", KEY_A))).toThrow();
    expect(() => codec.decrypt("not-a-token")).toThrow();
    expect(() =>
      codec.decrypt(encryptPiiWithKeyring("x", { activeKid: "k1", keys: { k1: KEY_A } })),
    ).toThrow();
  });
});
