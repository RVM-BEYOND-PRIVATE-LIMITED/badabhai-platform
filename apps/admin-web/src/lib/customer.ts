/**
 * The customer vocabulary (owner ruling 2026-10-01): a payer is a Customer on screen, and its two
 * personas are Company (`role = employer`) and Agency (`role = agent`). "Account" is the payer's
 * own settings page in payer-web, so this console never calls a customer one in a label. Labels
 * only — routes (`/companies`, `/agencies`), API paths and the stored roles keep their words.
 */

/** The stored payer role, as the admin API serves it. */
export type PayerRole = "employer" | "agent";

/** What the console calls each payer role. */
export const CUSTOMER_KIND_LABELS = {
  employer: "Company",
  agent: "Agency",
} as const satisfies Readonly<Record<PayerRole, string>>;
