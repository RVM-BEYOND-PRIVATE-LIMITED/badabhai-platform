import { z } from "zod";
import { e164PhoneSchema } from "@badabhai/validators";
import {
  PAYER_PROFILE_VERIFICATION_STATUSES,
  PAYER_STATUSES,
  normalizeGstin,
  type OrgRole,
  type PayerMemberStatus,
  type PayerProfileVerificationStatus,
  type PayerRole,
  type PayerStatus,
} from "@badabhai/db";
import type { CompanyChangedField } from "@badabhai/event-schema";
import {
  AdminPayerReasonTextSchema,
  type AdminCreatePayerLoginResponse,
} from "../admin-payer-logins.dto";

/**
 * #2564 (B10) — the admin COMPANY RECORD contract: create, edit, archive/restore, list, detail.
 *
 * A COMPANY is an ORGANISATION, identified by its ROOT payer id (`payer_orgs.root_payer_id` —
 * the same id every existing `/admin/payers/:id` route takes). Team-member logins are listed
 * UNDER their company, never as companies of their own.
 *
 * Every write is `.strict()`, carries a closed `reason_code` and a written `reason_text`
 * (15–500 characters, no hard identifiers — it is stored on `audit_logs`, which payer erasure
 * does not reach), and the actor is always the session admin.
 */

export const ADMIN_COMPANY_KINDS = ["employer", "agent"] as const satisfies readonly PayerRole[];
export const AdminCompanyKindSchema = z.enum(ADMIN_COMPANY_KINDS);

/** Why an admin created, edited, archived or restored a company. Codes only. */
export const ADMIN_COMPANY_REASON_CODES = [
  "client_request",
  "details_corrected",
  "verification_review",
  "duplicate",
  "inactive",
  "policy_violation",
  "archived_in_error",
  "other",
] as const;
export const AdminCompanyReasonCodeSchema = z.enum(ADMIN_COMPANY_REASON_CODES);
export type AdminCompanyReasonCode = z.infer<typeof AdminCompanyReasonCodeSchema>;

const reasonShape = {
  reason_code: AdminCompanyReasonCodeSchema,
  reason_text: AdminPayerReasonTextSchema,
} as const;

/** GSTIN: 2-digit state code, PAN, entity digit, `Z`, check character (normalised first). */
const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
export const GstinSchema = z
  .string()
  .transform(normalizeGstin)
  .pipe(z.string().regex(GSTIN_PATTERN, "Not a valid GSTIN"));

/** Company-size bands for `employer_profiles.company_size` (a text column; banded here). */
export const ADMIN_COMPANY_SIZE_BANDS = [
  "1-10",
  "11-50",
  "51-200",
  "201-500",
  "501-1000",
  "1000+",
] as const;

/** Mirrors `agency_profiles_agency_type_check`. */
export const ADMIN_AGENCY_TYPES = [
  "placement_agency",
  "contractor",
  "training_partner",
  "consultant",
] as const;

const cityList = z.array(z.string().trim().min(1).max(80)).max(50);

/**
 * The editable company fields, keyed EXACTLY as the event's changed-field keys
 * (`COMPANY_CHANGED_FIELDS`), so the key an admin sends is the key the spine records. The
 * `satisfies Record<CompanyChangedField, …>` makes a key missing from either side, or an extra
 * one here, a compile error.
 *
 * `null` CLEARS a nullable field. `org_name` and `verification_status` cannot be cleared (a
 * company always has a name and a review state); the two city lists clear with `[]`.
 *
 * Kind-specific: `industry` / `company_size` / `hiring_locations` belong to an EMPLOYER;
 * `agency_type` / `operating_cities` / `recruiter_count` to an AGENCY. The service rejects the
 * other kind's fields with a 400 — the two profile tables have different columns.
 */
export const companyFieldsShape = {
  org_name: z.string().trim().min(1).max(200),
  gst_number: GstinSchema.nullable(),
  address: z.string().trim().min(1).max(500).nullable(),
  website: z
    .string()
    .trim()
    .url()
    .max(200)
    .regex(/^https?:\/\//, "Website must be http(s)")
    .nullable(),
  phone: e164PhoneSchema.nullable(),
  email: z.string().trim().toLowerCase().email().max(254).nullable(),
  contact_person: z.string().trim().min(1).max(120).nullable(),
  verification_status: z.enum(PAYER_PROFILE_VERIFICATION_STATUSES),
  industry: z.string().trim().min(1).max(80).nullable(),
  company_size: z.enum(ADMIN_COMPANY_SIZE_BANDS).nullable(),
  hiring_locations: cityList,
  agency_type: z.enum(ADMIN_AGENCY_TYPES).nullable(),
  operating_cities: cityList,
  recruiter_count: z.number().int().min(0).max(100_000).nullable(),
} satisfies Record<CompanyChangedField, z.ZodType>;

export const EMPLOYER_ONLY_FIELDS = [
  "industry",
  "company_size",
  "hiring_locations",
] as const satisfies readonly CompanyChangedField[];
export const AGENCY_ONLY_FIELDS = [
  "agency_type",
  "operating_cities",
  "recruiter_count",
] as const satisfies readonly CompanyChangedField[];

const CompanyChangesSchema = z
  .object(companyFieldsShape)
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: "No fields to change" });
export type AdminCompanyChanges = z.infer<typeof CompanyChangesSchema>;

/** PATCH /admin/companies/:id */
export const AdminUpdateCompanySchema = z
  .object({ ...reasonShape, changes: CompanyChangesSchema })
  .strict();
export type AdminUpdateCompanyDto = z.infer<typeof AdminUpdateCompanySchema>;

/** POST /admin/companies/:id/archive and /restore */
export const AdminCompanyReasonSchema = z.object(reasonShape).strict();
export type AdminCompanyReasonDto = z.infer<typeof AdminCompanyReasonSchema>;

