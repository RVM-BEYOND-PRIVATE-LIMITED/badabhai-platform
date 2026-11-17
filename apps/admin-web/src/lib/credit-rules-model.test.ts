import { describe, expect, it } from "vitest";
import {
  CREDIT_RULE_KEYS,
  CreditRulesInputSchema,
  DEFAULT_CREDIT_RULES,
  type CreditRules,
} from "@badabhai/pricing";
import {
  CREDIT_RULE_FIELDS,
  CREDIT_RULES_REASON_MAX,
  CREDIT_RULES_REASON_MIN,
  creditRuleField,
  fieldErrorsFromIssues,
  formValuesFromRules,
  validateCreditRulesForm,
  type CreditRuleFormValues,
} from "./credit-rules-model";

const values = (rules: CreditRules = DEFAULT_CREDIT_RULES): CreditRuleFormValues =>
  formValuesFromRules(rules);
const REASON = "Changed after the owner reviewed the brief's credit rules";

describe("the rule fields", () => {
  it("cover every schema key, in the schema's order", () => {
    expect(CREDIT_RULE_FIELDS.map((f) => f.key)).toEqual([...CREDIT_RULE_KEYS]);
    for (const field of CREDIT_RULE_FIELDS) {
      expect(field.label, field.key).toBeTruthy();
      expect(field.help, field.key).toBeTruthy();
      expect(creditRuleField(field.key)).toBe(field);
    }
  });

  it("keeps each declared bound at the schema's own edge", () => {
    for (const field of CREDIT_RULE_FIELDS) {
      const at = (value: number): CreditRules => {
        const next = { ...DEFAULT_CREDIT_RULES, [field.key]: value };
        // `higherCost` must not fall below `standardCost`; only the standard-cost edge needs
        // company, and the schema's refine is what proves it.
        if (field.key === "standardCost") next.higherCost = Math.max(next.higherCost, value);
        return next;
      };
      expect(CreditRulesInputSchema.safeParse(at(field.min)).success, `${field.key} min`).toBe(
        true,
      );
      expect(CreditRulesInputSchema.safeParse(at(field.max)).success, `${field.key} max`).toBe(
        true,
      );
      expect(
        CreditRulesInputSchema.safeParse(at(field.min - 1)).success,
        `${field.key} below min`,
      ).toBe(false);
      expect(
        CreditRulesInputSchema.safeParse(at(field.max + 1)).success,
        `${field.key} above max`,
      ).toBe(false);
    }
  });
});

describe("validateCreditRulesForm", () => {
  it("accepts the brief's values and a full reason", () => {
    const result = validateCreditRulesForm({ values: values(), reason: REASON });
    expect(result).toEqual({ ok: true, rules: DEFAULT_CREDIT_RULES });
  });

  it("treats whitespace around a number as the number", () => {
    const result = validateCreditRulesForm({
      values: { ...values(), higherCost: " 3 " },
      reason: REASON,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.rules.higherCost).toBe(3);
  });

  it("refuses a blank, fractional or out-of-bounds value on its own field", () => {
    for (const [key, raw] of [
      ["welcomeCredits", ""],
      ["welcomeCredits", "1.5"],
      ["welcomeCredits", "101"],
      ["standardCost", "0"],
    ] as const) {
      const result = validateCreditRulesForm({
        values: { ...values(), [key]: raw },
        reason: REASON,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors[key], `${key}=${raw || "<blank>"}`).toBeTruthy();
        expect(result.errors.reason).toBeUndefined();
      }
    }
  });

  it("refuses a higher cost below the standard cost, on the higher-cost field", () => {
    const result = validateCreditRulesForm({
      values: { ...values(), standardCost: "2", higherCost: "1" },
      reason: REASON,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.higherCost).toBe(
        "The higher cost must be at least the standard cost.",
      );
    }
  });

  it("needs a reason of 15–500 characters, trimmed", () => {
    for (const reason of ["", "short", " ".repeat(CREDIT_RULES_REASON_MIN), "x".repeat(CREDIT_RULES_REASON_MAX + 1)]) {
      const result = validateCreditRulesForm({ values: values(), reason });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors.reason).toBeTruthy();
    }
    expect(
      validateCreditRulesForm({ values: values(), reason: `  ${REASON}  ` }).ok,
    ).toBe(true);
  });
});

describe("fieldErrorsFromIssues", () => {
  it("maps a nested rules path to that rule's field", () => {
    expect(
      fieldErrorsFromIssues([
        { path: ["rules", "welcomeCredits"], message: "Too big" },
      ]),
    ).toEqual({
      welcomeCredits: "Enter a whole number from 0 to 100.",
    });
  });

  it("recognises the higher-cost refinement", () => {
    expect(
      fieldErrorsFromIssues([
        { path: ["rules", "higherCost"], message: "higherCost must be at least standardCost" },
      ]),
    ).toEqual({
      higherCost: "The higher cost must be at least the standard cost.",
    });
  });

  it("maps the reason fields, including the hard-identifier refusal", () => {
    expect(
      fieldErrorsFromIssues([
        { path: ["reason_text"], message: "Reason must be at least 15 characters" },
      ]),
    ).toEqual({ reason: "Use at least 15 characters." });
    expect(
      fieldErrorsFromIssues([
        {
          path: ["reason_text"],
          message: "Reason must not contain an email, phone number or other hard identifier",
        },
      ]),
    ).toEqual({ reason: "Remove any email address or phone number from the reason." });
  });

  it("puts anything it cannot place on the form itself", () => {
    expect(fieldErrorsFromIssues([{ path: [], message: "Unrecognized key" }])).toEqual({
      form: "That change was refused. Check the values and try again.",
    });
  });
});
