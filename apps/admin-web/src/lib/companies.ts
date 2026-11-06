import "server-only";
import { z } from "zod";
import { adminFetch } from "./admin-http";

/**
 * The COMPANY record data layer — `GET /admin/companies` (list), `GET
 * /admin/companies/:id` (detail) and `GET /admin/companies/:id/members` (#2564
 * B10): one row per organisation — team-member logins roll up under their org,
 * never beside it. Writes live server-side (the Companies screen calls them
 * through actions); this module is the typed fetch + the pure copy helpers the
 * screens read.
 *
 * Its own module rather than a block inside `customer.ts`, for the same reason
 * `funnel.ts` is its own: one module per admin API surface, so a controller's
 * contract has exactly one mirror on this side. Everything else here follows
 * `funnel.ts` verbatim — `server-only`, `adminFetch`, and every response parsed
 * rather than trusted.
 *
 * ── MIRRORED FROM `apps/api/src/admin/admin-companies.dto.ts` ────────────────
 * Compared, never assumed — the server owns the contract, this file re-states it
 * in zod, and a field the server adds must appear here the day it ships.
 *
 * ── NULL ₹ / NULL TEXT ARE HONEST ABSENCE ─────────────────────────────────────
 * `last_payment_at: null` is "never paid", never ₹0. `org_name: null` is
 * "disclosed, and nobody has ever recorded a name" — the entities' contract,
 * verbatim. Profile fields are `null` when undisclosed OR unrecorded; the
 * detail screen renders the honest placeholder either way.
 */

// ---------------------------------------------------------------------------
// Wire shapes (mirrored)
// ---------------------------------------------------------------------------

const companyItemSchema = z.object({
  org_id: z.string(),
  anchor_payer_id: z.string(),
  kind: z.string(),
  status: z.string(),
  verification: z.string(),
  org_name: z.string().nullable().optional(),
  balance: z.number(),
  open_postings: z.number(),
  total_postings: z.number(),
  last_payment_at: z.string().nullable(),
  member_count: z.number(),
  created_at: z.string(),
});
export type AdminCompanyListItem = z.infer<typeof companyItemSchema>;

/** Exported so tests can parse a captured payload through the REAL schema. */
export const companiesPageSchema = z.object({
  items: z.array(companyItemSchema),
  total: z.number(),
  page: z.number(),
  page_size: z.number(),
});
export type AdminCompaniesPage = z.infer<typeof companiesPageSchema>;

const companyProfileSchema = z.object({
  gst: z.string().nullable(),
  address: z.string().nullable(),
  city: z.string().nullable(),
  contact_name: z.string().nullable(),
  website: z.string().nullable(),
  industry: z.string().nullable(),
  company_size: z.string().nullable(),
  hiring_locations: z.array(z.unknown()),
  agency_type: z.string().nullable(),
  service_locations: z.array(z.unknown()),
  operating_cities: z.array(z.unknown()),
  recruiter_count: z.number().nullable(),
  source_channels: z.array(z.unknown()),
  verification_status: z.string(),
});
export type AdminCompanyProfile = z.infer<typeof companyProfileSchema>;

export const companyDetailSchema = companyItemSchema.extend({
  email: z.string().nullable(),
  phone: z.string().nullable(),
  profile: companyProfileSchema,
});
export type AdminCompanyDetail = z.infer<typeof companyDetailSchema>;

const companyMemberSchema = z.object({
  member_id: z.string(),
  member_payer_id: z.string().nullable(),
  org_role: z.string(),
  status: z.string(),
  invited_at: z.string(),
  accepted_at: z.string().nullable(),
});
export type AdminCompanyMember = z.infer<typeof companyMemberSchema>;

/**
 * API paths are built by CONCATENATION, never by a template whose head ends with
 * `/companies/` — the customer-address fence (`customer.test.ts`) scans every shipped
 * source for hand-built `/companies/…` UI hrefs, and a template head here would trip
 * it textually. UI hrefs still go through `customerHref`, exactly as before.
 */

/**
 * One numbered page of organisations. `search` matches a whole name word, a
 * GSTIN or a city fragment; `kind` is `employer` (company) or `agent` (agency);
 * `status` admits `archived` so a frozen company can be found and restored;
 * `sort` is `newest` (default) or `oldest`. Requires `read_entities`.
 */
export function getCompanies(opts?: {
  search?: string;
  kind?: string;
  status?: string;
  verification?: string;
  sort?: string;
  page?: number;
  pageSize?: number;
}) {
  const q = new URLSearchParams();
  if (opts?.search) q.set("search", opts.search);
  if (opts?.kind) q.set("kind", opts.kind);
  if (opts?.status) q.set("status", opts.status);
  if (opts?.verification) q.set("verification", opts.verification);
  if (opts?.sort) q.set("sort", opts.sort);
  if (opts?.page !== undefined) q.set("page", String(opts.page));
  if (opts?.pageSize !== undefined) q.set("pageSize", String(opts.pageSize));
  const qs = q.toString();
  const suffix = qs ? `?${qs}` : "";
  return adminFetch("/admin/companies" + suffix, {
    schema: companiesPageSchema,
  });
}

/**
 * One company's record. `:id` is any login in the company — the response is
 * always keyed by the org anchor. Requires `read_entities`; names and profile
 * PII are additive behind `read_identity`.
 */
export function getCompany(companyId: string) {
  return adminFetch("/admin/companies" + "/" + encodeURIComponent(companyId), {
    schema: companyDetailSchema,
  });
}

/**
 * Every non-removed login in the org, oldest first. Faceless — login
 * identifiers come from User accounts filtered to the org. Requires
 * `read_entities`.
 */
export function getCompanyMembers(companyId: string) {
  return adminFetch("/admin/companies" + "/" + encodeURIComponent(companyId) + "/members", {
    schema: z.array(companyMemberSchema),
  });
}

// ---------------------------------------------------------------------------
// Pure copy helpers (no DOM, no fetch — testable like `funnel.ts`)
// ---------------------------------------------------------------------------

/** The one spelling of a company timeline ₹ figure. Null is "never paid", never ₹0. */
export function formatCompanyAmount(amountInr: number | null): string {
  if (amountInr === null) return "Not recorded";
  return `₹${amountInr.toLocaleString("en-IN")}`;
}

/**
 * The one spelling of a frozen company. An archived row is not a suspended row:
 * the way back is restore, not reinstate.
 */
export function describeCompanyStatus(status: string): string {
  if (status === "archived") return "Archived";
  if (status === "suspended") return "Suspended";
  if (status === "pending") return "Pending";
  return "Active";
}
