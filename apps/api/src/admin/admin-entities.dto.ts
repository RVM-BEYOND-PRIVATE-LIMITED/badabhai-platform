import { z } from "zod";
import {
  JOB_POSTING_STATUSES,
  JOB_POSTING_VERIFICATION_STATUSES,
  VACANCY_BANDS,
  WORKER_STATUSES,
  type LanguageCode,
} from "@badabhai/types";
import type {
  ApplicationAction,
  CreditReason,
  JobNeededBy,
  JobShift,
  PayerRole,
  PayerStatus,
} from "@badabhai/db";

/**
 * Zod DTOs + response projections for the admin FACELESS entity reads (BP-1, ADR-0025
 * Decision 3.1 row 2 — "Read entities (workers/payers/jobs/postings — faceless, no PII)").
 *
 * ── WHAT "FACELESS" MEANS HERE, FIELD BY FIELD ──────────────────────────────────────────
 * The projections below are the ENTIRE contract: a field absent from an interface is a field
 * the admin surface cannot show, because the repository selects exactly these columns. In
 * particular, and permanently:
 *
 *   workers  — NEVER `phone_e164` (AES ciphertext), `phone_hash` (keyed HMAC).
 *              `photo_storage_key` is reduced to a `has_photo` BOOLEAN: the key is an opaque
 *              pointer, but it addresses a face photo, and handing an object key to the UI
 *              turns "is there a photo" into "here is where the photo lives".
 *   payers   — NEVER `email_enc` / `email_hash` / `phone_enc` / `phone_hash`.
 *              A payer is an opaque id + role + status. The B2B contact PII (TD21) stays put.
 *
 * ── THE ONE EXCEPTION: NAMES (owner ruling 2026-08-18, reversing Decision 4) ─────────────
 * `full_name` on a worker and `org_name` on a payer are now served, on the list AND the detail,
 * because a console in which every row is an opaque uuid cannot be used to operate the product.
 * They are the ONLY identity fields here and they behave unlike every other field on these
 * types: they are OPTIONAL, and their presence is itself the answer.
 *
 *   field ABSENT  — this admin was shown no name (they hold no `read_identity`, or they are
 *                   over their per-admin name budget). The rest of the row is unchanged.
 *   field NULL    — disclosed, and nobody has ever recorded a name for this row.
 *   field STRING  — the stored name, decrypted for this one response.
 *
 * Everything behind that — the capability, the egress cap, the audit-before-decrypt — lives in
 * `AdminIdentityService`, and the name columns are read by `AdminIdentityRepository`, never by
 * the faceless projections in `admin-entities.repository.ts`. That separation is what keeps the
 * faceless contract above provable by a source scan rather than by assertion.
 *
 * Still NEVER here, ruling or not: `phone_e164`, `phone_hash`, `email_enc`, `email_hash`,
 * `phone_enc`. Identity egress for a CONTACT stays `POST /admin/workers/:id/reveal-contact`
 * and only that.
 *
 * Job postings are the deliberate exception, and it is not one: `org_label`, `role_title`,
 * `location_label` and `description` are POSTER-TYPED business fields already served to every
 * worker in the feed. They are not a new egress — they are the reason the ops surface is
 * usable at all, since they are the only human-readable handle an admin has for finding the
 * account behind a spam posting. (Posting → `payer_id` → the faceless payer row → suspend.)
 *
 * ── PAGINATION ──────────────────────────────────────────────────────────────────────────
 * KEYSET on `(created_at, id)` DESC, never OFFSET, hard-capped page size. Every list filter
 * maps onto an index (see migration 0064) so a deep page stays O(page), not O(offset).
 */

/** Hard upper bound on a single FACELESS entity page. */
export const ADMIN_ENTITIES_PAGE_MAX = 100;
export const ADMIN_ENTITIES_PAGE_DEFAULT = 50;

/**
 * Hard upper bound on a NAME-BEARING entity page (owner ruling 2026-08-18) — half the faceless
 * ceiling, because the two pages are not the same act.
 *
 * A faceless page of 100 is 100 opaque uuids; a named page of 100 is 100 people deanonymized in
 * one request. The velocity cap bounds names per HOUR, so it cannot see the shape of a single
 * request — a lower per-response ceiling is what makes "one screen" a smaller unit of egress
 * than "the hourly budget".
 *
 * It CLAMPS rather than rejects: an over-limit request from a permitted admin returns 50 named
 * rows and an honest `nextCursor`, not a 400. A validation error here would be an identity
 * control breaking the `read_entities` floor beside it — the same recoupling the over-cap path
 * refuses — and an analyst asking for `?limit=100` still gets 100 faceless rows, unchanged.
 *
 * It is deliberately EQUAL to `ADMIN_IDENTITY_MAX_SUBJECTS`, the bound the identity service
 * itself enforces; a drift test pins them together, since a clamp above that bound would mean
 * a permitted admin silently gets NO names at all instead of a smaller page of them.
 */
