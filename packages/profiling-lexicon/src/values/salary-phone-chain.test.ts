/**
 * Issue #2050 — a figure inside a phone-shaped run is not pay. The TypeScript half of
 * `apps/ai-service/tests/test_salary_phone_chain.py`; the rule lives in `data/salary.json`
 * (`phoneChain`, `phoneChainMinDigits`, `payRangeMaxRatio`, `payRangeRoundTo`) and both engines
 * read it. The parity corpus (family `salph`) runs both on the same rows.
 *
 * The matcher reads digits split by a space or a dash as separate numbers, so "mera number 98765
 * 43210 hai" recorded 98765, and with a want cue near it as the EXPECTED salary. A run of 9+ digits
 * on one line joined only by spaces or dashes is phone-shaped, and none of its figures is recorded,
 * unless it is a pay range: two round, rising figures at most 5x apart (#1731's rule; a space-joined
 * pair counts too, owner decision 2026-10-07). All inputs are fabricated.
 */

import { describe, expect, it } from "vitest";

import { detectSalaries } from "./salary.js";

const NBSP = String.fromCharCode(0xa0);
const EN_DASH = String.fromCharCode(0x2013);

function devanagari(digits: string): string {
  return [...digits]
    .map((d) => (d >= "0" && d <= "9" ? String.fromCharCode(0x966 + Number(d)) : d))
    .join("");
}

function reading(text: string): [number | null, number | null] {
  const { current, expected } = detectSalaries(text);
  return [current?.value ?? null, expected?.value ?? null];
}

describe("a phone's groups are not pay (issue #2050)", () => {
  it.each([
    "mera number 98765 43210 hai",
    "phone 98765-43210",
    "mera number 9876 543 210",
    "mera number 987 654 3210",
    "+91 98765 43210",
    "call 098765 43210",
    `whatsapp 98765${NBSP}43210 pe`,
    `number 98765${EN_DASH}43210`,
    `${devanagari("98765 43210")} mera number hai`,
    "job chahiye mera number 98765 43210",
  ])("records no pay from %j", (text) => {
    expect(reading(text)).toEqual([null, null]);
  });

  it.each([
    ["number 98765 43210, salary 25000", [25000, null]],
    ["job chahiye, 20000 chahiye, mera number 98765 43210", [null, 20000]],
    ["salary 25000, number 98765 43210", [25000, null]],
  ] as const)("records the wage beside a phone in %j", (text, now) => {
    expect(reading(text)).toEqual(now);
  });
});

describe("wages and pay ranges read as before", () => {
  it.each([
    ["15000-20000 chahiye", [15000, 20000]],
    [`18500${EN_DASH}22000 milta hai`, [18500, null]],
    ["60000-70000", [60000, null]],
    ["5000 6000 milta hai", [5000, null]],
    ["abhi 25000 milta hai, 30000 chahiye", [25000, 30000]],
    ["25,000 - 30,000 chahiye", [25000, 30000]],
    ["25000\n35000 chahiye", [25000, 35000]],
    // DECIDED (owner, 2026-10-07): a space-joined round, rising pair is a range too.
    ["salary 15000 18000", [15000, null]],
    ["25000 30000 ke beech chahiye", [25000, null]],
  ] as const)("reads %j", (text, now) => {
    expect(reading(text)).toEqual(now);
  });

  it.each(["10000-90000", "25000-20000", "20050-25000", "20000-20000", "12345 6789"])(
    "records nothing from %j, a phone-length run that is no pay range (#1731's rule)",
    (text) => {
      expect(reading(text)).toEqual([null, null]);
    },
  );

  it("DECIDED: a wage glued to a phone by a space is not recorded", () => {
    // One 15-digit run and no range: prefer no number over a wrong one.
    expect(reading("salary 25000 98765 43210")).toEqual([null, null]);
  });

  it("KNOWN_RESIDUAL: a phone split by a line break is not joined, so its first group is pay", () => {
    // A line break separates two answers ("25000\n35000 chahiye"); the gateway still masks it.
    expect(reading("98765\n43210")).toEqual([98765, null]);
  });
});

describe("the phone-chain scan is linear", () => {
  it.each([
    ["1 ".repeat(10_000)],
    ["1-".repeat(10_000)],
    [`1${" ".repeat(19_998)}x`],
    ["98765 43210 ".repeat(1_666)],
  ])(
    "detects within budget at the size cap",
    (text) => {
      // A generous ceiling (#1941); measured 2026-10-07 at a few ms per input.
      const started = performance.now();
      detectSalaries(text);
      expect(performance.now() - started).toBeLessThan(2_000);
    },
    30_000,
  );
});
