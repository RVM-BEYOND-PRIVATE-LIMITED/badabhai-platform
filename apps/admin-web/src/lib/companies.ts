import "server-only";
import { z } from "zod";
import { adminFetch } from "./admin-http";
import { getPayer } from "./entities";
import { getPaymentHistory, type AdminPaymentHistoryItem } from "./payment-history";
import { PAYER_STATUSES } from "./list-filter-values";
import {
  COMPANY_KINDS,
  COMPANY_PAGE_SIZE_DEFAULT,
  COMPANY_PAGE_SIZE_MAX_API,
  COMPANY_VERIFICATION_STATUSES,
  type CompanyKind,
  type CompanyPageSize,
  type CompanyVerificationStatus,
} from "./company-vocabulary";

export type {
  CompanyAgencyType,
  CompanyKind,
  CompanyPageSize,
  CompanyReasonCode,
  CompanySizeBand,
  CompanyStatus,
  CompanyVerificationStatus,
} from "./company-vocabulary";

/**
 * The COMPANY RECORD data layer — the admin-api mirror of
 * `apps/api/src/admin/companies/admin-companies.dto.ts` (#2564).
 *
 * A company is an ORGANISATION, addressed by its ROOT payer id. The list is one row per
 * organisation (team-member logins are nested under it), numbered (`page` / `page_size`) and
 * filtered by closed enums plus a whole-word name search.
 *
 * ── THE PAGE-SIZE CAP IS THE SERVER'S, NOT A UI PREFERENCE ─────────────────────────────
 * `GET /admin/companies` caps `page_size` at 50 (`ADMIN_COMPANIES_PAGE_SIZE_MAX`), because a
 * named response is half the identity layer's per-page ceiling. The console still offers the
 * #2574 pages of 25 / 50 / 100: a 100-row page is fetched as two 50-row API pages, in order, and
 * merged here. That is a transport detail of this module, never a second API.
 *
 * ── NULL AND ABSENT NAMES ──────────────────────────────────────────────────────────────
 * `org_name` is `undefined` when no name was disclosed to this admin (no `read_identity`, or
 * over the hourly budget), `null` when disclosed and none is recorded, and a string otherwise —
 * exactly the three states `lib/identity.ts` interprets. Everything else is faceless.
 *
 * ── METRICS ARE COMPOSED FROM THE REAL ENDPOINTS ───────────────────────────────────────
 * The company record does not carry posting counts, a balance or a last payment. Those three
 * columns are hydrated per row from `GET /admin/payers/:id?faceless=1` (counts + balance) and
 * `GET /admin/payers/:id/payment-history` (the latest stamped money movement), which are the
 * endpoints that own those numbers. A metrics read that fails renders as an honest dash, never
 * as zero.
 */

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

const companyMemberSchema = z.object({
  member_id: z.string(),
  payer_id: z.string().nullable(),
  org_role: z.string(),
  member_status: z.string(),
  payer_status: z.enum(PAYER_STATUSES).nullable(),
  last_login_at: z.string().nullable(),
  invited_at: z.string(),
  accepted_at: z.string().nullable(),
});
export type CompanyMember = z.infer<typeof companyMemberSchema>;

export const companyListItemSchema = z.object({
  id: z.string(),
  org_id: z.string().nullable(),
  /** See the header: absent ⇒ not disclosed, null ⇒ none recorded, string ⇒ the name. */
  org_name: z.string().nullable().optional(),
  kind: z.enum(COMPANY_KINDS),
  status: z.enum(PAYER_STATUSES),
  previous_status: z.enum(PAYER_STATUSES).nullable(),
  verification_status: z.enum(COMPANY_VERIFICATION_STATUSES),
  cities: z.array(z.string()),
  member_count: z.number(),
  members: z.array(companyMemberSchema),
  last_login_at: z.string().nullable(),
  created_at: z.string(),
});
export type CompanyListItem = z.infer<typeof companyListItemSchema>;