/**
 * POST /admin/companies — a company or agency AND its first login. The login half is #2563's
 * create path, reused unchanged: `email` / `phone` are the LOGIN identifiers (at least one), and
 * the response carries the one-time temporary password exactly as `POST /admin/payers` does.
 * `profile` is the optional company record (any field but `org_name`, which is required above).
 */
export const AdminCreateCompanySchema = z
  .object({
    kind: AdminCompanyKindSchema,
    org_name: companyFieldsShape.org_name,
    email: z.string().trim().toLowerCase().email().max(254).optional(),
    phone: e164PhoneSchema.optional(),
    ...reasonShape,
    profile: z.object(companyFieldsShape).omit({ org_name: true }).partial().strict().optional(),
  })
  .strict()
  .refine((v) => v.email !== undefined || v.phone !== undefined, {
    message: "At least one of email/phone is required for the first login",
  });
export type AdminCreateCompanyDto = z.infer<typeof AdminCreateCompanySchema>;

/** `:id` — the company's ROOT payer id. */
export const AdminCompanyParamsSchema = z.object({ id: z.string().uuid() }).strict();
export type AdminCompanyParamsDto = z.infer<typeof AdminCompanyParamsSchema>;

/**
 * Numbered pages. `page_size` is capped at 50 — the identity layer's per-response bound — so a
 * page an admin may see names on is never refused names for being too big.
 */
export const ADMIN_COMPANIES_PAGE_SIZE_MAX = 50;
export const ADMIN_COMPANIES_PAGE_SIZE_DEFAULT = 25;

/**
 * GET /admin/companies. `name` is WHOLE-WORD EXACT (every word must appear in the company name,
 * case/diacritic-insensitive) through keyed tokens — never a substring scan over plaintext.
 * `city` matches one hiring/operating city exactly (case-insensitive). `gst` matches the GSTIN
 * exactly through its keyed hash.
 */
export const AdminCompaniesQuerySchema = z
  .object({
    kind: AdminCompanyKindSchema.optional(),
    status: z.enum(PAYER_STATUSES).optional(),
    verification: z.enum(PAYER_PROFILE_VERIFICATION_STATUSES).optional(),
    name: z.string().trim().min(1).max(100).optional(),
    city: z.string().trim().min(1).max(80).optional(),
    gst: GstinSchema.optional(),
    sort: z.enum(["newest", "oldest"]).default("newest"),
    page: z.coerce.number().int().min(1).max(10_000).default(1),
    page_size: z.coerce
      .number()
      .int()
      .min(1)
      .max(ADMIN_COMPANIES_PAGE_SIZE_MAX)
      .default(ADMIN_COMPANIES_PAGE_SIZE_DEFAULT),
  })
  .strict();
export type AdminCompaniesQueryDto = z.infer<typeof AdminCompaniesQuerySchema>;

// ----- responses (no ciphertext, no login identifiers) --------------------------------------

/** One login on a company's team. Faceless: ids, enums and timestamps only. */
export interface AdminCompanyMember {
  member_id: string;
  /** NULL while an invite is unaccepted. */
  payer_id: string | null;
  org_role: OrgRole;
  member_status: PayerMemberStatus;
  /** The login's own account status; NULL while the invite is unaccepted. */
  payer_status: PayerStatus | null;
  last_login_at: Date | null;
  invited_at: Date;
  accepted_at: Date | null;
}

export interface AdminCompanyListItem {
  /** The ROOT payer id — the company's id on every admin route. */
  id: string;
  /** `payer_orgs.id`, or NULL for an account that has not completed sign-up yet. */
  org_id: string | null;
  /**
   * The company name. ABSENT when no name was disclosed to this admin (no `read_identity`, or
   * over the name budget); NULL when disclosed and none decrypts.
   */
  org_name?: string | null;
  kind: PayerRole;
  status: PayerStatus;
  /** What restore / reinstate would return the company to. */
  previous_status: PayerStatus | null;
  /** The profile's review state; `pending` when no company record has been saved yet. */
  verification_status: PayerProfileVerificationStatus;
  /** Hiring locations (employer) or operating cities (agency). Coarse, non-PII. */
  cities: string[];
  /** Team logins other than the founder (invited + active). */
  member_count: number;
  members: AdminCompanyMember[];
  last_login_at: Date | null;
  created_at: Date;
}

export interface AdminCompaniesPage {
  items: AdminCompanyListItem[];
  page: number;
  page_size: number;
  total: number;
  total_pages: number;
  /** False when the name-token keys are unset: the `name` filter is refused (503). */
  name_search_available: boolean;
}

/** The decrypted company contact fields — present only when disclosed to this admin. */
export interface AdminCompanyContact {
  gst_number: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
  contact_person: string | null;
}

export interface AdminCompanyDetail extends AdminCompanyListItem {
  /** False until a company record has been saved for this company. */
  has_profile: boolean;
  website: string | null;
  industry: string | null;
  company_size: string | null;
  hiring_locations: string[];
  agency_type: string | null;
  operating_cities: string[];
  recruiter_count: number | null;
  profile_updated_at: Date | null;
  /**
   * The company's contact PII (`company_profiles` identity surface). ABSENT when not disclosed
   * (no `read_identity`, or over budget); present with NULL fields when disclosed but unset.
   */
  contact?: AdminCompanyContact;
}

export interface AdminCompanyWriteResult {
  company_id: string;
  /** False on an idempotent no-op (already archived / not archived). */
  changed: boolean;
}

export interface AdminCreateCompanyResponse {
  company_id: string;
  /** The first login, exactly as `POST /admin/payers` returns it (one-time temporary password). */
  login: AdminCreatePayerLoginResponse;
}
