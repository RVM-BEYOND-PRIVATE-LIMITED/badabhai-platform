/**
 * Client-safe COMPANY vocabulary (A9, #2579).
 *
 * This module is imported by both Server and Client Components, so it must stay free of
 * `server-only`, zod and any fetch. It mirrors the closed sets in
 * `apps/api/src/admin/companies/admin-companies.dto.ts`; the API's Zod enums remain the sole
 * authority on what a write accepts.
 */

export const COMPANY_KINDS = ["employer", "agent"] as const;
export type CompanyKind = (typeof COMPANY_KINDS)[number];

/** `PAYER_PROFILE_VERIFICATION_STATUSES` in @badabhai/db — the profile review state. */
export const COMPANY_VERIFICATION_STATUSES = [
  "pending",
  "verified",
  "rejected",
  "suspended",
] as const;
export type CompanyVerificationStatus = (typeof COMPANY_VERIFICATION_STATUSES)[number];

/** `ADMIN_COMPANY_SIZE_BANDS` — the banded employer head-count field. */
export const COMPANY_SIZE_BANDS = [
  "1-10",
  "11-50",
  "51-200",
  "201-500",
  "501-1000",
  "1000+",
] as const;
export type CompanySizeBand = (typeof COMPANY_SIZE_BANDS)[number];

/** `ADMIN_AGENCY_TYPES` — mirrors the `agency_profiles_agency_type_check` values. */
export const COMPANY_AGENCY_TYPES = [
  "placement_agency",
  "contractor",
  "training_partner",
  "consultant",
] as const;
export type CompanyAgencyType = (typeof COMPANY_AGENCY_TYPES)[number];

export const COMPANY_AGENCY_TYPE_LABELS: Readonly<Record<CompanyAgencyType, string>> = {
  placement_agency: "Placement agency",
  contractor: "Contractor",
  training_partner: "Training partner",
  consultant: "Consultant",
};

/** `ADMIN_COMPANY_REASON_CODES` — the closed reason vocabulary every company write carries. */
export const COMPANY_REASON_CODES = [
  "client_request",
  "details_corrected",
  "verification_review",
  "duplicate",
  "inactive",
  "policy_violation",
  "archived_in_error",
  "other",
] as const;
export type CompanyReasonCode = (typeof COMPANY_REASON_CODES)[number];

export const COMPANY_REASON_LABELS: Readonly<Record<CompanyReasonCode, string>> = {
  client_request: "Requested by the client",
  details_corrected: "Correcting company details",
  verification_review: "Verification review",
  duplicate: "Duplicate organisation",
  inactive: "No longer trading",
  policy_violation: "Policy or terms breach",
  archived_in_error: "Archived in error",
  other: "Other",
};

/** The reason categories a company confirmation offers, in the API's own codes. */
export const COMPANY_REASON_CATEGORIES = COMPANY_REASON_CODES.map((value) => ({
  value,
  label: COMPANY_REASON_LABELS[value],
}));

/**
 * The #2574 page sizes. 25 and 50 are one API page; 100 is two (the API caps a named response at
 * 50 — `ADMIN_COMPANIES_PAGE_SIZE_MAX`). The transport merge lives in `lib/companies.ts`.
 */
export const COMPANY_PAGE_SIZES = [25, 50, 100] as const;
export type CompanyPageSize = (typeof COMPANY_PAGE_SIZES)[number];
export const COMPANY_PAGE_SIZE_DEFAULT: CompanyPageSize = 25;
export const COMPANY_PAGE_SIZE_MAX_API = 50;

/** The page size an address asks for, or the default. Unknown values fall back, never 400. */
export function companyPageSize(value: string | undefined): CompanyPageSize {
  const n = Number(value);
  return (COMPANY_PAGE_SIZES as readonly number[]).includes(n)
    ? (n as CompanyPageSize)
    : COMPANY_PAGE_SIZE_DEFAULT;
}

/** The 1-based page an address asks for, or page 1 for anything malformed. */
export function companyPage(value: string | undefined): number {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 10_000 ? n : 1;
}

/** The console's name for each stored role. */
export const COMPANY_KIND_LABELS: Readonly<Record<CompanyKind, string>> = {
  employer: "Company",
  agent: "Agency",
};

/**
 * The Kind filter in the ADDRESS (`?kind=company|agency`) and the stored role it asks the API
 * for. The address says what an operator reads; the API keeps `employer`/`agent`. The old
 * `/agencies` redirects already use the address words, so they keep working.
 */