export const ADMIN_IDENTITY_PAGE_MAX = 50;

/** The keyset page controls every list query shares. */
const pageShape = {
  cursor: z.string().min(1).max(256).optional(),
  limit: z.coerce
    .number()
    .int()
    .positive()
    .max(ADMIN_ENTITIES_PAGE_MAX)
    .optional()
    .default(ADMIN_ENTITIES_PAGE_DEFAULT),
};

// ---------------------------------------------------------------------------
// Query DTOs
// ---------------------------------------------------------------------------

/** GET /admin/workers */
export const AdminWorkersQuerySchema = z
  .object({
    ...pageShape,
    status: z.enum(WORKER_STATUSES).optional(),
    /** Only workers with a pending hard-delete (ADR-0031 grace window) — an ops triage view. */
    pendingDeletion: z.coerce.boolean().optional(),
  })
  .strict();
export type AdminWorkersQueryDto = z.infer<typeof AdminWorkersQuerySchema>;

/**
 * GET /admin/payers. `role` is what separates the portal's "Companies" (employer) from
 * "Agencies" (agent) — one table, one route, one projection; the UI does not get a second
 * authorization or filtering model per tab.
 */
export const AdminPayersQuerySchema = z
  .object({
    ...pageShape,
    role: z.enum(["employer", "agent"]).optional(),
    status: z.enum(["pending", "active", "suspended"]).optional(),
  })
  .strict();
export type AdminPayersQueryDto = z.infer<typeof AdminPayersQuerySchema>;

/** GET /admin/job-postings */
export const AdminJobPostingsQuerySchema = z
  .object({
    ...pageShape,
    status: z.enum(JOB_POSTING_STATUSES).optional(),
    verificationStatus: z.enum(JOB_POSTING_VERIFICATION_STATUSES).optional(),
    payerId: z.string().uuid().optional(),
  })
  .strict();
export type AdminJobPostingsQueryDto = z.infer<typeof AdminJobPostingsQuerySchema>;

/** GET /admin/applications */
export const AdminApplicationsQuerySchema = z
  .object({
    ...pageShape,
    workerId: z.string().uuid().optional(),
    jobPostingId: z.string().uuid().optional(),
    action: z.enum(["applied", "skipped"]).optional(),
  })
  .strict();
export type AdminApplicationsQueryDto = z.infer<typeof AdminApplicationsQuerySchema>;

/** GET /admin/payers/:id/credits — the balance plus a keyset page of the append-only ledger. */
export const AdminCreditLedgerQuerySchema = z.object({ ...pageShape }).strict();
export type AdminCreditLedgerQueryDto = z.infer<typeof AdminCreditLedgerQuerySchema>;

/** Every `:id` path param on this surface is a uuid. */
export const AdminEntityParamsSchema = z.object({ id: z.string().uuid() }).strict();
export type AdminEntityParamsDto = z.infer<typeof AdminEntityParamsSchema>;

/**
 * `GET /admin/payers/:id?faceless=1` — the caller declares it does not want the name.
 *
 * WHY A CALLER-SETTABLE PRIVACY SWITCH IS SAFE HERE, which is normally a smell: this one can
 * only ever REDUCE disclosure. There is no value of it that discloses more than the default,
 * so the worst a hostile caller achieves is a response with `org_name: null` — which is the
 * faceless projection every role could already read. Contrast a `?reveal=1`, which would be
 * the same shape pointed the other way and must never exist.
 *
 * WHY IT EXISTS. The Companies/Agencies TIMELINE page fetches this row for exactly two fields
 * — `id` and `role`, to tell a 404 from a wrong-section redirect — and renders NO name (its
 * heading is the literal word "Company"). Resolving one anyway charged the name-egress budget
 * and wrote an `admin.identity_viewed` row on every page-turn, so the trail recorded reading
 * that did not happen and, worse, ~300 page-turns exhausted `ADMIN_IDENTITY_MAX_PER_HOUR` —
 * after which `AdminIdentityService.resolve` returns null for EVERY read that hour and the
 * console's real name features go silently faceless. A budget spent on a page with no names
 * is a budget stolen from the pages that have them.
 *
 * NOT `z.coerce.boolean()`, which is the trap next door in this file: it maps the STRING
 * `"false"` to `true` (every non-empty string is truthy), so `?faceless=false` would opt IN to
 * facelessness. Here that direction happens to fail safe, which is exactly why it would have
 * survived review and gone on to be copied somewhere it does not. One exact literal, no
 * coercion, no surprises.
 */
