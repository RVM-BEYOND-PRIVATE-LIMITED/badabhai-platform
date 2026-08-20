import "server-only";
import { z } from "zod";
import { adminFetch } from "./admin-http";

/**
 * The entity data layer — the portal's read seam onto workers, payers, job postings,
 * applications and credits (BP-1, `read_entities`).
 *
 * ── EVERY SHAPE IS PARSED, NOT TRUSTED ──────────────────────────────────────────────────
 * A response that changes shape surfaces as an honest error state, never as `undefined`
 * rendering into a blank cell. That mattered concretely in Milestone 2: the metrics schema
 * assumed a bucket shape the server did not send, and the parse failure is what made the
 * problem visible instead of silently blanking a tile.
 *
 * ── NAMES, AND ONLY NAMES (owner ruling 2026-08-18, reversing ADR-0025 Decision 4) ──────
 * Three shapes below carry ONE identity field each — `full_name` on a worker, `org_name` on a
 * payer, `name` on an admin — because a console in which every row is an opaque uuid cannot be
 * used to operate the product. Each is served behind `read_identity` (super_admin / ops_admin /
 * support; `analyst` denied), a per-admin hourly egress cap, and an `admin.identity_viewed`
 * audit row the server commits BEFORE it decrypts anything.
 *
 * Every one of them is `.nullable().optional()`, and that is the contract, not laziness — see
 * `lib/identity.ts`, which is the only place the three states are interpreted:
 *   key ABSENT ⇒ this response disclosed nothing · NULL ⇒ disclosed, none on record · STRING ⇒
 *   the name. Zod 3 leaves an absent optional key ABSENT on the parsed object, which is what
 *   keeps "not disclosed" distinguishable from "no name recorded" all the way to the markup.
 *
 * ── WHAT IS STILL DELIBERATELY ABSENT ───────────────────────────────────────────────────
 * No email, no phone, no phone hash, no photo storage key, anywhere below — the server does not
 * send them, ruling or not. A worker's contact is reached only through the separate,
 * reason-gated, single-subject `reveal_pii` path; a payer's B2B contact PII (TD21) stays put.
 * There is no contact-PERSON name on a payer either: no such column exists anywhere in the
 * codebase, and neither `payers.email_enc` nor `agency_kyc.account_holder_name_enc` is a
 * substitute for one.
 *
 * ── NOTHING HERE IS EVER CACHED ─────────────────────────────────────────────────────────
 * Every call below omits `revalidate`, which is what keeps `adminFetch` on `cache: "no-store"`.
 * Passing a number instead swaps that for `next: { revalidate }` and writes the response — a
 * decrypted name included — into Next's on-disk Data Cache under `.next/cache`, where it would
 * outlive the audited read that disclosed it and be served to the next admin without one.
 * `entities.identity.test.ts` asserts it of every identity-bearing helper.
 */

/** Every list route answers this envelope. `nextCursor` null means last page. */
function pageOf<T extends z.ZodTypeAny>(item: T) {
  return z.object({ items: z.array(item), nextCursor: z.string().nullable() });
}

// ---------------------------------------------------------------------------
// workers
// ---------------------------------------------------------------------------