export const COMPANY_KIND_FILTER_ROLES = {
  company: "employer",
  agency: "agent",
} as const satisfies Readonly<Record<string, CompanyKind>>;
export type CompanyKindFilter = keyof typeof COMPANY_KIND_FILTER_ROLES;
export const COMPANY_KIND_FILTERS = Object.keys(
  COMPANY_KIND_FILTER_ROLES,
) as readonly CompanyKindFilter[];

/** The Kind filter an address asks for, or undefined for every customer. */
export function companyKindFilter(value: string | undefined): CompanyKindFilter | undefined {
  return value !== undefined && Object.hasOwn(COMPANY_KIND_FILTER_ROLES, value)
    ? (value as CompanyKindFilter)
    : undefined;
}

/** The values a company-list filter can take, for the API's closed query schema. */
export const COMPANY_STATUSES = ["pending", "active", "suspended", "archived"] as const;
export type CompanyStatus = (typeof COMPANY_STATUSES)[number];

/**
 * The editable company record, as a form and a Server Action exchange it. Every field is
 * OPTIONAL: an admin edit sends only what changed, and the API's PATCH schema accepts exactly
 * these keys (a missing key means "leave it alone"; `null` clears a nullable field).
 */
export interface CompanyProfilePayload {
  gst_number?: string | null;
  address?: string | null;
  website?: string | null;
  phone?: string | null;
  email?: string | null;
  contact_person?: string | null;
  verification_status?: CompanyVerificationStatus;
  industry?: string | null;
  company_size?: CompanySizeBand | null;
  hiring_locations?: string[];
  agency_type?: CompanyAgencyType | null;
  operating_cities?: string[];
  recruiter_count?: number | null;
}

export interface CompanyChangesPayload extends CompanyProfilePayload {
  org_name?: string;
}

/** The fields a company write's reason may name — the API's closed company reason codes. */
export interface CompanyReasonPayload {
  reasonCode: CompanyReasonCode;
  reasonText: string;
}

/** `ADMIN_POSTING_REASON_CODES` — the closed reasons a posting write accepts. */
export const POSTING_REASON_CODES = [
  "policy_violation",
  "misleading",
  "spam",
  "incorrect_details",
  "low_quality",
  "duplicate",
  "other",
] as const;
export type PostingReasonCode = (typeof POSTING_REASON_CODES)[number];

export const POSTING_REASON_LABELS: Readonly<Record<PostingReasonCode, string>> = {
  policy_violation: "Policy or terms breach",
  misleading: "Misleading content",
  spam: "Spam",
  incorrect_details: "Incorrect details",
  low_quality: "Low quality",
  duplicate: "Duplicate posting",
  other: "Other",
};

export const POSTING_REASON_CATEGORIES = POSTING_REASON_CODES.map((value) => ({
  value,
  label: POSTING_REASON_LABELS[value],
}));

/** `ADMIN_POSTING_VERIFICATION_REASON_CODES` — the trust-review decision reasons. */
export const POSTING_VERIFICATION_REASON_CODES = [
  "meets_standards",
  "does_not_meet_standards",
  "policy_violation",
  "incorrect_details",
  "other",
] as const;
export type PostingVerificationReasonCode =
  (typeof POSTING_VERIFICATION_REASON_CODES)[number];

export const POSTING_VERIFICATION_REASON_LABELS: Readonly<
  Record<PostingVerificationReasonCode, string>
> = {
  meets_standards: "Meets standards",
  does_not_meet_standards: "Does not meet standards",
  policy_violation: "Policy or terms breach",
  incorrect_details: "Incorrect details",
  other: "Other",
};

export const POSTING_VERIFICATION_REASON_CATEGORIES =
  POSTING_VERIFICATION_REASON_CODES.map((value) => ({
    value,
    label: POSTING_VERIFICATION_REASON_LABELS[value],
  }));

/**
 * The reason a T1 (reversible, no-dialog) posting action sends. The API requires a reason text
 * on EVERY posting write, so a one-click hide/pause still records one; an action with applicant
 * impact asks the operator for their own reason instead.
 */
export const QUICK_POSTING_REASON = {
  reasonCode: "other" as PostingReasonCode,
  reasonText: "Reversible state change from the company record, with no applicant impact.",
} as const;

/** `VACANCY_BANDS` from @badabhai/types, mirrored for the posting edit form. */
export const POSTING_VACANCY_BANDS = ["1", "2-5", "6-10", "11-25", "25+"] as const;
