/**
 * The closed set of admin action CODES recorded on the spine (`admin.action_performed.action_code`).
 * One per route outcome; a CODE only — the action_code is the WHAT, never the value (the new
 * status, the amount, the reason). Pinned here so a typo can't drift the audited code.
 *
 * Kept in its own module (not `admin-actions.service.ts`) so a repository — including a
 * security gate like the PIN-reset watermark query — can import the constant without pulling in
 * the whole admin service and creating a runtime cycle.
 */
export const ADMIN_ACTION_CODES = {
  payer_suspended: "payer_suspended",
  payer_reinstated: "payer_reinstated",
  credits_granted: "credits_granted",
  posting_force_closed: "posting_force_closed",
  worker_flagged: "worker_flagged",
  worker_unflagged: "worker_unflagged",
  admin_invited: "admin_invited",
  // The invitee redeeming their accept link (pending → active). Recorded as its own code, and
  // with the accepting admin as BOTH actor and target: they are the only principal in the
  // request (the accept is unauthenticated — the token is the proof), and an audit trail that
  // attributed the activation to the original inviter would misstate who acted and when.
  admin_invite_accepted: "admin_invite_accepted",
  admin_role_changed: "admin_role_changed",
  admin_suspended: "admin_suspended",
  admin_mfa_reset: "admin_mfa_reset",
  // ── Migration 0144 — admin password sign-in + optional two-step (owner 2026-11-03) ──────────
  // Every one targets an ADMIN (subject/target `admin_session`). The password, the code, the
  // device token and the email NEVER ride the event — the code names WHAT happened, nothing else.
  //   admin_created        — a super_admin created an ACTIVE admin directly with a temporary
  //                          password (actor = creator, target = the new admin).
  //   admin_password_set   — a password was set or changed by its owner: the must-change step
  //                          on first sign-in, or the Account page (actor = target = self).
  //   admin_password_reset — a forgot-password code was redeemed (actor = target = the admin;
  //                          the request is unauthenticated, the emailed code is the proof).
  //   admin_device_trusted — a browser was trusted to skip the two-step step for N days.
  //   admin_mfa_enabled    — the admin switched their own two-step ON (code confirmed).
  //   admin_mfa_disabled   — the admin switched their own two-step OFF (current code proven).
  admin_created: "admin_created",
  admin_password_set: "admin_password_set",
  admin_password_reset: "admin_password_reset",
  admin_device_trusted: "admin_device_trusted",
  admin_mfa_enabled: "admin_mfa_enabled",
  admin_mfa_disabled: "admin_mfa_disabled",
  // ── Migration 0093 — skill-candidate review decisions ────────────────────────────────────
  // FIVE codes, not one `skill_candidate_reviewed` plus a payload field, because the spine is
  // VALUE-FREE: which way a reviewer decided IS the value, and the only free-form string the
  // spine carries is the action code. Collapsing them would either lose the decision from the
  // audit trail entirely or smuggle it back as a payload key that `.strict()` rejects.
  //
  // Each code is named for the SoR STATUS it records, not for the wire word the console sends
  // (the request body says `alias`/`hold`, the ladder says `approved_map`/`deferred` — see the
  // decision DTO). That is deliberate: the code is then a total function of
  // `statusForDecision(...)`, so an auditor reconciling the spine against a `skill_candidate`
  // row needs no translation table, and a mismatch between the two is visible rather than
  // arguable. The reason text, the proposed label, the target skill id and the confidence band
  // stay on the row — none of them may ride an event.
  skill_candidate_approved_create: "skill_candidate_approved_create",
  skill_candidate_approved_map: "skill_candidate_approved_map",
  skill_candidate_approved_merge: "skill_candidate_approved_merge",
  skill_candidate_rejected: "skill_candidate_rejected",
  skill_candidate_deferred: "skill_candidate_deferred",
  // ── #2563 — payer login management ──────────────────────────────────────────────────────
  // Three codes, each targeting a PAYER. The temporary password, its hash and the login ID
  // never ride the event; the reason code/text lives on the `audit_logs` row written in the
  // same transaction, because `admin.action_performed` is `.strict()` and value-free.
  payer_login_created: "payer_login_created",
  payer_login_create_conflict: "payer_login_create_conflict",
  payer_password_issued: "payer_password_issued",
  payer_password_revoked: "payer_password_revoked",
  // ── #2562 — worker account actions ──────────────────────────────────────────────────────
  worker_signed_out_all: "worker_signed_out_all",
  worker_pin_reset: "worker_pin_reset",
  worker_suspended: "worker_suspended",
  worker_reinstated: "worker_reinstated",
} as const;

export type AdminActionCode = (typeof ADMIN_ACTION_CODES)[keyof typeof ADMIN_ACTION_CODES];
