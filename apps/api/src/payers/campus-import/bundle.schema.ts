/**
 * #2754 — the Campus company export bundle, format version 1, as BadaBhai reads it.
 *
 * The bundle is written by RVMBeyond_jobportal#156 (`scripts/export-companies-for-badabhai.ts`,
 * spec `docs/api/company-export-bundle.md`). These schemas are BadaBhai's side of that contract:
 * every field the importer uses is required here with its type, so a bundle that drifted from the
 * spec fails at read time, before anything is written. Fields the importer does not use are
 * accepted and dropped (zod strips unknown keys), so a Campus-side addition does not break us.
 *
 * Nothing in this file logs or prints a value. The bundle holds names, phones and emails.
 */
import { z } from "zod";

export const CAMPUS_BUNDLE_FORMAT = "badabhai-campus-company-export";
export const CAMPUS_BUNDLE_VERSION = 1;

/** The bundle's files, in the order the importer reads them. */
export const CAMPUS_BUNDLE_FILES = [
  "companies.jsonl",
  "logins.jsonl",
  "jobs.jsonl",
  "applications.jsonl",
  "unused_plans.jsonl",
  "problems.jsonl",
] as const;
export type CampusBundleFile = (typeof CAMPUS_BUNDLE_FILES)[number];

const sourceId = z.string().min(1).max(200);
const isoTime = z.string().min(1);
const nullableText = z.string().nullable();

export const manifestSchema = z.object({
  format: z.literal(CAMPUS_BUNDLE_FORMAT),
  version: z.literal(CAMPUS_BUNDLE_VERSION),
  generated_at: isoTime,
  read_only: z.literal(true),
  scope: z.object({ companies: z.enum(["all", "list"]) }).passthrough(),
  counts: z.record(z.string(), z.unknown()),
  files: z.record(
    z.string(),
    z.object({ records: z.number().int().nonnegative(), sha256: z.string().regex(/^[0-9a-f]{64}$/) }),
  ),
});
export type CampusManifest = z.infer<typeof manifestSchema>;

export const SIGN_IN_PHONE_CLASSES = [
  "good",
  "shared",
  "candidate_number",
  "not_mobile",
  "missing",
] as const;
export type SignInPhoneClass = (typeof SIGN_IN_PHONE_CLASSES)[number];

export const companySchema = z.object({
  source_id: sourceId,
  name: z.string().min(1),
  approval_status: z.enum(["approved", "pending"]),
  approved_at: nullableText.optional(),
  created_at: isoTime,
  sign_in_phone: z.object({
    value: nullableText,
    class: z.enum(SIGN_IN_PHONE_CLASSES),
    source: nullableText.optional(),
  }),
  // Always an object; `value` is null when the owner login has no phone (an email-first sign-up).
  proven_phone: z.object({ value: nullableText, verified_at: nullableText }),
  contact: z.object({
    name: nullableText,
    email: nullableText,
    phone: nullableText,
  }),
  profile: z
    .object({
      industry: nullableText.optional(),
      size: nullableText.optional(),
      city: nullableText.optional(),
      state: nullableText.optional(),
      website: nullableText.optional(),
    })
    .passthrough(),
  gst: z
    .object({
      gstin: nullableText,
      gst_state_code: nullableText.optional(),
    })
    .passthrough()
    .nullable(),
  counts: z.object({
    jobs: z.number().int().nonnegative(),
    applications_moving: z.number().int().nonnegative(),
    applications_held: z.number().int().nonnegative(),
  }),
});
export type CampusCompany = z.infer<typeof companySchema>;

export const loginSchema = z.object({
  source_id: sourceId,
  company_source_id: sourceId,
  kind: z.enum(["owner", "team"]),
  type: z.enum(["email", "phone"]),
  value: nullableText,
  verified_at: nullableText,
});
export type CampusLogin = z.infer<typeof loginSchema>;

export const CAMPUS_JOB_STATUSES = ["active", "paused", "pending_approval"] as const;

