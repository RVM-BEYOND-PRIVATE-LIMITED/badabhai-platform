import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import type { PiiCryptoService } from "../common/pii-crypto.service";
import type { EmployerNameRepository } from "./employer-name.repository";
import {
  buildEmployerSnapshot,
  EMPLOYER_INDEX_TTL_MS,
  EmployerNameIndex,
  normaliseEmployerName,
  snapshotMatches,
} from "./employer-name-index.service";

/**
 * TD147(1), WP7 — the employer-name index. Pure matching first, then the cache and its soft
 * failures.
 */

const NAMES = ["Tata Motors", "Maruti Suzuki", "Steel Authority of India", "Bharat Forge Ltd"];

describe("normaliseEmployerName — the ONE form the loader and the matcher share", () => {
  it.each([
    ["TATA MOTORS LTD.", ["tata", "motors"]],
    ["Maruti Suzuki", ["maruti", "suzuki"]],
    ["Bharat Forge Limited", ["bharat", "forge"]],
    ["Sharma Engineering Pvt. Ltd", ["sharma", "engineering"]],
    ["  Tata   Steel  ", ["tata", "steel"]],
    ["RVM‐Beyond Private Limited", ["rvm", "beyond"]],
  ])("%j → %j", (raw, expected) => {
    expect(normaliseEmployerName(raw)).toEqual(expected);
  });

  it("a suffix-only name keeps its one word (never strips itself away)", () => {
    expect(normaliseEmployerName("Limited")).toEqual(["limited"]);
  });
});

describe("snapshotMatches — whole tokens and multi-word phrases", () => {
  const snapshot = buildEmployerSnapshot(NAMES, 0);

  it.each([
    ["apply at Tata Motors or Maruti", "the task's own fixture"],
    ["Tata mein kaam mil sakta hai", "a distinctive token alone"],
    ["Maruti Suzuki ke liye apply kariye", "a full phrase"],
    ["Steel Authority of India mein vacancy hai", "a three-word phrase"],
    ["bharat forge ka welder", "lowercase input"],
  ])("%j → matched (%s)", (text, _why) => {
    expect(snapshotMatches(snapshot, text)).toBe(true);
  });

  it.each([
    ["steel", "the generic token alone"],
    ["motors", "the generic token alone"],
    ["steel motors", "two generic tokens, no phrase"],
    ["Welding aur fitting seekhiye", "no employer word at all"],
    ["safety policy yaad rakhiye", "ordinary career copy"],
    ["India mein kaam bahut hai", "a generic country token"],
  ])("%j → NOT matched (%s)", (text, _why) => {
    expect(snapshotMatches(snapshot, text)).toBe(false);
  });

  it("an empty snapshot never matches", () => {
    expect(snapshotMatches(buildEmployerSnapshot([], 0), "Tata Motors")).toBe(false);
  });
});

function setup(opts: { names?: string[]; throws?: boolean } = {}) {
  const repo = {
    listPayerOrgNameTokens: vi.fn(async () => {
      if (opts.throws) throw new Error("db down");
      return (opts.names ?? NAMES).map((n) => `enc:${n}`);
    }),
    listEmployerNameTokens: vi.fn(async () => {
      if (opts.throws) throw new Error("db down");
      return [];
    }),
  };
  const display = {
    decrypt: vi.fn((token: string) => {
      if (token.endsWith("bad-token")) throw new Error("unknown kid");
      return token.replace(/^enc:/, "");
    }),
  };
  return {
    index: new EmployerNameIndex(
      repo as unknown as EmployerNameRepository,
      display as unknown as PiiCryptoService,
    ),
    repo,
    display,
  };
}

describe("EmployerNameIndex — the 15-minute cache, and fail closed", () => {
  it("loads once, serves from cache inside the TTL, and refreshes after it", async () => {
    const h = setup();
    const t0 = 1_000_000;
    expect(await h.index.snapshotOrLoad(t0)).not.toBeNull();
    expect(h.repo.listPayerOrgNameTokens).toHaveBeenCalledTimes(1);
    expect(await h.index.snapshotOrLoad(t0 + EMPLOYER_INDEX_TTL_MS - 1)).not.toBeNull();
    expect(h.repo.listPayerOrgNameTokens).toHaveBeenCalledTimes(1);
    // The TTL boundary itself reloads (strict `<` inside).
    expect(await h.index.snapshotOrLoad(t0 + EMPLOYER_INDEX_TTL_MS)).not.toBeNull();
    expect(h.repo.listPayerOrgNameTokens).toHaveBeenCalledTimes(2);
  });

  it("isKnownEmployer reads the same snapshot the TTL serves", async () => {
    const h = setup();
    expect(await h.index.isKnownEmployer("Tata Motors")).toBe(true);
    expect(await h.index.isKnownEmployer("Maruti")).toBe(true);
    expect(h.repo.listPayerOrgNameTokens).toHaveBeenCalledTimes(1);
  });

  it("answers null when it has never loaded — the caller keeps the heuristic", async () => {
    const h = setup({ throws: true });
    vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    expect(await h.index.isKnownEmployer("Tata Motors")).toBeNull();
  });

  it("a failing refresh keeps the last good snapshot (stale beats none)", async () => {
    const h = setup();
    vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    expect(await h.index.isKnownEmployer("Tata Motors")).toBe(true);
    h.repo.listPayerOrgNameTokens.mockRejectedValueOnce(new Error("db down"));
    h.repo.listEmployerNameTokens.mockRejectedValueOnce(new Error("db down"));
    expect(await h.index.snapshotOrLoad(EMPLOYER_INDEX_TTL_MS + 1)).not.toBeNull();
    expect(await h.index.isKnownEmployer("Tata Motors")).toBe(true);
  });

  it("a name token that cannot be decrypted is skipped, counted, never logged as a name", async () => {
    const h = setup({ names: ["Tata Motors", "bad-token"] });
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    expect(await h.index.isKnownEmployer("Tata Motors")).toBe(true);
    expect(warn.mock.calls.map((c) => String(c[0])).join("\n")).toContain("1 unreadable");
    expect(warn.mock.calls.map((c) => String(c[0])).join("\n")).not.toContain("bad-token");
  });
});
