"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { AdminActionButton } from "../../../components/admin-action-button";
import { AdminActionResultBanner } from "../../../components/admin-action-result-banner";
import { changeAdminRoleAction, resetAdminMfaAction, suspendAdminAction } from "./actions";
import { ADMIN_ROLES, ROLE_LABELS, type AdminRole } from "../../../lib/auth/capabilities";
import type { AdminActionOutcome } from "../../../lib/admin-action-result";
import { ACTION_ICON } from "@badabhai/icons";

/**
 * A minimal, client-safe row shape — deliberately NOT `AdminRow` from `lib/entities.ts`,
 * which is `import "server-only"` and must never be reachable from a `"use client"` module's
 * dependency graph.
 */
export interface AdminActionRow {
  id: string;
  role: AdminRole;
  status: "pending" | "active" | "suspended";
  is_self: boolean;
}

/**
 * Per-row governed actions on the admins directory (`manage_admins`): change role, reset MFA,
 * suspend.
 *
 * `is_self` hides EVERY control here — the backend rejects all three self-targeting
 * (`AdminActionsService.changeAdminRole` / `.suspendAdmin` / `.resetAdminMfa` each refuse the
 * caller's own id, and `resetAdminMfa` refuses it even for a super_admin) — so this mirrors
 * the server's own guard set rather than re-deciding it: the client never lets the request
 * fire, and if it somehow still did, `describeAdminActionError` would show the server's exact
 * rejection text, never a guess.
 */
export function AdminRowActions({
  admin,
  mayReadEvents,
}: {
  admin: AdminActionRow;
  /** Whether the session may open `/events` (`read_events`) — the result banner's link. */
  mayReadEvents: boolean;
}) {
  const router = useRouter();
  const [role, setRole] = useState<AdminRole>(admin.role);
  const [outcome, setOutcome] = useState<AdminActionOutcome | null>(null);
  const roleId = useId();
  // Every other entity now has a per-entity timeline route; admins deliberately do NOT.
  // `admin_session` is absent from ADMIN_TIMELINE_SUBJECT_TYPES (mirrored verbatim from the
  // server in `lib/events.ts`), so /admin/entities/admin_session/:id/timeline would be a
  // server-side 400. The honest destination is therefore the subject-type-wide stream: the
  // action's own `admin.action_performed` lands there (subject_type `admin_session`, newest
  // first), just not filtered to this row. Carrying a `subjectId` here would be worse than
  // useless — `EventFilters` has no such field, so it would promise a per-admin slice and
  // silently render every admin's events. So it is the global log, and is called that.
  const eventsLink = mayReadEvents
    ? { href: "/events?subjectType=admin_session", label: "View events" }
    : null;

  // Every row's controls share their visible names, so each one also names its row for
  // assistive tech ("Suspend admin aaaaaaaa…"). The id is the handle the row shows.
  const subject = `admin ${admin.id.slice(0, 8)}…`;

  if (admin.is_self) {
    return <span className="table__meta">Your own account</span>;
  }

  function handleSettled(o: AdminActionOutcome) {
    setOutcome(o);
    if (o.ok) router.refresh();
  }

  return (
    <div className="row-actions">
      <div className="admin-action">
        <label className="field" htmlFor={roleId}>
          <span className="sr-only">New role for {subject}</span>
          <select
            id={roleId}
            className="field__input"
            value={role}
            onChange={(e) => setRole(e.target.value as AdminRole)}
          >
            {ADMIN_ROLES.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABELS[r]}
              </option>
            ))}
          </select>
        </label>
        <AdminActionButton
          label="Change role"
          icon="user-switch"
          subject={subject}
          confirmLabel={`Confirm ${ROLE_LABELS[role]}?`}
          variant="primary"
          disabled={role === admin.role}
          action={() => changeAdminRoleAction(admin.id, role)}
          onSettled={handleSettled}
        />
      </div>
      <AdminActionButton
        label="Reset MFA"
        icon="key"
        subject={subject}
        confirmLabel="Confirm MFA reset?"
        variant="danger"
        action={() => resetAdminMfaAction(admin.id)}
        onSettled={handleSettled}
      />
      <AdminActionButton
        label="Suspend"
        icon={ACTION_ICON.suspend}
        subject={subject}
        confirmLabel="Confirm suspend?"
        variant="danger"
        disabled={admin.status === "suspended"}
        action={() => suspendAdminAction(admin.id)}
        onSettled={handleSettled}
      />
      {outcome && <AdminActionResultBanner outcome={outcome} eventsLink={eventsLink} />}
    </div>
  );
}
