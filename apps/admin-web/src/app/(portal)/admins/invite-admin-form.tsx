"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { AdminActionButton } from "../../../components/admin-action-button";
import { AdminActionResultBanner } from "../../../components/admin-action-result-banner";
import { inviteAdminAction } from "./actions";
import { ADMIN_ROLES, ROLE_LABELS, type AdminRole } from "../../../lib/auth/capabilities";
import type { AdminActionOutcome } from "../../../lib/admin-action-result";

/** Invite a new admin by work email + role (`manage_admins`). Status defaults to `pending`. */
export function InviteAdminForm() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<AdminRole>("analyst");
  const [outcome, setOutcome] = useState<AdminActionOutcome | null>(null);
  const emailId = useId();
  const roleId = useId();

  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

  function handleSettled(o: AdminActionOutcome) {
    setOutcome(o);
    if (o.ok) {
      router.refresh();
      setEmail("");
    }
  }

  return (
    <section className="panel" aria-labelledby="ad-invite">
      <div className="panel__head">
        <h2 className="panel__title" id="ad-invite">
          Invite an admin
        </h2>
        <p className="panel__sub">
          Sends an invite to a work email. The account starts `pending` until they sign in.
        </p>
      </div>
      <form className="form" onSubmit={(e) => e.preventDefault()}>
        <div className="form-grid">
          <label className="field" htmlFor={emailId}>
            <span className="field__label">
              Work email<span className="req">*</span>
            </span>
            <input
              id={emailId}
              className="field__input"
              type="email"
              autoComplete="off"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              aria-invalid={email !== "" && !emailValid ? true : undefined}
            />
          </label>
          <label className="field" htmlFor={roleId}>
            <span className="field__label">Role</span>
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
        </div>
        <div className="form-actions">
          <AdminActionButton
            label="Invite admin"
            confirmLabel={`Confirm invite for ${email || "this address"}?`}
            variant="primary"
            disabled={!emailValid}
            action={() => inviteAdminAction({ email, role })}
            onSettled={handleSettled}
          />
        </div>
      </form>
      {outcome && (
        <AdminActionResultBanner
          outcome={outcome}
          timelineHref="/events?eventName=admin.action_performed"
        />
      )}
    </section>
  );
}
