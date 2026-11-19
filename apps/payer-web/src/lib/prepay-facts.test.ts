import { describe, expect, it } from "vitest";
import {
  NOT_GIVEN,
  factText,
  hasPrePayFacts,
  machinesText,
  prePayFactLines,
  salaryText,
} from "./prepay-facts";

/**
 * #2747 — facts before paying. Presence of the six keys is the only switch the client reads;
 * every missing value prints "not given" and the salary is printed exactly as sent.
 */
describe("facts before paying", () => {
  it("an all-null row still counts as ON and reads 'not given' six times", () => {
    const row = {
      firstName: null,
      tradeLine: null,
      expectedSalary: null,
      machines: null,
      area: null,
      lastActiveOn: null,
    };
    expect(hasPrePayFacts(row)).toBe(true);
    const lines = prePayFactLines(row);
    expect(lines).toHaveLength(6);
    expect(lines.map((l) => l.value)).toEqual(Array(6).fill(NOT_GIVEN));
    expect(lines.map((l) => l.label)).toEqual([
      "Name",
      "Trade",
      "Expected salary",
      "Machines",
      "Area",
      "Last active",
    ]);
  });

  it("a row with none of the keys is today's card", () => {
    expect(hasPrePayFacts({ workerId: "w" })).toBe(false);
  });

  it("the salary is printed exactly as sent, never rebuilt", () => {
    expect(salaryText("₹24,000 – ₹28,000 / month")).toBe("₹24,000 – ₹28,000 / month");
    expect(salaryText("₹50,000+ / month")).toBe("₹50,000+ / month");
    expect(salaryText(null)).toBe(NOT_GIVEN);
  });

  it("machines are a readable list; none is 'not given' (never blank)", () => {
    expect(machinesText(["VMC", "CNC lathe"])).toBe("VMC, CNC lathe");
    expect(machinesText([])).toBe(NOT_GIVEN);
    expect(machinesText(null)).toBe(NOT_GIVEN);
  });

  it("a blank string is not a fact", () => {
    expect(factText("   ")).toBe(NOT_GIVEN);
    expect(factText("Pune")).toBe("Pune");
  });
});
