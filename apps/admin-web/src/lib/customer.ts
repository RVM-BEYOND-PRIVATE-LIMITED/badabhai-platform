/**
 * The customer vocabulary (owner ruling 2026-10-01): a payer is a Customer on screen, and its two
 * personas are Company (`role = employer`) and Agency (`role = agent`). "Account" is the payer's
 * own settings page in payer-web, so this console never calls a customer one in a label.
 *
 * ONE SECTION FOR BOTH (A6, #2576). Companies and Agencies were two sidebar sections over one
 * table and one API (`GET /admin/payers?role=`). They are now one list, Directory › Companies
 * (`/companies`), with a Kind filter; `/agencies/*` redirects into it (next.config.mjs). API paths
 * and the stored roles keep their words.
 */

/** The stored payer role, as the admin API serves it. */
export type PayerRole = "employer" | "agent";

/** What the console calls each payer role. */
export const CUSTOMER_KIND_LABELS = {
  employer: "Company",
  agent: "Agency",
} as const satisfies Readonly<Record<PayerRole, string>>;

/** A customer persona as a page names it. */
export type CustomerKind = (typeof CUSTOMER_KIND_LABELS)[PayerRole];

/**
 * The customers' section — the list, and the parent every customer's page links back to, whatever
 * its kind. The one place it lives, so the detail route's back link and the fence that checks it
 * (`page-header.render.test.tsx`) cannot disagree.
 */
export const CUSTOMERS_HREF = "/companies";

/**
 * Where a customer cell links — the ONE place a customer's address is built (a fence in
 * `customer.test.ts` keeps every other file from spelling `/companies/${…}` by hand). Since A6 a
 * Company and an Agency share the section, so the address no longer depends on the role: a cell
 * that knows it still NAMES the persona (`CustomerLink`), and one that does not — an older API, an
 * orphaned id — lands on the same page, which reads the role itself.
 */
export function customerHref(payerId: string): string {
  return `${CUSTOMERS_HREF}/${encodeURIComponent(payerId)}`;
}

/**
 * THE KIND FILTER on Companies (A6): its value in the address (`?kind=`), and the payer role it
 * asks the API for. The address says what an operator reads ("agency"), never the stored role
 * ("agent"); the page translates. No value means every customer.
 */
export const CUSTOMER_KIND_FILTER_ROLES = {
  company: "employer",
  agency: "agent",
} as const satisfies Readonly<Record<string, PayerRole>>;

export type CustomerKindFilter = keyof typeof CUSTOMER_KIND_FILTER_ROLES;

export const CUSTOMER_KIND_FILTERS = Object.keys(
  CUSTOMER_KIND_FILTER_ROLES,
) as readonly CustomerKindFilter[];

/**
 * The Kind filter an address asks for, or undefined for every customer. A value this console
 * does not know is NOT sent to the API (it never reaches it — the role is the page's to
 * translate) and is not an error either: the list shows every customer, and the Kind chips say so.
 */
export function customerKindFilter(value: string | undefined): CustomerKindFilter | undefined {
  return value !== undefined && Object.hasOwn(CUSTOMER_KIND_FILTER_ROLES, value)
    ? (value as CustomerKindFilter)
    : undefined;
}
