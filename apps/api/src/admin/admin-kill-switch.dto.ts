import { z } from "zod";
import {
  AdminKillSwitchKey,
  AdminKillSwitchPauseReason,
  type AdminKillSwitchKey as AdminKillSwitchKeyType,
} from "@badabhai/event-schema";

/**
 * Zod DTOs + response shapes for the ADMIN-3c kill-switch surface (ADR-0025 OQ-6). Two routes:
 *   - GET  /admin/kill-switch/status        — read-only DISPLAY of the live switch state.
 *   - POST /admin/kill-switch/pause-request — record an audited safe-direction PAUSE INTENT.
 *
 * HARD INVARIANT (§2 #5 / §7): there is NO field, route, or value here that ENABLES a real
 * provider. The `switch_key` + `reason_code` are CLOSED enums (codes, never free text), the body
 * is `.strict()` (no value/secret can ride in), and the pause is recorded as INTENT — actioned
 * out-of-band via env/deploy. ENABLING stays env/deploy-gated, staging-first, key-required.
 */

/** The switch keys + pause reasons are the SINGLE source of truth in `@badabhai/event-schema`. */
export { AdminKillSwitchKey, AdminKillSwitchPauseReason };

/**
 * POST /admin/kill-switch/pause-request body — a CLOSED switch key + a CLOSED reason code.
 * `.strict()` rejects any extra (value/secret-shaped) key. No provider key, no toggle value, no
 * free text — the audited intent is value-free by construction (Control: spine never a value sink).
 */
export const AdminKillSwitchPauseRequestSchema = z
  .object({
    switch_key: AdminKillSwitchKey,
    reason_code: AdminKillSwitchPauseReason,
  })
  .strict();
export type AdminKillSwitchPauseRequestDto = z.infer<typeof AdminKillSwitchPauseRequestSchema>;

/** Coarse grouping of a switch for the display (PII-free, presentation only). */
export type KillSwitchCategory =
  | "ai"
  | "payments"
  | "messaging"
  | "auth_otp"
  | "render"
  | "admin_pii";

/**
 * The live operational state of a switch, derived from server config (PII-free):
 *   - "live"    — the path is ACTIVE (for a real-provider switch this is the spend-incurring state).
 *   - "paused"  — a runtime pause is in effect (e.g. an OTP global cap set to 0).
 *   - "blocked" — a real-provider path is OFF by its config gate (the safe/inert state).
 *   - "disabled"— a non-spend feature flag is OFF.
 */
export type KillSwitchState = "live" | "paused" | "blocked" | "disabled";

/** One switch's read-only status row. PII-FREE: enums/labels/booleans + an operational reason. */
export interface KillSwitchStatusItem {
  key: AdminKillSwitchKeyType;
  label: string;
  category: KillSwitchCategory;
  /** True when this switch governs a REAL-spend / real-provider path. */
  real_spend: boolean;
  /** The live state derived from server config. */
  state: KillSwitchState;
  /** A PII-free operational reason (e.g. "AI_ENABLE_REAL_CALLS is false") — NEVER a secret/value. */
  detail: string | null;
  /** The SAFE-DIRECTION env lever to pause it (a var name + value — NEVER a secret). Enabling is
   *  NOT offered here: it stays env/deploy-gated, staging-first, key-required (§2 #5 / §7). */
  pause_via: string;
}

/** GET /admin/kill-switch/status response — the faceless switch snapshot + the invariant note. */
export interface KillSwitchStatusResponse {
  switches: KillSwitchStatusItem[];
  /** The invariant the surface upholds — display + safe-direction pause only; enabling is env-gated. */
  note: string;
}

/** POST /admin/kill-switch/pause-request response — the audited intent was recorded (no runtime flip). */
export interface AdminKillSwitchPauseRequestResponse {
  switch_key: AdminKillSwitchKeyType;
  /** True — the pause INTENT is recorded on the spine. It does NOT by itself change runtime. */
  recorded: true;
  /** The operational next step — the actual pause is applied via env/deploy (§2 #5). */
  action_required: string;
}
