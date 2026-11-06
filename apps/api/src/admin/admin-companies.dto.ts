import { z } from "zod";
import { e164PhoneSchema } from "@badabhai/validators";
import type { PayerRole, PayerStatus } from "@badabhai/db";
import { PAYER_PROFILE_VERIFICATION_STATUSES } from "@badabhai/db";
import { AdminPayerReasonTextSchema } from "./admin-payer-logins.dto";
import { ADMIN_IDENTITY_PAGE_MAX } from "./admin-entities.dto";

/**
 * Zod DTOs + response projections for the admin COMPANY reads and writes (#2564 B10).
 *
 * One row per ORGANISATION — the admin Companies tab manages companies, not logins.
 * A team member's login never appears as a row; it appears under its org (the
 * members read) and in the User accounts list (org-filtered). The `:id` on every
 * route below is the org ANCHOR's payer id (the founder login — the same handle
 * the Companies page already links by); a member id passed by mistake resolves to
 * the same org, never to a second row.
 *
 * ── EVERY WRITE CARRIES A REASON ──────────────────────────────────────────────
 * A closed `reason_code` + a written `reason_text` (15–500 chars, no hard
 * identifier — the shared #2563 floor). The reason lives on the `audit_logs` row
 * written in the SAME transaction as the system-of-record write and the events;
 * it NEVER rides an event (every company event is `.strict()` and value-free).
 *
 * ── PII ───────────────────────────────────────────────────────────────────────
 * Opaque ids, enums, counts, integer ₹ and coarse city buckets travel freely.
 * GSTINs, street addresses, contact names and login identifiers are ciphertext
 * at rest and are decrypted ONLY through `AdminIdentityService` (read_identity
 * gate, per-admin budget, audit-before-decrypt) — on the detail read and the
 * members-adjacent login, never on the list, and never into an event, a log or a
 * search predicate. Search runs on keyed HMACs (word hashes, GST hash) and the
 * coarse `city` column, never on plaintext.
 */

/** Hard page cap, mirroring the entity reads (the identity clamp halves it — see below). */
export const ADMIN_COMPANIES_PAGE_MAX = 100;
export const ADMIN_COMPANIES_PAGE_DEFAULT = 50;

/** GET /admin/companies query — one numbered page of organisations. */
export const AdminCompaniesQuerySchema = z
  .object({
    /** Whole-word company/agency name, GSTIN, or city fragment — one box, ORed. */
    search: z.string().trim().min(1).max(200).optional(),
    kind: z.enum(["employer", "agent"]).optional(),
    status: z.enum(["pending", "active", "suspended", "archived"]).optional(),
    verification: z.enum(PAYER_PROFILE_VERIFICATION_STATUSES).optional(),
    sort: z.enum(["newest", "oldest"]).optional().default("newest"),
    page: z.coerce.number().int().min(1).optional().default(1),
    pageSize: z.coerce
      .number()
      .int()
      .positive()
      .max(ADMIN_COMPANIES_PAGE_MAX)
      .optional()
      .default(ADMIN_COMPANIES_PAGE_DEFAULT),
  })
  .strict();
export type AdminCompaniesQueryDto = z.infer<typeof AdminCompaniesQuerySchema>;

/** Every `:id` path param on this surface is the org anchor's payer uuid. */
export const AdminCompanyParamsSchema = z.object({ id: z.string().uuid() }).strict();
export type AdminCompanyParamsDto = z.infer<typeof AdminCompanyParamsSchema>;

/**
 * A GSTIN, normalized (trimmed, uppercased, no inner whitespace) BEFORE validation,
 * so "27aab s1234f1z5" and "27AABS1234F1Z5" are the same identifier.
 * 15 chars: 2-digit state + 10-char PAN + entity + "Z" + checksum.
 */
export const GstinSchema = z
  .string()
  .trim()
  .transform((v) => v.toUpperCase().replace(/\s+/g, ""))
  .pipe(z.string().regex(/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, "Invalid GSTIN"));
export type Gstin = z.infer<typeof GstinSchema>;