export const workerListItemSchema = z.object({
  id: z.string(),
  /** See the header: absent ⇒ not disclosed, null ⇒ none on record, string ⇒ the name. */
  full_name: z.string().nullable().optional(),
  status: z.string(),
  preferred_language: z.string().nullable(),
  has_photo: z.boolean(),
  resume_show_photo: z.boolean(),
  resume_night_shift_ready: z.boolean(),
  deletion_scheduled_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type WorkerListItem = z.infer<typeof workerListItemSchema>;

export const workerDetailSchema = workerListItemSchema.extend({
  profile_status: z.string().nullable(),
  profile_updated_at: z.string().nullable(),
  has_resume: z.boolean(),
  application_count: z.number(),
  unlock_count: z.number(),
});
export type WorkerDetail = z.infer<typeof workerDetailSchema>;

export const workersPageSchema = pageOf(workerListItemSchema);

export interface WorkerFilters {
  status?: string;
  pendingDeletion?: boolean;
  cursor?: string;
  limit?: number;
}

export function listWorkers(f: WorkerFilters = {}) {
  return adminFetch(`/admin/workers${qs(f)}`, { schema: workersPageSchema });
}

export function getWorker(id: string) {
  return adminFetch(`/admin/workers/${encodeURIComponent(id)}`, { schema: workerDetailSchema });
}

// ---------------------------------------------------------------------------
// payers — Companies (role=employer) and Agencies (role=agent)
// ---------------------------------------------------------------------------

export const payerListItemSchema = z.object({
  id: z.string(),
  /**
   * The BUSINESS display name (`payers.org_name_enc`), self-declared at signup — not a verified
   * legal name, and not a contact person. Same three states as the header describes.
   */
  org_name: z.string().nullable().optional(),
  role: z.enum(["employer", "agent"]),
  status: z.enum(["pending", "active", "suspended"]),
  previous_status: z.enum(["pending", "active", "suspended"]).nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type PayerListItem = z.infer<typeof payerListItemSchema>;

export const payerDetailSchema = payerListItemSchema.extend({
  credit_balance: z.number(),
  posting_count: z.number(),
  open_posting_count: z.number(),
  unlock_count: z.number(),
});
export type PayerDetail = z.infer<typeof payerDetailSchema>;

export const payersPageSchema = pageOf(payerListItemSchema);

export interface PayerFilters {
  role?: "employer" | "agent";
  status?: string;
  cursor?: string;
  limit?: number;
}

export function listPayers(f: PayerFilters = {}) {
  return adminFetch(`/admin/payers${qs(f)}`, { schema: payersPageSchema });
}

export function getPayer(id: string) {
  return adminFetch(`/admin/payers/${encodeURIComponent(id)}`, { schema: payerDetailSchema });
}

// ---------------------------------------------------------------------------
// credits
// ---------------------------------------------------------------------------

export const creditLedgerItemSchema = z.object({
  id: z.string(),
  delta: z.number(),
  reason: z.enum(["pack_purchase", "unlock_debit", "refund", "grant"]),
  unlock_id: z.string().nullable(),
  pack_code: z.string().nullable(),
  price_inr: z.number().nullable(),
  created_at: z.string(),
});
export type CreditLedgerItem = z.infer<typeof creditLedgerItemSchema>;

export const creditsViewSchema = z.object({
  payer_id: z.string(),
  balance: z.number(),
  ledger: pageOf(creditLedgerItemSchema),
});
export type CreditsView = z.infer<typeof creditsViewSchema>;

export function getPayerCredits(id: string, f: { cursor?: string; limit?: number } = {}) {
  return adminFetch(`/admin/payers/${encodeURIComponent(id)}/credits${qs(f)}`, {
    schema: creditsViewSchema,
  });
}

// ---------------------------------------------------------------------------
// job postings
// ---------------------------------------------------------------------------

export const jobPostingListItemSchema = z.object({
  id: z.string(),
  payer_id: z.string().nullable(),
  org_label: z.string(),
  role_title: z.string(),
  location_label: z.string().nullable(),
  city: z.string().nullable(),
  status: z.string(),
  verification_status: z.string(),
  vacancy_band: z.string(),
  pay_min: z.number().nullable(),
  pay_max: z.number().nullable(),
  published_at: z.string().nullable(),
  closed_at: z.string().nullable(),
  created_at: z.string(),
});
export type JobPostingListItem = z.infer<typeof jobPostingListItemSchema>;

export const jobPostingDetailSchema = jobPostingListItemSchema.extend({
  description: z.string().nullable(),
  shift: z.string().nullable(),
  needed_by: z.string().nullable(),
  boosted_until: z.string().nullable(),
  previous_status: z.string().nullable(),
  applied_count: z.number(),
  skipped_count: z.number(),
  updated_at: z.string(),
});
export type JobPostingDetail = z.infer<typeof jobPostingDetailSchema>;

export const jobPostingsPageSchema = pageOf(jobPostingListItemSchema);

export interface JobPostingFilters {
  status?: string;
  verificationStatus?: string;
  payerId?: string;
  cursor?: string;
  limit?: number;
}

export function listJobPostings(f: JobPostingFilters = {}) {
  return adminFetch(`/admin/job-postings${qs(f)}`, { schema: jobPostingsPageSchema });
}

export function getJobPosting(id: string) {
  return adminFetch(`/admin/job-postings/${encodeURIComponent(id)}`, {
    schema: jobPostingDetailSchema,
  });
}

// ---------------------------------------------------------------------------
// applications
// ---------------------------------------------------------------------------

export const applicationListItemSchema = z.object({
  id: z.string(),
  worker_id: z.string(),
  job_id: z.string().nullable(),
  job_posting_id: z.string().nullable(),
  action: z.enum(["applied", "skipped"]),
  reason: z.string().nullable(),
  source_surface: z.string(),
  match_tier: z.number().nullable(),
  engine_version: z.string().nullable(),
  created_at: z.string(),
});
export type ApplicationListItem = z.infer<typeof applicationListItemSchema>;

export const applicationsPageSchema = pageOf(applicationListItemSchema);

export interface ApplicationFilters {
  workerId?: string;
  jobPostingId?: string;
  action?: string;
  cursor?: string;
  limit?: number;
}

export function listApplications(f: ApplicationFilters = {}) {
  return adminFetch(`/admin/applications${qs(f)}`, { schema: applicationsPageSchema });
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * Build a query string from a filter object.
 *
 * Skips undefined, null AND empty string. The empty-string case is the load-bearing one:
 * an unset `<select>` submits `""`, and forwarding `?status=` to a `.strict()` Zod enum is
 * a 400 — the whole page would fail because a dropdown was left alone.
 *
 * Exported for tests: the omission rule is easy to regress and impossible to see.
 */
export function qs(filters: object): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined || value === null || value === "") continue;
    params.set(key, String(value));
  }
  const s = params.toString();
  return s ? `?${s}` : "";
}

// ---------------------------------------------------------------------------
// finance (BP-2) — credit position, the platform-wide ledger, payment orders
// ---------------------------------------------------------------------------

/**
 * Whether the ₹ figures in a response describe real money.
 *
 * `mock` means no payment provider was ever called and nobody was charged. The server sends
 * this on EVERY money-bearing response, and the UI renders it every time — a finance screen
 * that shows simulated money in the same type as real money is how TD81 happened on the AI
 * side, where staging looked healthy for weeks behind a mocked provider.
 */
export const paymentsPostureSchema = z.object({
  mode: z.enum(["real", "mock"]),
  blocked_reason: z.string().nullable(),
});
export type PaymentsPosture = z.infer<typeof paymentsPostureSchema>;

/** A finance page carries the posture alongside the rows. */
function financePageOf<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    items: z.array(item),
    nextCursor: z.string().nullable(),
    payments: paymentsPostureSchema,
  });
}

