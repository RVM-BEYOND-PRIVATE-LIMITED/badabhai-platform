import {
  CREDIT_RULE_KEYS,
  CreditRulesInputSchema,
  type CreditRuleKey,
  type CreditRules,
} from "@badabhai/pricing";

/**
 * The credit rules' presentation model (#2878).
 *
 * The schema, its bounds and the brief's defaults live in `@badabhai/pricing` — this file only
 * gives each rule the words an operator reads, parses the form's string inputs, and maps a
 * refusal onto the field that caused it. It is deliberately pure and client-safe: the client
 * form validates with it, and `credit-rules-model.test.ts` holds every bound here to the schema
 * so the copy cannot drift from the rule.
 */

export type CreditRulesSource = "db" | "default";

/** The server's `GET`/successful `PUT` shape, shared by the page and the client form. */
export interface CreditRulesSnapshot {
  rules: CreditRules;
  defaults: CreditRules;
  revision: number;
  source: CreditRulesSource;
  updated_at: string | null;
}

export interface CreditRuleField {
  key: CreditRuleKey;
  label: string;
  help: string;
  min: number;
  max: number;
}

/**
 * One entry per rule, in the schema's own key order. The bound is repeated only as the help
 * text's source; the schema stays the authority and the test proves the two agree.
 */
export const CREDIT_RULE_FIELDS: readonly CreditRuleField[] = Object.freeze([
  {
    key: "standardCost",
    label: "Standard contact cost",
    help: "Credits to open one contact at the standard cost.",
    min: 1,
    max: 10,
  },
  {
    key: "higherCost",
    label: "Higher contact cost",
    help: "Credits to open one contact at the higher cost. It must be at least the standard cost.",
    min: 1,
    max: 20,
  },
  {
    key: "higherCostMinMonths",
    label: "Higher cost after (months)",
    help: "Months in the higher-priced trade at which the higher cost starts.",
    min: 1,
    max: 600,
  },
  {
    key: "welcomeCredits",
    label: "Welcome credits",
    help: "Given once per verified company, after its first approved post.",
    min: 0,
    max: 100,
  },
  {
    key: "welcomeValidityDays",
    label: "Welcome credit validity (days)",
    help: "How long the welcome credits last.",
    min: 1,
    max: 365,
  },
  {
    key: "workerWeeklyOpenLimit",
    label: "Worker weekly open limit",
    help: "First-time opens of one worker, across all companies, in a rolling 7 days.",
    min: 1,
    max: 100,
  },
  {
    key: "agencyDailyOpenLimit",
    label: "Agency daily open limit",
    help: "Opens per IST day for an agency or contractor account.",
    min: 1,
    max: 1000,
  },
  {
    key: "couldntReachWindowDays",
    label: "Couldn't-reach window (days)",
    help: "Days after an open in which a couldn't-reach report is accepted.",
    min: 1,
    max: 60,
  },
  {
    key: "deskWindowHours",
    label: "Worker desk window (hours)",
    help: "Hours the worker desk has before the credits return.",
    min: 1,
    max: 720,
  },
  {
    key: "returnedCreditsMax",
    label: "Returned credits cap",
    help: "Most unused credits returned with a new pack.",
    min: 0,
    max: 1000,
  },
  {
    key: "returnedCreditsWindowMonths",
    label: "Returned credits window (months)",
    help: "Months after the old pack's expiry in which a new pack brings them back.",
    min: 0,
    max: 36,
  },
  {
    key: "returnedLotValidityDays",
    label: "Returned lot validity (days)",
    help: "Validity of a credit returned after its lot expired.",
    min: 1,
    max: 365,
  },
  {
    key: "refundUnusedWithinDays",
    label: "Unused-pack refund window (days)",
    help: "Refund rule 1: an unused pack within this many days of purchase.",
    min: 0,
    max: 90,
  },
  {
    key: "refundLowMatchWithinDays",
    label: "Low-match refund window (days)",
    help: "Refund rule 2: an unused pack within this many days.",
    min: 0,
    max: 90,
  },
  {
    key: "refundLowMatchMinWorkers",
    label: "Low-match threshold (workers)",
    help: "Refund rule 2 applies if the job drew fewer than this many matching workers.",
    min: 1,
    max: 100,
  },
  {
    key: "goodwillMaxPerQuarter",
    label: "Goodwill cap per quarter",
    help: "Most goodwill credits per company per IST calendar quarter.",
    min: 0,
    max: 1000,
  },
  {
    key: "goodwillValidityDays",
    label: "Goodwill credit validity (days)",
    help: "How long goodwill credits last.",
    min: 1,
    max: 365,
  },
]);

export const CREDIT_RULES_REASON_MIN = 15;
export const CREDIT_RULES_REASON_MAX = 500;

const FIELD_BY_KEY = new Map<CreditRuleKey, CreditRuleField>(
  CREDIT_RULE_FIELDS.map((field) => [field.key, field]),
);