export const AdminPayerDetailQuerySchema = z
  .object({ faceless: z.literal("1").optional() })
  .strict();
export type AdminPayerDetailQueryDto = z.infer<typeof AdminPayerDetailQuerySchema>;

// ---------------------------------------------------------------------------
// Response projections — FACELESS by construction (ids + enums + timestamps + counts).
// ---------------------------------------------------------------------------

/**
 * A keyset page. `nextCursor` is null when the page is the last one.
 *
 * camelCase deliberately, against the snake_case of every row field below: it matches
 * `GET /admin/events`, which already answers `{ events, nextCursor }`. One paging convention
 * across the whole admin API is worth more to the client than internal tidiness in this file
 * — and renaming the shipped one is a refactor of frozen backend code.
 */
export interface AdminPage<T> {
  items: T[];
  nextCursor: string | null;
}

export interface AdminWorkerListItem {
  id: string;
  /**
   * The worker's own name, decrypted for this response only. ABSENT when no name was disclosed
   * to this admin; `null` when disclosed and none is on record. See the header.
   */
  full_name?: string | null;
  status: string;
  preferred_language: LanguageCode | null;
  /** Derived from `photo_storage_key`. The KEY itself is never projected — see the header. */
  has_photo: boolean;
  resume_show_photo: boolean;
  resume_night_shift_ready: boolean;
  /** Non-null = a hard delete is scheduled (ADR-0031 grace window), cancellable until due. */
  deletion_scheduled_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface AdminWorkerDetail extends AdminWorkerListItem {
  /** Latest profile lifecycle state, or null when the worker never started profiling. */
  profile_status: string | null;
  profile_updated_at: Date | null;
  has_resume: boolean;
  application_count: number;
  unlock_count: number;
}

export interface AdminPayerListItem {
  id: string;
  /**
   * The BUSINESS display name (`payers.org_name_enc`) — the Companies/Agencies tab's handle on
   * the account. ABSENT when no name was disclosed to this admin; `null` when disclosed and
   * none decrypts.
   *
   * NOT a contact person: no contact-person column exists anywhere in the codebase, and neither
   * `payers.email_enc` nor `agency_kyc.account_holder_name_enc` (ADR-0022 money/legal gate) is a
   * substitute for one. Collecting a contact name is separately scoped work.
   */
  org_name?: string | null;
  role: PayerRole;
  status: PayerStatus;
  /** The status a suspend moved them OUT of, so the UI can say what reinstate would restore. */
  previous_status: PayerStatus | null;
  created_at: Date;
  updated_at: Date;
}

export interface AdminPayerDetail extends AdminPayerListItem {
  credit_balance: number;
  posting_count: number;
  open_posting_count: number;
  unlock_count: number;
}

export interface AdminJobPostingListItem {
  id: string;
  payer_id: string | null;
  org_label: string;
  role_title: string;
  location_label: string | null;
  city: string | null;
  status: string;
  verification_status: string;
  vacancy_band: (typeof VACANCY_BANDS)[number];
  pay_min: number | null;
  pay_max: number | null;
  published_at: Date | null;
  closed_at: Date | null;
  created_at: Date;
}

export interface AdminJobPostingDetail extends AdminJobPostingListItem {
  /** Poster-typed free text — already worker-visible in the feed. Detail view only. */
  description: string | null;
  shift: JobShift | null;
  needed_by: JobNeededBy | null;
  boosted_until: Date | null;
  /** Non-null only while the owning payer is suspended (ADR-0037 restore marker). */
  previous_status: string | null;
  applied_count: number;
  skipped_count: number;
  updated_at: Date;
}

export interface AdminApplicationListItem {
  id: string;
  worker_id: string;
  job_id: string | null;
  job_posting_id: string | null;
  action: ApplicationAction;
  reason: string | null;
  source_surface: string;
  match_tier: number | null;
  engine_version: string | null;
  created_at: Date;
}

export interface AdminCreditLedgerItem {
  id: string;
  delta: number;
  reason: CreditReason;
  unlock_id: string | null;
  pack_code: string | null;
  /** Whole ₹, stamped at purchase time. Null on debits/grants and on pre-0043 rows. */
  price_inr: number | null;
  created_at: Date;
}

export interface AdminCreditsView {
  payer_id: string;
  balance: number;
  ledger: AdminPage<AdminCreditLedgerItem>;
}