export const reasonBucketSchema = z.object({
  reason: z.enum(["pack_purchase", "unlock_debit", "refund", "grant"]),
  movements: z.number(),
  credits_delta: z.number(),
  amount_inr: z.number(),
});
export type ReasonBucket = z.infer<typeof reasonBucketSchema>;

export const financeSummarySchema = z.object({
  payments: paymentsPostureSchema,
  window_days: z.number(),
  outstanding_credits: z.number(),
  payers_with_balance: z.number(),
  by_reason: z.array(reasonBucketSchema),
  paid_orders: z.object({ count: z.number(), credits: z.number(), amount_inr: z.number() }),
  unsettled_orders: z.object({ count: z.number(), amount_inr: z.number() }),
  failed_orders: z.object({ count: z.number() }),
  top_balances: z.array(z.object({ payer_id: z.string(), balance: z.number() })),
});
export type FinanceSummary = z.infer<typeof financeSummarySchema>;

export const ledgerRowSchema = z.object({
  id: z.string(),
  payer_id: z.string(),
  delta: z.number(),
  reason: z.enum(["pack_purchase", "unlock_debit", "refund", "grant"]),
  unlock_id: z.string().nullable(),
  pack_code: z.string().nullable(),
  price_inr: z.number().nullable(),
  created_at: z.string(),
});
export type LedgerRow = z.infer<typeof ledgerRowSchema>;

