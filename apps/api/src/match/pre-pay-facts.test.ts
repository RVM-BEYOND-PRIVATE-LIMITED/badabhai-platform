import { describe, expect, it } from "vitest";
import { MACHINES, ROLES } from "@badabhai/taxonomy";
import {
  applicantSourceOf,
  EMPTY_PRE_PAY_FACTS,
  expectedSalaryOf,
  firstNameOf,
  lastActiveOnOf,
  PRE_PAY_FACT_KEYS,
  PRE_PAY_MACHINES_MAX,
  toPrePayFacts,
  tradeLineOf,
  type PrePayFactsSourceRow,
} from "./pre-pay-facts";

/**
 * #2747 item 4 — the facts a company sees before paying. Pure: each rule is tested without a
 * database. Unknown stays unknown (`null`); no figure, city or trade is derived from another.
 */
const NOW = new Date("2026-11-15T12:00:00.000Z");

const row = (over: Partial<PrePayFactsSourceRow> = {}): PrePayFactsSourceRow => ({
  workerId: "11111111-1111-4111-8111-111111111111",
  fullName: null,
  workersCity: null,
  canonicalTradeId: null,
  canonicalRoleId: null,
  machineIds: null,
  salaryContainer: null,
  salaryExpectedMin: null,
  salaryExpectedMax: null,
  salaryPeriod: null,
  lastSeenAt: null,
  institute: null,
  overrides: new Map(),
  ...over,
});

const ROLE = ROLES[0]!;
const OTHER_ROLE = ROLES[1]!;

describe("applicantSourceOf", () => {
  it("labels an active RVM link as an RVM student and everything else as a BadaBhai worker", () => {
    expect(applicantSourceOf("rvm")).toBe("rvm_student");
    expect(applicantSourceOf(null)).toBe("badabhai_worker");
    expect(applicantSourceOf(undefined)).toBe("badabhai_worker");
    expect(applicantSourceOf("some_other_institute")).toBe("badabhai_worker");
  });
});