const profileBaseShape = {
  gst: GstinSchema.optional(),
  address: z.string().trim().min(1).max(500).optional(),
  city: z.string().trim().min(1).max(100).optional(),
  contact_name: z.string().trim().min(1).max(100).optional(),
  website: z.string().trim().min(1).max(254).optional(),
  verification: z.enum(PAYER_PROFILE_VERIFICATION_STATUSES).optional(),
};

/**
 * POST /admin/companies — create a company or agency with its first (owner) login.
 *
 * Discriminated by `kind` so an employer-only field on an agency (or vice versa)
 * is a 400, never a silent drop. At least one of email/phone is required (the
 * login needs a contact); every write carries the create reason.
 */
export const AdminCreateCompanySchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("employer"),
      org_name: z.string().trim().min(1).max(200),
      email: z.string().trim().toLowerCase().email().max(254).optional(),
      phone: e164PhoneSchema.optional(),
      industry: z.string().trim().min(1).max(100).optional(),
      company_size: z.string().trim().min(1).max(100).optional(),
      hiring_locations: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
      ...profileBaseShape,
      reason_code: z.literal("company_created"),
      reason_text: AdminPayerReasonTextSchema,
    })
    .strict()
    .refine((v) => v.email !== undefined || v.phone !== undefined, {
      message: "At least one of email/phone is required",
    }),
  z
    .object({
      kind: z.literal("agent"),
      org_name: z.string().trim().min(1).max(200),
      email: z.string().trim().toLowerCase().email().max(254).optional(),
      phone: e164PhoneSchema.optional(),
      agency_type: z
        .enum(["placement_agency", "contractor", "training_partner", "consultant"])
        .optional(),
      service_locations: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
      operating_cities: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
      recruiter_count: z.number().int().min(0).optional(),
      source_channels: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
      ...profileBaseShape,
      reason_code: z.literal("company_created"),
      reason_text: AdminPayerReasonTextSchema,
    })
    .strict()
    .refine((v) => v.email !== undefined || v.phone !== undefined, {
      message: "At least one of email/phone is required",
    }),
]);
export type AdminCreateCompanyDto = z.infer<typeof AdminCreateCompanySchema>;

export interface AdminCreateCompanyResponse {
  org_id: string;
  /** The founder login — the company's public handle everywhere else. */
  anchor_payer_id: string;
  login_id: string;
  temporary_password: string;
  must_change_password: true;
}

/**
 * PATCH /admin/companies/:id — edit the company record. Every field optional; the
 * server diffs against the stored row and emits the CHANGED KEYS only. An empty
 * diff is a 400 (no effective changes), never a no-op write with an audit row.
 */
export const AdminUpdateCompanySchema = z
  .object({
    org_name: z.string().trim().min(1).max(200).optional(),
    email: z.string().trim().toLowerCase().email().max(254).optional(),
    phone: e164PhoneSchema.optional(),
    gst: GstinSchema.optional(),
    address: z.string().trim().min(1).max(500).optional(),
    city: z.string().trim().min(1).max(100).optional(),
    website: z.string().trim().min(1).max(254).optional(),
    contact_name: z.string().trim().min(1).max(100).optional(),
    industry: z.string().trim().min(1).max(100).optional(),
    company_size: z.string().trim().min(1).max(100).optional(),
    hiring_locations: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
    agency_type: z
      .enum(["placement_agency", "contractor", "training_partner", "consultant"])
      .optional(),
    service_locations: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
    operating_cities: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
    recruiter_count: z.number().int().min(0).nullable().optional(),
    source_channels: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
    verification: z.enum(PAYER_PROFILE_VERIFICATION_STATUSES).optional(),
    reason_code: z.literal("company_profile_updated"),
    reason_text: AdminPayerReasonTextSchema,
  })
  .strict();
export type AdminUpdateCompanyDto = z.infer<typeof AdminUpdateCompanySchema>;

/** POST /admin/companies/:id/archive — freeze the whole company (reasoned, reversible). */
export const AdminArchiveCompanySchema = z
  .object({
    reason_code: z.literal("company_archived"),
    reason_text: AdminPayerReasonTextSchema,
  })
  .strict();
