import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEMO_PHONE_PREFIX, RESERVED_TEST_PHONE_PATTERN } from "@badabhai/db";
import { RESERVED_SLOTS, SLOT_SIZE, syntheticPhoneMinter } from "./helpers/synthetic-phone";

/**
 * Guards the one-range-per-suite rule of `helpers/synthetic-phone.ts`. Runs in the `node` job
 * (turbo `test` covers this package, no path filter) as well as the e2e job, so a new suite that
 * mints from the shared block fails on every PR, not only on a PR that happens to run the e2e.
 */

const E2E_DIR = __dirname;
const suites = readdirSync(E2E_DIR)
  .filter((f) => f.endsWith(".e2e.test.ts"))
  .sort()
  .map((name) => ({ name, text: readFileSync(join(E2E_DIR, name), "utf8") }));

/** The reserved block spelled out: `91` then five zeros (any raw number in it contains this). */
const RAW_RESERVED_NUMBER = /910{5}/;
const MINTER_CALL = /syntheticPhoneMinter\(([^)]*)\)/g;

describe("e2e synthetic phones: one slot per suite", () => {
  it("finds the suites", () => {
    expect(suites.length).toBeGreaterThan(0);
  });

  it("no suite spells a raw reserved-block number", () => {
    const offenders = suites.filter((s) => RAW_RESERVED_NUMBER.test(s.text)).map((s) => s.name);
    expect(offenders, "mint phones with syntheticPhoneMinter(<your slot>) instead").toEqual([]);
  });

  it("every suite that logs a worker in through the test-login seam takes a slot", () => {
    const missing = suites
      .filter(
        (s) => s.text.includes("/auth/test-login") && !s.text.includes("syntheticPhoneMinter("),
      )
      .map((s) => s.name);
    expect(missing).toEqual([]);
  });

  it("each suite claims at most one slot, as a literal, unreserved, and no two suites share one", () => {
    const owner = new Map<number, string>();
    const problems: string[] = [];
    for (const s of suites) {
      const args = [...s.text.matchAll(MINTER_CALL)].map((m) => m[1]!.trim());
      if (args.length > 1) problems.push(`${s.name}: ${args.length} minters (one slot per suite)`);
      for (const arg of args) {
        if (!/^\d{1,2}$/.test(arg)) {
          problems.push(`${s.name}: slot "${arg}" is not a literal 0-99`);
          continue;
        }
        const slot = Number(arg);
        if (RESERVED_SLOTS.has(slot)) problems.push(`${s.name}: slot ${slot} is reserved`);
        const prior = owner.get(slot);
        if (prior !== undefined)
          problems.push(`${s.name}: slot ${slot} already belongs to ${prior}`);
        else owner.set(slot, s.name);
      }
    }
    expect(problems).toEqual([]);
  });
});

describe("syntheticPhoneMinter", () => {
  it("hands out 1,000 distinct numbers inside its slot and the reserved block, then throws", () => {
    const mint = syntheticPhoneMinter(64);
    const seen = new Set<string>();
    for (let i = 0; i < SLOT_SIZE; i += 1) {
      const phone = mint();
      expect(phone).toMatch(RESERVED_TEST_PHONE_PATTERN);
      expect(phone.slice(-5, -3)).toBe("64");
      seen.add(phone);
    }
    expect(seen.size).toBe(SLOT_SIZE);
    expect(() => mint()).toThrow(/exhausted/);
  });

  it("pads a one-digit slot to two digits", () => {
    expect(syntheticPhoneMinter(7)().slice(-5, -3)).toBe("07");
  });

  it("refuses reserved and out-of-range slots", () => {
    for (const slot of RESERVED_SLOTS) expect(() => syntheticPhoneMinter(slot)).toThrow(/reserved/);
    for (const slot of [-1, 100, 1.5, Number.NaN]) {
      expect(() => syntheticPhoneMinter(slot)).toThrow(/0-99/);
    }
  });

  it("reserves the Matching V1 demo block's slot", () => {
    // DEMO_PHONE_PREFIX is the reserved block's eight characters plus the slot's two digits.
    expect(DEMO_PHONE_PREFIX).toHaveLength(10);
    expect(RESERVED_SLOTS.has(Number(DEMO_PHONE_PREFIX.slice(8)))).toBe(true);
  });
});
