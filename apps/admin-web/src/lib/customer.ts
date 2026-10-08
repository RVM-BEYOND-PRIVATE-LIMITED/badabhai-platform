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

/** A customer persona as a page names it. */
export type CustomerKind = "Company" | "Agency";

/**
 * Each persona's section — its list, and the parent every one of its detail pages links back to.
 * The one place the mapping lives, so the detail route's back link and the fence that checks it
 * (`page-header.render.test.tsx`) cannot disagree.
 */
export const CUSTOMER_SECTION_HREF = {
  Company: "/companies",
  Agency: "/agencies",
} as const satisfies Readonly<Record<CustomerKind, string>>;

/** The section a customer of unknown role is sent to — its detail route redirects an agency on. */
const ROLE_UNKNOWN_KIND: CustomerKind = "Company";

/**
 * Where a customer cell links — the ONE place a customer's address is built (a fence in
 * `customer.test.ts` keeps every other file from spelling `/companies/${…}` by hand).
 *
 * With the role known (`payer_role`, #2032) it is the customer's own section: a Company opens
 * `/companies/:id`, an Agency `/agencies/:id` — no redirect hop (sweep AW-28). Without it — an
 * older API that predates the field (the top balances gained it last, #2106), or a `payer_id`
 * the server could not resolve (`null`) — it is `/companies/:id`, the address that still
 * redirects an agency to its own section.
 */
export function customerHref(payerId: string, payerRole?: PayerRole | null): string {
  const kind = payerRole ? CUSTOMER_KIND_LABELS[payerRole] : ROLE_UNKNOWN_KIND;
  return `${CUSTOMER_SECTION_HREF[kind]}/${encodeURIComponent(payerId)}`;
}
