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
  /**
   * A one-time link the action wants the operator to copy (#1494 — the admin invite
   * accept URL). OPTIONAL and shown once; the only producer today is `inviteAdminAction`.
   *
   * A BEARER SECRET. A renderer may display it and offer a copy button; it must not log
   * it, put it in an analytics event, or persist it client-side. It cannot be retrieved
   * again from the server.
   */
  acceptUrl?: string;
  /** ISO expiry for [acceptUrl], so the operator can say how long the link is good for. */
  acceptExpiresAt?: string;
}

export interface AdminActionFailure {
  ok: false;
  error: string;
}

export type AdminActionOutcome = AdminActionSuccess | AdminActionFailure;