describe("toPrePayFacts", () => {
  it("returns every key, each null, for a worker with nothing stored", () => {
    const facts = toPrePayFacts(row(), NOW);
    expect(Object.keys(facts).sort()).toEqual([...PRE_PAY_FACT_KEYS].sort());
    expect(facts).toEqual(EMPTY_PRE_PAY_FACTS);
  });

  it("builds a full card from a full profile", () => {
    const machine = MACHINES[0]!;
    const facts = toPrePayFacts(
      row({
        fullName: "Ramesh Kumar Yadav",
        workersCity: "pune",
        canonicalRoleId: ROLE.id,
        machineIds: [machine.id],
        salaryExpectedMin: 24000,
        salaryExpectedMax: 28000,
        lastSeenAt: "2026-11-14T20:00:00.000Z",
      }),
      NOW,
    );
    expect(facts).toEqual({
      firstName: "Ramesh",
      tradeLine: ROLE.name,
      expectedSalary: "₹24,000 – ₹28,000 / month",
      machines: [machine.name],
      area: "Pune",
      lastActiveOn: "2026-11-15",
    });
  });

  it("never carries the surname anywhere on the card", () => {
    const facts = toPrePayFacts(row({ fullName: "Ramesh Kumar Yadav" }), NOW);
    expect(JSON.stringify(facts)).not.toMatch(/Kumar|Yadav/);
  });

  it("shows an RVM student's course as his trade line and his branch city as his area", () => {
    const facts = toPrePayFacts(
      row({
        workersCity: "Mumbai",
        canonicalRoleId: ROLE.id,
        institute: {
          instituteCode: "rvm",
          course: "  Diploma in CNC  Programming ",
          branch: "Pune",
        },
      }),
      NOW,
    );
    expect(facts.tradeLine).toBe("Diploma in CNC Programming");
    expect(facts.area).toBe("Pune");
  });

  it("falls back to his own trade and city when RVM reports no course and an unknown branch", () => {
    const facts = toPrePayFacts(
      row({
        workersCity: "Mumbai",
        canonicalRoleId: ROLE.id,
        institute: { instituteCode: "rvm", course: null, branch: "Main Campus Block B" },
      }),
      NOW,
    );
    expect(facts.tradeLine).toBe(ROLE.name);
    expect(facts.area).toBe("Mumbai");
  });

  it("caps a course name that a contract break made long", () => {
    const facts = toPrePayFacts(
      row({ institute: { instituteCode: "rvm", course: "x".repeat(300), branch: null } }),
      NOW,
    );
    expect(facts.tradeLine).toHaveLength(80);
  });

  it("does not show a city the gazetteer does not know", () => {
    expect(toPrePayFacts(row({ workersCity: "near the old bus stand" }), NOW).area).toBeNull();
  });

  it("applies a live admin correction to the city, the trade and the salary", () => {
    const facts = toPrePayFacts(
      row({
        workersCity: "Mumbai",
        canonicalRoleId: ROLE.id,
        salaryExpectedMin: 15000,
        overrides: new Map<string, unknown>([
          ["current_city", "Nagpur"],
          ["role", OTHER_ROLE.id],
          ["salary_expected", { min: 30000, max: null }],
        ]),
      }),
      NOW,
    );
    expect(facts.area).toBe("Nagpur");
    expect(facts.tradeLine).toBe(OTHER_ROLE.name);
    expect(facts.expectedSalary).toBe("₹30,000 / month");
  });

  it("dedupes and caps machines; blanks and non-strings drop; none is null", () => {
    const ids = MACHINES.slice(0, PRE_PAY_MACHINES_MAX + 3).map((m) => m.id);
    const facts = toPrePayFacts(row({ machineIds: [...ids, ids[0], "  ", 7] }), NOW);
    expect(facts.machines).toHaveLength(PRE_PAY_MACHINES_MAX);
    expect(toPrePayFacts(row({ machineIds: [] }), NOW).machines).toBeNull();
    expect(toPrePayFacts(row({ machineIds: ["  ", 7] }), NOW).machines).toBeNull();
    expect(toPrePayFacts(row({ machineIds: "not-an-array" }), NOW).machines).toBeNull();
  });

  it("shows only machine ids the taxonomy knows; a free-text phrase in the column never reaches the card", () => {
    const machine = MACHINES[0]!;
    const facts = toPrePayFacts(
      row({ machineIds: [machine.id, "lathe at Sharma Engineering, ask Ramesh 98xxxxxx"] }),
      NOW,
    );
    expect(facts.machines).toEqual([machine.name]);
  });

  it("does not show an RVM course name carrying a control, bidi or stray format character", () => {
    for (const course of ["CNC\u202Eevil", "CNC\u0007", "CNC\u200Bhidden"]) {
      const facts = toPrePayFacts(
        row({
          canonicalRoleId: ROLE.id,
          institute: { instituteCode: "rvm", course, branch: null },
        }),
        NOW,
      );
      expect(facts.tradeLine).toBe(ROLE.name);
    }
  });
});

describe("firstNameOf", () => {
  it("takes the first word, whatever the spacing or script", () => {
    expect(firstNameOf("  Sunita   Devi ")).toBe("Sunita");
    expect(firstNameOf("राम प्रसाद")).toBe("राम");
    expect(firstNameOf("Aslam")).toBe("Aslam");
  });

  it("is not given for an empty name, a phone number or an e-mail typed as a name", () => {
    expect(firstNameOf(null)).toBeNull();
    expect(firstNameOf("   ")).toBeNull();
    expect(firstNameOf("9876543210 Ramesh")).toBeNull();
    expect(firstNameOf("ramesh@example.com")).toBeNull();
    expect(firstNameOf("Ramesh2")).toBeNull();
  });

  it("cuts an over-long word", () => {
    expect(firstNameOf("a".repeat(100))).toHaveLength(40);
  });

  it("skips a leading honorific and bare initials", () => {
    expect(firstNameOf("Md. Aslam Khan")).toBe("Aslam");
    expect(firstNameOf("R. Ramesh Kumar")).toBe("Ramesh");
    expect(firstNameOf("Shri R K Sharma")).toBe("Sharma");
    expect(firstNameOf("Mr.")).toBeNull();
  });

  it("does not print a name carrying a control, bidi or stray format character", () => {
    expect(firstNameOf("Ramesh\u202E Kumar")).toBeNull();
    expect(firstNameOf("Ram\u0000esh")).toBeNull();
  });
});