export const jobSchema = z.object({
  source_id: sourceId,
  company_source_id: sourceId,
  title: z.string().min(1),
  description: nullableText,
  status: z.enum(CAMPUS_JOB_STATUSES),
  past_expiry: z.boolean(),
  created_at: isoTime,
  updated_at: nullableText,
  expires_at: nullableText,
  location: nullableText,
  job_type: nullableText,
  openings: z.number().int().nullable(),
  experience_min_months: z.number().int().nullable(),
  experience_max_months: z.number().int().nullable(),
  salary_min_lpa: z.number().nullable(),
  salary_max_lpa: z.number().nullable(),
  required_skills: z.array(z.string()).nullable(),
  preferred_skills: z.array(z.string()).nullable(),
  cad_software_required: z.array(z.string()).nullable(),
  interview: z.object({ type: nullableText }).passthrough(),
  audience: z.object({ visibility_type: z.string() }).passthrough(),
  applications: z.object({
    open: z.number().int().nonnegative(),
    moving: z.number().int().nonnegative(),
    held: z.number().int().nonnegative(),
  }),
});
export type CampusJob = z.infer<typeof jobSchema>;

/** Campus's open application statuses (finished ones — rejected, withdrawn, hired — are not exported). */
export const CAMPUS_APPLICATION_STATUSES = [
  "applied",
  "pending",
  "under_review",
  "shortlisted",
  "interview_scheduled",
  "offered",
  "selected",
  "on_hold",
] as const;

const rvmStudentCandidate = z.object({
  source_id: sourceId,
  kind: z.literal("rvm_student"),
  student_ref: z.string().min(1),
});
const externalCandidate = z.object({
  source_id: sourceId,
  kind: z.literal("external"),
  name: nullableText,
  phone: nullableText,
  email: nullableText,
  city: nullableText.optional(),
  state: nullableText.optional(),
});

export const applicationSchema = z.object({
  source_id: sourceId,
  job_source_id: sourceId,
  company_source_id: sourceId,
  // Kept as a string: an unknown value is the importer's exception list, not a read failure.
  status: z.string().min(1),
  applied_at: isoTime,
  updated_at: nullableText,
  company_unlocked_at: nullableText,
  candidate: z.discriminatedUnion("kind", [rvmStudentCandidate, externalCandidate]),
});
export type CampusApplication = z.infer<typeof applicationSchema>;

export const UNUSED_PLAN_LINES = [
  "cv_views_left_on_plan_jobs",
  "cv_views_in_wallet",
  "paid_plan_never_posted",
  "payment_never_registered",
] as const;
export type UnusedPlanLine = (typeof UNUSED_PLAN_LINES)[number];

export const unusedPlanSchema = z
  .object({
    key: z.string().min(1).max(200),
    line: z.enum(UNUSED_PLAN_LINES),
    company_source_id: sourceId.optional(),
    plan_code: nullableText.optional(),
    cv_views_left: z.number().int().nonnegative().nullable().optional(),
    cv_views_left_live: z.number().int().nonnegative().nullable().optional(),
    job_posts_left: z.number().int().nonnegative().nullable().optional(),
    payment_source_id: sourceId.optional(),
    paise: z.number().int().nonnegative().nullable().optional(),
  })
  .passthrough();
export type CampusUnusedPlan = z.infer<typeof unusedPlanSchema>;

export const problemSchema = z
  .object({
    kind: z.string().min(1),
    company_source_id: sourceId.optional(),
    job_source_id: sourceId.optional(),
    detail: z.unknown().optional(),
  })
  .passthrough();
export type CampusProblem = z.infer<typeof problemSchema>;

export const RECORD_SCHEMAS = {
  "companies.jsonl": companySchema,
  "logins.jsonl": loginSchema,
  "jobs.jsonl": jobSchema,
  "applications.jsonl": applicationSchema,
  "unused_plans.jsonl": unusedPlanSchema,
  "problems.jsonl": problemSchema,
} as const;

/** A whole bundle, read and checked. */
export interface CampusBundle {
  manifest: CampusManifest;
  /** sha256 of `manifest.json`'s bytes: the batch's identity in `company_import_batches`. */
  manifestSha256: string;
  companies: CampusCompany[];
  logins: CampusLogin[];
  jobs: CampusJob[];
  applications: CampusApplication[];
  unusedPlans: CampusUnusedPlan[];
  problems: CampusProblem[];
}
