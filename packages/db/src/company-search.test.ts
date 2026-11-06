/**
 * #2564 B10 — company search primitives. Pinned: normalization (so the API writer
 * and the backfill cannot drift), per-word hashing, and domain separation (a word
 * digest must never equal a phone/OTP/email/org digest even if the strings match).
 */
import { describe, expect, it } from "vitest";

import {
  companyNameWords,
  companyNameWordHashes,
  companySearchWordHash,
  gstinHash,
  normCompanyName,
  normGstin,
} from "./company-search";
import { hashOrgName, hmacValue } from "./crypto";

const PEPPER = "test-pepper";

describe("normCompanyName", () => {
  it("trims and case-folds, keeping inner spacing for the word split", () => {
    expect(normCompanyName("  Sharma TRADING  ")).toBe("sharma trading");
  });
});

describe("companyNameWords", () => {
  it("splits on whitespace runs, dedupes, drops empties, keeps order", () => {
    expect(companyNameWords("sharma  trading sharma ")).toEqual(["sharma", "trading"]);
    expect(companyNameWords("   ")).toEqual([]);
  });
});

describe("companyNameWordHashes", () => {
  it("hashes one digest per distinct word, deterministically", () => {
    const a = companyNameWordHashes("sharma trading", PEPPER);
    const b = companyNameWordHashes("sharma trading", PEPPER);
    expect(a).toHaveLength(2);
    expect(a).toEqual(b);
    expect(new Set(a).size).toBe(2);
  });

  it("hashes the NORMALIZED input (callers normalize first, like hashOrgName)", () => {
    expect(companyNameWordHashes(normCompanyName("  SHARMA TRADING  "), PEPPER)).toEqual(
      companyNameWordHashes("sharma trading", PEPPER),
    );
  });

  it("matches the single-word query digest for that word", () => {
    const hashes = companyNameWordHashes("sharma trading", PEPPER);
    expect(hashes).toContain(companySearchWordHash("Sharma", PEPPER));
    expect(hashes).not.toContain(companySearchWordHash("sharm", PEPPER));
  });

  it("is domain-separated from every other lookup hash", () => {
    const word = companySearchWordHash("sharma", PEPPER);
    // Same string, different domains — none may collide.
    expect(word).not.toBe(hashOrgName("sharma", PEPPER));
    expect(word).not.toBe(hmacValue("sharma", PEPPER));
  });
});

describe("gstinHash", () => {
  it("normalizes (trim, uppercase, no inner spaces) before hashing", () => {
    expect(normGstin("  27aabcs1234f1z5 ")).toBe("27AABCS1234F1Z5");
    expect(gstinHash(normGstin("27aabcs1234f1z5"), PEPPER)).toBe(
      gstinHash("27AABCS1234F1Z5", PEPPER),
    );
  });

  it("is deterministic and domain-separated", () => {
    const a = gstinHash("27AABCS1234F1Z5", PEPPER);
    expect(a).toBe(gstinHash("27AABCS1234F1Z5", PEPPER));
    expect(a).not.toBe(hmacValue("27AABCS1234F1Z5", PEPPER));
  });
});