describe("tradeLineOf", () => {
  it("reads the taxonomy only, never a free-text label", () => {
    expect(tradeLineOf(ROLE.id, null)).toBe(ROLE.name);
    expect(tradeLineOf(null, null)).toBeNull();
    expect(tradeLineOf("not_a_real_role_id", null)).toBeNull();
  });
});

describe("expectedSalaryOf", () => {
  it("prefers the extraction container over the worker's own band (the SALARY ×3 rule)", () => {
    expect(
      expectedSalaryOf(
        row({
          salaryContainer: { amount_min: 20000, amount_max: null },
          salaryExpectedMin: 25000,
          salaryExpectedMax: 30000,
        }),
      ),
    ).toBe("₹20,000 / month");
  });

  it("prints a one-sided band as a point figure and never widens it", () => {
    expect(expectedSalaryOf(row({ salaryExpectedMin: 18000 }))).toBe("₹18,000 / month");
    expect(expectedSalaryOf(row({ salaryExpectedMax: 22000 }))).toBe("₹22,000 / month");
  });

  it("collapses an inverted band to its lower figure", () => {
    expect(expectedSalaryOf(row({ salaryExpectedMin: 20000, salaryExpectedMax: 18000 }))).toBe(
      "₹20,000 / month",
    );
  });

  it("prints the form's open top chip as ₹50,000+, never its stored key", () => {
    expect(expectedSalaryOf(row({ salaryExpectedMax: 100_000 }))).toBe("₹50,000+ / month");
  });

  it("says a day or year rate in its own unit", () => {
    expect(expectedSalaryOf(row({ salaryExpectedMin: 800, salaryPeriod: "day" }))).toBe(
      "₹800 / day",
    );
    expect(expectedSalaryOf(row({ salaryExpectedMin: 300000, salaryPeriod: "year" }))).toBe(
      "₹3,00,000 / year",
    );
  });

  it("a figure from the extraction container says its own period, unless that is only the monthly default", () => {
    expect(
      expectedSalaryOf(
        row({ salaryContainer: { amount_min: 800, amount_max: null, period: "daily" } }),
      ),
    ).toBe("₹800 / day");
    expect(
      expectedSalaryOf(
        row({ salaryContainer: { amount_min: 20000, period: "monthly" }, salaryPeriod: "day" }),
      ),
    ).toBe("₹20,000 / day");
  });

  it("is not given when nothing was stated", () => {
    expect(expectedSalaryOf(row())).toBeNull();
    expect(
      expectedSalaryOf(row({ salaryContainer: { amount_min: null, amount_max: null } })),
    ).toBeNull();
  });
});

describe("lastActiveOnOf", () => {
  it("is the IST calendar day (18:30 UTC is IST midnight)", () => {
    expect(lastActiveOnOf("2026-11-14T18:29:59.000Z", NOW)).toBe("2026-11-14");
    expect(lastActiveOnOf("2026-11-14T18:30:00.000Z", NOW)).toBe("2026-11-15");
  });

  it("reads a future timestamp as today and an unparseable one as unknown", () => {
    expect(lastActiveOnOf("2027-01-01T00:00:00.000Z", NOW)).toBe("2026-11-15");
    expect(lastActiveOnOf("not a date", NOW)).toBeNull();
    expect(lastActiveOnOf(null, NOW)).toBeNull();
  });

  it("still shows the day long after (a date, not a band)", () => {
    expect(lastActiveOnOf(new Date("2025-03-02T06:00:00.000Z"), NOW)).toBe("2025-03-02");
  });
});
