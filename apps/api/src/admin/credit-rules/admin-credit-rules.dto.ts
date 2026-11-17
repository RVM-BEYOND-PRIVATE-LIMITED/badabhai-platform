import { z } from "zod";
import { CreditRulesInputSchema, type CreditRuleKey, type CreditRules } from "@badabhai/pricing";
import { AdminPayerReasonTextSchema } from "../admin-payer-logins.dto";

/**
 * #2750 item 1 — the admin contract for the credit rules' settings.
 *
 * `PUT /admin/credit-rules` sends EVERY rule (a partial set is refused, so a missing key is never
 * silently reset to its default), the revision the admin loaded (`expected_revision`: 0 before
 * the first edit; a stale one is 409 and nothing is written), and a written reason (15–500
 * characters, no hard identifiers: it is stored on `audit_logs`).
 *
 * The rule keys keep their stored spelling (`standardCost`, `higherCostMinMonths`, ...): the
 * `rules` object is the settings row itself, read and written whole.
 */
export const AdminUpdateCreditRulesSchema = z
  .object({
    rules: CreditRulesInputSchema,
    expected_revision: z.number().int().min(0),
    reason_text: AdminPayerReasonTextSchema,
  })
  .strict();
export type AdminUpdateCreditRulesDto = z.infer<typeof AdminUpdateCreditRulesSchema>;

/** `GET /admin/credit-rules`, and the body of a successful `PUT`. */
export interface AdminCreditRulesResponse {
  readonly rules: CreditRules;
  /** The brief's values, so the console can show what each setting started at. */
  readonly defaults: CreditRules;
  /** 0 before the first edit. Send it back as `expected_revision`. */
  readonly revision: number;
  /** `default` = no stored revision, or the stored one failed validation (the defaults are served). */
  readonly source: "db" | "default";
  /** ISO time the active revision was written, or null with none. */
  readonly updated_at: string | null;
}

/** `PUT /admin/credit-rules`. */
export interface AdminUpdateCreditRulesResponse extends AdminCreditRulesResponse {
  /** False when the body changed no value: nothing was written. */
  readonly changed: boolean;
  readonly changed_keys: readonly CreditRuleKey[];
}
