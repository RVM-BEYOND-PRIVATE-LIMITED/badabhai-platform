"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@badabhai/icons";
import { AdminActionButton } from "../../../components/admin-action-button";
import {
  ALL_ADMIN_ACTIONS_LINK,
  AdminActionResultBanner,
} from "../../../components/admin-action-result-banner";
import { NewPasswordFields } from "../../../components/new-password-fields";
import { createAdminAction } from "./actions";
import { ADMIN_ROLES, ROLE_LABELS, type AdminRole } from "../../../lib/auth/capabilities";
import { looksLikeAdminEmail } from "../../../lib/email-shape";
import { generateTemporaryPassword, newPasswordPairReady } from "../../../lib/password-policy";
import type { AdminActionOutcome } from "../../../lib/admin-action-result";

/** The server's bound on a display name (`/admin/admins/direct`: 1..100, trimmed). */
const NAME_MAX_CHARS = 100;

/**
 * Create an admin directly with a temporary password (ADR-0060 A6, `manage_admins`).
 *
 * Beside "Invite an admin", and the one that works without email delivery: the account is active
 * at once, and the creator hands the temporary password over themselves. At first sign-in the
 * new admin must replace it; two-step verification starts off and is theirs to turn on.
 *
 * THE PASSWORD IS NEVER ECHOED BACK. The result banner names the new admin's id and role and
 * says how to hand over the password, but not the password: a banner is screenshotted, pasted
 * into chat and left on screen. Both password fields are cleared on success, so the value lives
 * only as long as the form needs it. "Generate" fills both fields with a policy-valid random
 * password and reveals nothing the creator would not see by pressing the field's own Show.
 */
export function CreateAdminForm({ mayReadEvents }: { mayReadEvents: boolean }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<AdminRole>("analyst");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [outcome, setOutcome] = useState<AdminActionOutcome | null>(null);
  const ids = useId();

  const emailValid = looksLikeAdminEmail(email);
  const nameValid = name.trim().length > 0 && name.trim().length <= NAME_MAX_CHARS;
  const ready = emailValid && nameValid && newPasswordPairReady(password, confirm);

  function generate() {
    const value = generateTemporaryPassword();
    setPassword(value);
    setConfirm(value);
  }

  function handleSettled(o: AdminActionOutcome) {
    setOutcome(o);
    if (o.ok) {
      router.refresh(); // the directory above gains the new row
      setEmail("");
      setName("");
      setPassword("");
      setConfirm("");
    }
  }

  return (
    <section className="panel" aria-labelledby="ad-create">
      <div className="panel__head">
        <h2 className="panel__title" id="ad-create">
          Create an admin
        </h2>
        <p className="panel__sub">
          Creates an active admin with a temporary password you share with them yourself. They
          must replace it at their first sign-in.
        </p>
      </div>
      <form className="form" onSubmit={(e) => e.preventDefault()} noValidate>
        <div className="form-grid">
          <label className="field" htmlFor={`${ids}-email`}>
            <span className="field__label">
              Work email<span className="req">*</span>
            </span>
            <input
              id={`${ids}-email`}
              className="field__input"
              type="email"
              autoComplete="off"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              aria-invalid={email !== "" && !emailValid ? true : undefined}
            />
          </label>
          <label className="field" htmlFor={`${ids}-name`}>
            <span className="field__label">
              Full name<span className="req">*</span>
            </span>
            <input
              id={`${ids}-name`}
              className="field__input"
              type="text"
              autoComplete="off"
              maxLength={NAME_MAX_CHARS}
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              aria-invalid={name !== "" && !nameValid ? true : undefined}
            />
          </label>
        </div>
        <label className="field" htmlFor={`${ids}-role`}>
          <span className="field__label">Role</span>
          <select
            id={`${ids}-role`}
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
        <NewPasswordFields
          value={password}
          confirm={confirm}
          onChange={setPassword}
          onConfirmChange={setConfirm}
          label="Temporary password"
          confirmLabel="Confirm temporary password"
          autoComplete="off"
          required
        />
        <div className="form-actions">
          <button className="btn btn--ghost btn--sm" type="button" onClick={generate}>
            <Icon name="key" />
            <span>Generate a password</span>
          </button>
          <AdminActionButton
            label="Create admin"
            icon="user-plus"
            confirmLabel={`Confirm: create ${email || "this admin"} as ${ROLE_LABELS[role]}?`}
            variant="primary"
            disabled={!ready}
            action={() => createAdminAction({ email, name, role, temporaryPassword: password })}
            onSettled={handleSettled}
          />
        </div>
      </form>
      {outcome ? (
        <AdminActionResultBanner
          outcome={outcome}
          eventsLink={mayReadEvents ? ALL_ADMIN_ACTIONS_LINK : null}
        />
      ) : null}
    </section>
  );
}