export const companyContactSchema = z.object({
  gst_number: z.string().nullable(),
  address: z.string().nullable(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  contact_person: z.string().nullable(),
});
export type CompanyContact = z.infer<typeof companyContactSchema>;

export const companyDetailSchema = companyListItemSchema.extend({
  has_profile: z.boolean(),
  website: z.string().nullable(),
  industry: z.string().nullable(),
  company_size: z.string().nullable(),
  hiring_locations: z.array(z.string()),
  agency_type: z.string().nullable(),
  operating_cities: z.array(z.string()),
  recruiter_count: z.number().nullable(),
  profile_updated_at: z.string().nullable(),
  /** Absent when no contact PII was disclosed to this admin — not an empty object. */
  contact: companyContactSchema.optional(),
});
export type CompanyDetail = z.infer<typeof companyDetailSchema>;

export const companiesPageSchema = z.object({
  items: z.array(companyListItemSchema),
  page: z.number(),
  page_size: z.number(),
  total: z.number(),
  total_pages: z.number(),
  name_search_available: z.boolean(),
});
export type CompaniesApiPage = z.infer<typeof companiesPageSchema>;

/** What the page renders: a numbered page at the UI's own size (25 / 50 / 100). */
export interface CompaniesPage {
  items: CompanyListItem[];
  page: number;
  page_size: CompanyPageSize;
  total: number;
  total_pages: number;
  name_search_available: boolean;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export interface CompanyFilters {
  kind?: CompanyKind;
  status?: (typeof PAYER_STATUSES)[number];
  verification?: CompanyVerificationStatus;
  /** Whole-word search; the API refuses it with 503 when the token keys are unset. */
  name?: string;
  city?: string;
  gst?: string;
  sort?: "newest" | "oldest";
  page?: number;
  pageSize?: CompanyPageSize;
}

function companyQuery(f: CompanyFilters, apiPage: number, apiSize: number): string {
  const q = new URLSearchParams();
  if (f.kind) q.set("kind", f.kind);
  if (f.status) q.set("status", f.status);
  if (f.verification) q.set("verification", f.verification);
  if (f.name) q.set("name", f.name);
  if (f.city) q.set("city", f.city);
  if (f.gst) q.set("gst", f.gst);
  if (f.sort) q.set("sort", f.sort);
  q.set("page", String(apiPage));
  q.set("page_size", String(apiSize));
  return `?${q.toString()}`;
}

/**
 * One numbered page of companies. A 100-row UI page is two API pages merged in order; the
 * API's total is the authority for the numbered pager (`ceil(total / 100)`).
 */
export async function listCompanies(f: CompanyFilters = {}): Promise<CompaniesPage> {
  const page = f.page ?? 1;
  const pageSize = f.pageSize ?? COMPANY_PAGE_SIZE_DEFAULT;

  if (pageSize <= COMPANY_PAGE_SIZE_MAX_API) {
    const body = await adminFetch(`/admin/companies${companyQuery(f, page, pageSize)}`, {
      schema: companiesPageSchema,
    });
    return {
      items: body.items,
      page,
      page_size: pageSize,
      total: body.total,
      total_pages: body.total_pages,
      name_search_available: body.name_search_available,
    };
  }

  // 100: two 50-row API pages, fetched in parallel. The first page's total/total_pages are the
  // list's; the second may be past the end (the API then answers an empty page, not a 404).
  const firstApiPage = page * 2 - 1;
  const [first, second] = await Promise.all([
    adminFetch(`/admin/companies${companyQuery(f, firstApiPage, COMPANY_PAGE_SIZE_MAX_API)}`, {
      schema: companiesPageSchema,
    }),
    adminFetch(`/admin/companies${companyQuery(f, firstApiPage + 1, COMPANY_PAGE_SIZE_MAX_API)}`, {
      schema: companiesPageSchema,
    }),
  ]);
  return {
    items: [...first.items, ...second.items].slice(0, pageSize),
    page,
    page_size: pageSize,
    total: first.total,
    total_pages: Math.max(1, Math.ceil(first.total / pageSize)),
    name_search_available: first.name_search_available,
  };
}

/** One company's full record, including the profile and (when permitted) contact PII. */
export async function getCompany(id: string): Promise<CompanyDetail> {
  return adminFetch(`/admin/companies/${encodeURIComponent(id)}`, { schema: companyDetailSchema });
}

// ---------------------------------------------------------------------------
// Per-row metrics — composed from the endpoints that own the numbers
// ---------------------------------------------------------------------------

/** A stamped money movement on the payment timeline (the types that can carry a ₹ price). */
const MONEY_TYPES = new Set([
  "payment_order",
  "credit_purchase",
  "posting_plan",
  "boost",
  "capacity_purchase",
  "quota_topup",
]);

/** The newest timeline row that was an actual payment, for the list's "Last payment" cell. */
export function lastPaymentOf(
  items: readonly AdminPaymentHistoryItem[],
): AdminPaymentHistoryItem | null {
  return (
    items.find(
      (item) =>
        MONEY_TYPES.has(item.type) &&
        item.amount_inr !== null &&
        // A failed gateway order is a record, not a payment.
        item.status !== "failed",
    ) ?? null
  );
}

/** The list columns' per-company aggregates. `null` means the read failed, never zero. */
export interface CompanyMetrics {
  openPostings: number | null;
  totalPostings: number | null;
  balance: number | null;
  lastPaymentAt: string | null;
  lastPaymentInr: number | null;
  /** False when the counts/balance read failed — the cells say so instead of claiming zero. */
  countsLoaded: boolean;
  /** False when the payment timeline read failed — "no payment" and "unknown" are different. */
  paymentsLoaded: boolean;
}

export const EMPTY_COMPANY_METRICS: CompanyMetrics = {
  openPostings: null,
  totalPostings: null,
  balance: null,
  lastPaymentAt: null,
  lastPaymentInr: null,
  countsLoaded: false,
  paymentsLoaded: false,
};

/**
 * The three metric columns for one company row.
 *
 * Counts + balance come from the faceless payer detail (asking for the name again would spend
 * the admin's hourly egress budget for a value this read never renders); the last payment comes
 * from the newest page of the payment timeline. Both reads are independent and either may fail:
 * the failure is a dash in that cell, never a fabricated zero.
 */
export async function getCompanyMetrics(id: string): Promise<CompanyMetrics> {
  const [detail, history] = await Promise.allSettled([
    getPayer(id, { faceless: true }),
    getPaymentHistory(id, { limit: 100 }),
  ]);
  const last = history.status === "fulfilled" ? lastPaymentOf(history.value.items) : null;
  return {
    openPostings: detail.status === "fulfilled" ? detail.value.open_posting_count : null,
    totalPostings: detail.status === "fulfilled" ? detail.value.posting_count : null,
    // The balance is the ORGANISATION rollup the payment-history API serves. The root login's
    // own wallet is a different number when team members hold credits, so a failed history read
    // is a dash — never the founder's balance wearing the company's name.
    balance: history.status === "fulfilled" ? history.value.totals.balance : null,
    lastPaymentAt: last?.date ?? null,
    lastPaymentInr: last?.amount_inr ?? null,
    countsLoaded: detail.status === "fulfilled",
    paymentsLoaded: history.status === "fulfilled",
  };
}

/** Hydrate one page's metric columns, bounded so a 100-row page cannot open 200 sockets at once. */
export async function getCompanyMetricsFor(
  ids: readonly string[],
  concurrency = 8,
): Promise<Map<string, CompanyMetrics>> {
  const out = new Map<string, CompanyMetrics>();
  for (let i = 0; i < ids.length; i += concurrency) {
    const slice = ids.slice(i, i + concurrency);
    const metrics = await Promise.all(slice.map((id) => getCompanyMetrics(id)));
    slice.forEach((id, at) => out.set(id, metrics[at]!));
  }
  return out;
}
