"use server";

import { z } from "zod";
import { CreditRulesInputSchema } from "@badabhai/pricing";
import { adminFetch, isAdminRequestError } from "../../../lib/admin-http";
import { describeAdminActionError } from "../../../lib/describe-admin-error";
import {
  CREDIT_RULES_REASON_MAX,
  CREDIT_RULES_REASON_MIN,
  fieldErrorsFromIssues,
  reasonTextError,
  type CreditRuleIssue,
  type SaveCreditRulesResult,
} from "../../../lib/credit-rules-model";
import { updatedCreditRulesResponseSchema } from "../../../lib/credit-rules";

const reasonSchema = z
  .string()
  .trim()
  .min(CREDIT_RULES_REASON_MIN)
  .max(CREDIT_RULES_REASON_MAX);

export interface SaveCreditRulesInput {
  rules: unknown;
  expectedRevision: number;
  reasonText: string;
}

function issuesFromBody(body: Record<string, unknown> | undefined): CreditRuleIssue[] {
  const raw = body?.issues;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    if (typeof item !== "object" || item === null) return [];
    const record = item as { path?: unknown; message?: unknown };
    // `ZodValidationPipe` serves each issue's path JOINED ("rules.higherCost"); a direct Zod
    // issue (the action's own schema) carries an array. Accept both.
    const path = Array.isArray(record.path)
      ? record.path.map(String)
      : typeof record.path === "string"
        ? record.path.split(".")
        : [];
    return [
      {
        path,
        message: typeof record.message === "string" ? record.message : "",
      },
    ];
  });
}

/**
 * `PUT /admin/credit-rules` — write the next revision (#2878).
 *
 * The body carries EVERY rule (the shared input schema refuses a partial set, so a missing key
 * is never silently reset to its default), the revision the admin loaded, and the written
 * reason. A 409 is the one refusal rendered as its own reload state; a 400 is mapped back onto
 * the field that caused it. The actor is the session cookie `adminFetch` already carries — no
 * id is ever sent in the body.
 */
export async function saveCreditRulesAction(
  input: SaveCreditRulesInput,
): Promise<SaveCreditRulesResult> {
  const parsedRules = CreditRulesInputSchema.safeParse(input.rules);
  if (!parsedRules.success) {
    return {
      ok: false,
      kind: "validation",
      error: "Some rules were refused. Check the highlighted fields.",
      fieldErrors: fieldErrorsFromIssues(parsedRules.error.issues),
    };
  }
  const parsedReason = reasonSchema.safeParse(input.reasonText);
  if (!parsedReason.success) {
    return {
      ok: false,
      kind: "validation",
      error: "Add a written reason for this change.",
      fieldErrors: {
        reason: reasonTextError(input.reasonText) ?? "Add a clear reason for this change.",
      },
    };
  }
  if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 0) {
    return {
      ok: false,
      kind: "validation",
      error: "Reload the page to get the current revision before saving.",
      fieldErrors: { form: "Reload the page to get the current revision before saving." },
    };
  }

  try {
    const res = await adminFetch("/admin/credit-rules", {
      method: "PUT",
      body: {
        rules: parsedRules.data,
        expected_revision: input.expectedRevision,
        reason_text: parsedReason.data,
      },
      schema: updatedCreditRulesResponseSchema,
    });
    return {
      ok: true,
      rules: res.rules,
      defaults: res.defaults,
      revision: res.revision,
      source: res.source,
      updated_at: res.updated_at,
      changed: res.changed,
      changed_keys: res.changed_keys,
    };
  } catch (err) {
    if (isAdminRequestError(err) && err.status === 409) {
      return {
        ok: false,
        kind: "stale",
        error:
          "Someone saved the credit rules after you loaded them. Reload to see the newest revision, then make your change again.",
      };
    }
    if (isAdminRequestError(err) && err.status === 400) {
      const fieldErrors = fieldErrorsFromIssues(issuesFromBody(err.body));
      return {
        ok: false,
        kind: "validation",
        error: "Some values were refused. Check the highlighted fields.",
        fieldErrors:
          Object.keys(fieldErrors).length > 0
            ? fieldErrors
            : { form: "That change was refused. Check the values and try again." },
      };
    }
    return { ok: false, kind: "error", error: describeAdminActionError(err) };
  }
}
