import { z } from "zod";
import type { AdminRole, WorkerFlagReasonCode } from "@badabhai/db";

/**
 * Zod DTOs for the ADMIN-3a governed entity actions (ADR-0025 Decision 3/5/6). Every body is
 * `.strict()` so no extra (PII-shaped) key can ride in. The reason / role / flag-reason fields
 * are CLOSED enums (CODES, never free text) — they are written to the system-of-record row, and
 * NEVER into the emitted event payload (the event carries action_code + opaque ids only).
 *
 * Target ids are the validated PATH params (see the param schemas) — the actor is always the
 * SESSION admin (`@CurrentAdmin().id`); no body here carries an actor or a target id.
 */

/** A uuid path param (`:id`) — the spoofing-proof target id (validated, never from the body). */
export const AdminTargetParamsSchema = z.object({ id: z.string().uuid() }).strict();
export type AdminTargetParamsDto = z.infer<typeof AdminTargetParamsSchema>;

// ----- credit grant (amount bounded > 0 + a closed grant reason CODE) --------

/** Hard upper bound on a single admin credit grant (mock credits; ADR-0010 §D5). */
export const ADMIN_CREDIT_GRANT_MAX = 10_000;

/**
 * The reason CODE behind an admin credit grant (a CLOSED code, never free text). It is recorded
 * on the credit_ledger context (the SoR), NOT in the event payload.
 */
export const ADMIN_CREDIT_GRANT_REASONS = [
  "goodwill",
  "correction",
  "promo",
  "support_resolution",
] as const;
export const AdminCreditGrantReason = z.enum(ADMIN_CREDIT_GRANT_REASONS);
export type AdminCreditGrantReason = z.infer<typeof AdminCreditGrantReason>;

/**
 * POST /admin/payers/:id/credits body — a positive integer amount + a closed reason code + a
 * client-supplied UUID idempotency key (H2). The key is the EXACTLY-ONCE token for this money
 * movement: it is validated as a UUID (NOT the raw, client-controllable `x-request-id`) and keys
 * BOTH the credit_ledger insert AND the `credits_granted` event — so a retry with the same key is
 * exactly-once on ledger + spine (no double-spend, no money-vs-spine divergence). It is an opaque
 * id — no value/PII rides on it; it is NEVER put on the event payload, only on its dedup key.
 */
export const AdminGrantCreditsSchema = z
  .object({
    amount: z.number().int().positive().max(ADMIN_CREDIT_GRANT_MAX),
    reason_code: AdminCreditGrantReason,
    idempotency_key: z.string().uuid(),
  })
  .strict();
export type AdminGrantCreditsDto = z.infer<typeof AdminGrantCreditsSchema>;

// ----- worker flag (the reason-code enum FROM the db type) -------------------

/**
 * The worker-flag reason CODE — pinned to the DB union (`db.WorkerFlagReasonCode` /
 * `worker_flags_reason_code_chk`). `satisfies` makes a future drift between this enum and the
 * db type a COMPILE error. The code lives on the worker_flags ROW, never in the event payload.
 */
export const WORKER_FLAG_REASON_CODES = [
  "quality_review",
  "abuse_report",
  "duplicate",
  "other",
] as const satisfies readonly WorkerFlagReasonCode[];
export const WorkerFlagReasonCodeEnum = z.enum(WORKER_FLAG_REASON_CODES);

/** POST /admin/workers/:id/flag body — a closed reason CODE only. */
export const AdminFlagWorkerSchema = z
  .object({ reason_code: WorkerFlagReasonCodeEnum })
  .strict();
export type AdminFlagWorkerDto = z.infer<typeof AdminFlagWorkerSchema>;

// ----- admin management (invite / role change) ------------------------------

/**
 * The assignable admin roles (mirrors `db.AdminRole`). `satisfies` pins it to the db union so a
 * drift is a compile error. The role is a CODE written to admin_users — never into an event.
 */
export const ADMIN_ROLES = [
  "super_admin",
  "ops_admin",
  "support",
  "analyst",
] as const satisfies readonly AdminRole[];
export const AdminRoleEnum = z.enum(ADMIN_ROLES);

/** POST /admin/admins body — invite a new admin by work email + role (status defaults pending). */
export const AdminInviteSchema = z
  .object({
    email: z.string().trim().toLowerCase().email().max(254),
    role: AdminRoleEnum,
  })
  .strict();
export type AdminInviteDto = z.infer<typeof AdminInviteSchema>;

/** PATCH /admin/admins/:id/role body — the new role CODE. */
export const AdminChangeRoleSchema = z.object({ role: AdminRoleEnum }).strict();
export type AdminChangeRoleDto = z.infer<typeof AdminChangeRoleSchema>;

// ----- response shapes (PII-FREE: ids + enums + codes only) ------------------

/** A governed-action result: the action outcome + whether it actually changed state. */
export interface AdminActionResult {
  /** The opaque target id the action addressed (the path param). */
  target_id: string;
  /** True when the SoR row changed; false on an idempotent no-op (already in target state). */
  changed: boolean;
}
