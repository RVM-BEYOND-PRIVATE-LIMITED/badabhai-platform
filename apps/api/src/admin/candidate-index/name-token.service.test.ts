import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import {
  computeNameTokens,
  NameTokenService,
  parseNameTokenKeyring,
} from "./name-token.service";

const KEY_HEX = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const KEY = Buffer.from(KEY_HEX, "hex");
const OTHER_KEY_HEX = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
const KID = "2026-11-a";

function configWith(keys: string, kid: string) {
  return { ADMIN_NAME_TOKEN_KEYS: keys, ADMIN_NAME_TOKEN_ACTIVE_KID: kid } as never;
}

describe("parseNameTokenKeyring (ADR-0062 §3.6 — dedicated keyring, fail closed)", () => {
  it("parses a valid keyring", () => {
    const ring = parseNameTokenKeyring(JSON.stringify({ [KID]: KEY_HEX }), KID);
    expect(ring?.activeKid).toBe(KID);
    expect(ring?.keys.get(KID)).toEqual(KEY);
  });

  it("is null when unset (name search unavailable, fail closed)", () => {
    expect(parseNameTokenKeyring("", "")).toBeNull();
    expect(parseNameTokenKeyring("", KID)).toBeNull();
    expect(parseNameTokenKeyring(JSON.stringify({ [KID]: KEY_HEX }), "")).toBeNull();
  });

  it("is null on malformed input (bad JSON, non-object, short key, unknown kid)", () => {
    expect(parseNameTokenKeyring("not-json", KID)).toBeNull();
    expect(parseNameTokenKeyring("[]", KID)).toBeNull();
    expect(parseNameTokenKeyring(JSON.stringify({ [KID]: "abc" }), KID)).toBeNull();
    expect(parseNameTokenKeyring(JSON.stringify({ [KID]: KEY_HEX }), "nope")).toBeNull();
  });
});

describe("computeNameTokens (canonical word tokens)", () => {
  it("is deterministic and hex HMAC-SHA256", () => {
    const a = computeNameTokens("Ramesh Kumar", KEY);
    expect(a).toEqual(computeNameTokens("Ramesh Kumar", KEY));
    expect(a).toHaveLength(2);
    expect(a.every((t) => /^[0-9a-f]{64}$/.test(t))).toBe(true);
  });

  it("de-duplicates repeated words and stores hash order (not name order)", () => {
    const repeated = computeNameTokens("Ramesh Ramesh Kumar", KEY);
    const once = computeNameTokens("Ramesh Kumar", KEY);
    expect(repeated).toEqual(once);
    expect([...once].sort()).toEqual(once);
  });

  it("drops sub-2-code-point words (K in K.Suresh is not indexed)", () => {
    expect(computeNameTokens("K Suresh", KEY)).toEqual(computeNameTokens("Suresh", KEY));
  });

  it("splits on separators (K.Suresh and Ram-Prasad are words, not blobs)", () => {
    expect(computeNameTokens("K.Suresh", KEY)).toEqual(computeNameTokens("Suresh", KEY));
    expect(computeNameTokens("Ram-Prasad", KEY)).toEqual(
      computeNameTokens("Ram Prasad", KEY),
    );
  });

  it("is case-insensitive", () => {
    expect(computeNameTokens("RAMESH kumar", KEY)).toEqual(computeNameTokens("Ramesh Kumar", KEY));
  });

  it("a different key gives different tokens (key separation)", () => {
    expect(computeNameTokens("Ramesh Kumar", KEY)).not.toEqual(
      computeNameTokens("Ramesh Kumar", Buffer.from(OTHER_KEY_HEX, "hex")),
    );
  });
});

describe("NameTokenService.tokenise (fail closed)", () => {
  it("tokenises under the active kid", () => {
    const svc = new NameTokenService(
      configWith(JSON.stringify({ [KID]: KEY_HEX }), KID),
    );
    expect(svc.tokenise("Ramesh Kumar")).toEqual({
      hashes: computeNameTokens("Ramesh Kumar", KEY),
      kid: KID,
    });
  });

  it("returns empty + null kid without a keyring, a null name or a blank name", () => {
    const svc = new NameTokenService(configWith("", ""));
    expect(svc.tokenise("Ramesh Kumar")).toEqual({ hashes: [], kid: null });
    const armed = new NameTokenService(configWith(JSON.stringify({ [KID]: KEY_HEX }), KID));
    expect(armed.tokenise(null)).toEqual({ hashes: [], kid: null });
    expect(armed.tokenise("   ")).toEqual({ hashes: [], kid: null });
  });

  it("never logs, emits or returns the name (no-PII regression)", () => {
    const svc = new NameTokenService(configWith(JSON.stringify({ [KID]: KEY_HEX }), KID));
    const sink: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      sink.push(args.map(String).join(" "));
    });
    const out = svc.tokenise("Uncommonname Qwerty");
    spy.mockRestore();
    expect(sink.join(" ")).not.toContain("Uncommonname");
    expect(JSON.stringify(out)).not.toContain("Uncommonname");
  });
});
