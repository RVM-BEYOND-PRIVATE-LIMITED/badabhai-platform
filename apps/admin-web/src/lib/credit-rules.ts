import "server-only";
import { z } from "zod";
import { CreditRulesSchema, DEFAULT_CREDIT_RULES } from "@badabhai/pricing";
import { adminFetch } from "./admin-http";
import type { CreditRulesSnapshot, CreditRulesSource } from "./credit-rules-model";

/**
 * `GET /admin/credit-rules` (#2878).
 *
 * The response is validated, not trusted: the active rules, the brief's defaults and the
 * revision the edit will be checked against. `defaults` falls back to the package's frozen
 * defaults if an older server omits them, so the form can still say what each rule started at.
 */
export const creditRulesResponseSchema = z.object({
  rules: CreditRulesSchema,
  defaults: CreditRulesSchema.default(DEFAULT_CREDIT_RULES),
  revision: z.number().int().min(0),
  source: z.enum(["db", "default"]),
  updated_at: z.string().nullable(),
});

export type CreditRulesResponse = z.infer<typeof creditRulesResponseSchema>;

export const updatedCreditRulesResponseSchema = creditRulesResponseSchema.extend({
  changed: z.boolean(),
  changed_keys: z.array(z.string()),
});

export type UpdatedCreditRulesResponse = z.infer<typeof updatedCreditRulesResponseSchema>;

export function getCreditRules(): Promise<CreditRulesSnapshot> {
  return adminFetch("/admin/credit-rules", { schema: creditRulesResponseSchema });
}

export type { CreditRulesSnapshot, CreditRulesSource };