export function isCreditRuleKey(value: string): value is CreditRuleKey {
  return (CREDIT_RULE_KEYS as readonly string[]).includes(value);
}

export function creditRuleField(key: CreditRuleKey): CreditRuleField {
  return FIELD_BY_KEY.get(key)!;
}

export function creditRuleLabel(key: CreditRuleKey): string {
  return creditRuleField(key).label;
}

/** The form keeps raw strings so a field can be cleared while it is being retyped. */
export type CreditRuleFormValues = Record<CreditRuleKey, string>;

export function formValuesFromRules(rules: CreditRules): CreditRuleFormValues {
  return Object.fromEntries(
    CREDIT_RULE_KEYS.map((key) => [key, String(rules[key])]),
  ) as CreditRuleFormValues;
}

export type CreditRulesFieldKey = CreditRuleKey | "reason" | "form";
export type CreditRulesFieldErrors = Partial<Record<CreditRulesFieldKey, string>>;

export function reasonTextError(reason: string): string | null {
  const trimmed = reason.trim();
  if (trimmed.length === 0) return "Add a written reason for this change.";
  if (trimmed.length < CREDIT_RULES_REASON_MIN) {
    return `Use at least ${CREDIT_RULES_REASON_MIN} characters.`;
  }
  if (trimmed.length > CREDIT_RULES_REASON_MAX) {
    return `Use at most ${CREDIT_RULES_REASON_MAX} characters.`;
  }
  return null;
}

function valueError(field: CreditRuleField, raw: string): string | null {
  const value = raw.trim();
  if (value === "") return "Enter a number.";
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return "Enter a whole number.";
  if (parsed < field.min || parsed > field.max) {
    return `Enter a whole number from ${field.min} to ${field.max}.`;
  }
  return null;
}

export interface CreditRuleIssue {
  path: readonly PropertyKey[];
  message: string;
}

function reasonIssueError(message: string): string {
  if (/at least\s+15/i.test(message)) return `Use at least ${CREDIT_RULES_REASON_MIN} characters.`;
  if (/at most\s+500/i.test(message)) return `Use at most ${CREDIT_RULES_REASON_MAX} characters.`;
  if (/email|phone|identifier/i.test(message)) {
    return "Remove any email address or phone number from the reason.";
  }
  return `Add a clear reason between ${CREDIT_RULES_REASON_MIN} and ${CREDIT_RULES_REASON_MAX} characters.`;
}

/**
 * Map Zod/API issues onto the field that caused them. The server's message is a lookup only;
 * the sentence shown is ours, and no wire text reaches the operator.
 */
export function fieldErrorsFromIssues(issues: readonly CreditRuleIssue[]): CreditRulesFieldErrors {
  const errors: CreditRulesFieldErrors = {};
  for (const issue of issues) {
    const path = issue.path.map(String);
    const key = path[0] === "rules" ? path[1] : path[0];
    if (key === "reason" || key === "reason_text") {
      errors.reason = reasonIssueError(issue.message);
      continue;
    }
    if (key !== undefined && isCreditRuleKey(key)) {
      const field = creditRuleField(key);
      errors[key] =
        key === "higherCost" && /at least/i.test(issue.message)
          ? "The higher cost must be at least the standard cost."
          : `Enter a whole number from ${field.min} to ${field.max}.`;
      continue;
    }
    errors.form = "That change was refused. Check the values and try again.";
  }
  return errors;
}

export type CreditRulesFormValidation =
  | { ok: true; rules: CreditRules }
  | { ok: false; errors: CreditRulesFieldErrors };

/** Validate the form's raw strings and reason, then let the shared schema make the final call. */
export function validateCreditRulesForm(input: {
  values: CreditRuleFormValues;
  reason: string;
}): CreditRulesFormValidation {
  const errors: CreditRulesFieldErrors = {};
  for (const field of CREDIT_RULE_FIELDS) {
    const error = valueError(field, input.values[field.key]);
    if (error) errors[field.key] = error;
  }
  const reasonError = reasonTextError(input.reason);
  if (reasonError) errors.reason = reasonError;
  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const candidate = Object.fromEntries(
    CREDIT_RULE_KEYS.map((key) => [key, Number(input.values[key].trim())]),
  );
  const parsed = CreditRulesInputSchema.safeParse(candidate);
  if (!parsed.success) {
    const mapped = fieldErrorsFromIssues(parsed.error.issues);
    return {
      ok: false,
      errors:
        Object.keys(mapped).length > 0
          ? mapped
          : { form: "That change was refused. Check the values and try again." },
    };
  }
  return { ok: true, rules: parsed.data };
}

export type SaveCreditRulesResult =
  | ({ ok: true; changed: boolean; changed_keys: string[] } & CreditRulesSnapshot)
  | {
      ok: false;
      kind: "stale" | "validation" | "error";
      error: string;
      fieldErrors?: CreditRulesFieldErrors;
    };