export type AdminArchiveCompanyDto = z.infer<typeof AdminArchiveCompanySchema>;

/** POST /admin/companies/:id/restore — hand every archived login back to its previous status. */
export const AdminRestoreCompanySchema = z
  .object({
    reason_code: z.literal("company_restored"),
    reason_text: AdminPayerReasonTextSchema,
  })
  .strict();
export type AdminRestoreCompanyDto = z.infer<typeof AdminRestoreCompanySchema>;

export interface AdminUpdateCompanyResponse {
  target_id: string;
  changed: boolean;
  changed_fields: string[];
}

export interface AdminArchiveCompanyResponse {
  target_id: string;
  changed: boolean;
  /** Anchor + member logins actually frozen by this call. */
  archived_logins: string[];
  postings_frozen: number;
  jobs_frozen: number;
}

export interface AdminRestoreCompanyResponse {
  target_id: string;
  changed: boolean;
  /** Logins handed back to their previous status by this call. */
  restored_logins: string[];
  postings_restored: number;
  jobs_restored: number;
}

// ---------------------------------------------------------------------------
// Response projections — faceless by construction (ids + enums + counts + dates).
// Names and profile PII are ADDITIVE, gated by `read_identity` like the entities.
// ---------------------------------------------------------------------------

export interface AdminCompanyListItem {
  org_id: string;
  anchor_payer_id: string;
  kind: PayerRole;
  /** The org's status = the anchor login's status (archive archives every member). */
  status: PayerStatus;
  verification: (typeof PAYER_PROFILE_VERIFICATION_STATUSES)[number];
  /**
   * The BUSINESS display name. ABSENT when no name was disclosed to this admin;
   * `null` when disclosed and none decrypts — the entities' contract, verbatim.
   */
  org_name?: string | null;
  /** Live credit balance summed across the org's wallets. */
  balance: number;
  open_postings: number;
  total_postings: number;
  /** Latest money movement across orders, ledger purchases, plans, boosts and top-ups. */
  last_payment_at: Date | null;
  /** Active + invited member logins (removed excluded). */
  member_count: number;
  created_at: Date;
}

export interface AdminCompaniesPage {
  items: AdminCompanyListItem[];
  /** Exact total across the filters — numbered pages, never a cursor. */
  total: number;
  page: number;
  page_size: number;
}

export interface AdminCompanyProfile {
  gst: string | null;
  address: string | null;
  city: string | null;
  contact_name: string | null;
  website: string | null;
  industry: string | null;
  company_size: string | null;
  hiring_locations: unknown[];
  agency_type:
    | "placement_agency"
    | "contractor"
    | "training_partner"
    | "consultant"
    | null;
  service_locations: unknown[];
  operating_cities: unknown[];
  recruiter_count: number | null;
  source_channels: unknown[];
  verification_status: (typeof PAYER_PROFILE_VERIFICATION_STATUSES)[number];
}

/**
 * GET /admin/companies/:id — the company record. Contact email/phone ride the
 * identity boundary too (same gate, same budget, same audit as the profile PII).
 */
export interface AdminCompanyDetail extends AdminCompanyListItem {
  email: string | null;
  phone: string | null;
  profile: AdminCompanyProfile;
}

/**
 * GET /admin/companies/:id/members — every non-removed login in the org. Faceless:
 * opaque ids + roles + statuses + timestamps. Login identifiers come from the User
 * accounts list (`GET /admin/accounts?org_id=`, same `read_identity` contract) —
 * this endpoint deliberately does NOT re-disclose them.
 */
export interface AdminCompanyMember {
  member_id: string;
  member_payer_id: string | null;
  org_role: "owner" | "recruiter";
  status: "invited" | "active" | "removed";
  invited_at: Date;
  accepted_at: Date | null;
}

/** Name-bearing pages are clamped to the identity bound (the entities' rule, verbatim). */
export const ADMIN_COMPANIES_IDENTITY_PAGE_MAX = ADMIN_IDENTITY_PAGE_MAX;
