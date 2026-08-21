/**
 * The envelope every governed-action Server Action resolves to (BP-1 ADMIN-3a wiring).
 *
 * Mirrors the ok/error shape `login/actions.ts` already established — every mutating Server
 * Action in this app returns one of these instead of throwing, so a `"use client"` caller
 * never needs a try/catch around a transition.
 *
 * `changed` carries the server's `AdminActionResult.changed` through unmodified: `false` is a
 * SUCCESSFUL no-op (e.g. "already suspended"), never an error. Every renderer of this type
 * must treat `ok: true` as success regardless of `changed`, and reserve the failure/danger
 * treatment for `ok: false` alone (Step 3 of the admin write-action plan).
 */
export interface AdminActionSuccess {
  ok: true;
  changed: boolean;
  message: string;
}

export interface AdminActionFailure {
  ok: false;
  error: string;
}

export type AdminActionOutcome = AdminActionSuccess | AdminActionFailure;