export const orderRowSchema = z.object({
  id: z.string(),
  payer_id: z.string(),
  pack_code: z.string(),
  amount_inr: z.number(),
  credits_granted: z.number(),
  provider: z.string(),
  status: z.enum(["created", "paid", "failed"]),
  created_at: z.string(),
  updated_at: z.string(),
});
export type OrderRow = z.infer<typeof orderRowSchema>;

export const ledgerPageSchema = financePageOf(ledgerRowSchema);
export const ordersPageSchema = financePageOf(orderRowSchema);

export function getFinanceSummary(f: { windowDays?: number } = {}) {
  return adminFetch(`/admin/finance/summary${qs(f)}`, { schema: financeSummarySchema });
}

export function listLedger(
  f: { payerId?: string; reason?: string; cursor?: string; limit?: number } = {},
) {
  return adminFetch(`/admin/finance/ledger${qs(f)}`, { schema: ledgerPageSchema });
}

export function listOrders(
  f: { payerId?: string; status?: string; cursor?: string; limit?: number } = {},
) {
  return adminFetch(`/admin/finance/orders${qs(f)}`, { schema: ordersPageSchema });
}

// ---------------------------------------------------------------------------
// administration (BP-3) — the admin directory, roles, and the switches
// ---------------------------------------------------------------------------

export const adminRowSchema = z.object({
  id: z.string(),
  /**
   * The admin's display name — the 2026-08-18 ruling's third surface. NAMES YES, EMAILS NO:
   * nothing has reversed the email half, and it is the one that would turn this screen into the
   * complete admin ADDRESS BOOK. There is no `email` key here and there must never be one.
   *
   * `null` is the COMMON case, not the exception: the invite flow does not collect a name.
   */
  name: z.string().nullable().optional(),
  role: z.enum(["super_admin", "ops_admin", "support", "analyst"]),
  status: z.enum(["pending", "active", "suspended"]),
  mfa_enrolled: z.boolean(),
  last_login_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  is_self: z.boolean(),
});
export type AdminRow = z.infer<typeof adminRowSchema>;

export const adminDirectorySchema = z.object({
  admins: z.array(adminRowSchema),
  active_super_admins: z.number(),
});
export type AdminDirectory = z.infer<typeof adminDirectorySchema>;

export function listAdmins(f: { role?: string; status?: string } = {}) {
  return adminFetch(`/admin/admins${qs(f)}`, { schema: adminDirectorySchema });
}

/**
 * The role→capability matrix, SERVED.
 *
 * The portal carries no copy of this mapping (invariant #9). Hardcoding it here to render a
 * Roles screen would create a second authorization table that drifts the first time a row
 * changes — which is the whole reason the server answers instead.
 */
export const capabilityMatrixSchema = z.object({
  roles: z.array(z.enum(["super_admin", "ops_admin", "support", "analyst"])),
  matrix: z.array(
    z.object({
      capability: z.string(),
      roles: z.array(z.enum(["super_admin", "ops_admin", "support", "analyst"])),
    }),
  ),
});
export type CapabilityMatrix = z.infer<typeof capabilityMatrixSchema>;

export function getCapabilityMatrix() {
  return adminFetch("/admin/capabilities", { schema: capabilityMatrixSchema });
}

/**
 * The platform's provider/operational switches (ADMIN-3c).
 *
 * DISPLAY ONLY. Enabling a real provider is an env/deploy action and never a portal toggle
 * (CLAUDE.md §2 #5) — so this portal renders `pause_via` as documentation, not as a button.
 */
export const killSwitchSchema = z.object({
  switches: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      category: z.string(),
      real_spend: z.boolean(),
      state: z.enum(["live", "blocked", "paused", "disabled"]),
      detail: z.string().nullable(),
      pause_via: z.string(),
    }),
  ),
  note: z.string(),
});
export type KillSwitchStatus = z.infer<typeof killSwitchSchema>;

export function getKillSwitchStatus() {
  return adminFetch("/admin/kill-switch/status", { schema: killSwitchSchema });
}
