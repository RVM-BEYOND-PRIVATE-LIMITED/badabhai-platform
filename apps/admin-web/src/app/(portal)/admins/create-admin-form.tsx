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
import { OneTimeSecret } from "../../../components/one-time-secret";
import { createAdminAction } from "./actions";
import { ADMIN_ROLES, ROLE_LABELS, type AdminRole } from "../../../lib/auth/capabilities";
import { looksLikeAdminEmail } from "../../../lib/email-shape";
import { generateTemporaryPassword, newPasswordPairReady } from "../../../lib/password-policy";
import type { AdminActionOutcome } from "../../../lib/admin-action-result";

/** The server's bound on a display name (`/admin/admins/direct`: 1..100, trimmed). */
const NAME_MAX_CHARS = 100;

/** What the create dialog says under its title. */
export const CREATE_ADMIN_DESCRIPTION =
  "Creates an active admin with a temporary password you share with them yourself. They must replace it at their first sign-in.";

/**
 * Create an admin directly with a temporary password (ADR-0060 A6, `manage_admins`).
 *
 * Beside "Invite an admin", and the one that works without email delivery: the account is active
 * at once, and the creator hands the temporary password over themselves. At first sign-in the
 * new admin must replace it; two-step verification starts off and is theirs to turn on.
 *
 * THE PASSWORD IS SHOWN ONCE (A5, #2575). This is the body of the "Create an admin" dialog
 * (`AdminAccessDialogs`). On success the result banner names the new admin's id and role — never
 * the password — and the temporary password the creator set is shown once beneath it, with a copy
 * button, so it can be handed over without retyping it (`OneTimeSecret`). Both password fields
 * are cleared at that moment, and closing the dialog unmounts the form, so the value is gone for
 * good: there is no way to show it a second time. "Generate" fills both fields with a
 * policy-valid random password. `onPendingChange` lets the dialog refuse to close while the
 * create is in flight, so the password cannot be dropped before it is shown.
 */
export function CreateAdminForm({
  mayReadEvents,
  onPendingChange,
}: {
  mayReadEvents: boolean;
  /** The create request going out (`true`) and settling (`false`) — see AdminActionButton. */
  onPendingChange?: (pending: boolean) => void;
}) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<AdminRole>("analyst");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [outcome, setOutcome] = useState<AdminActionOutcome | null>(null);
  const [issuedPassword, setIssuedPassword] = useState<string | null>(null);
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
      router.refresh(); // the directory behind the dialog gains the new row
      setIssuedPassword(password);
      setEmail("");
      setName("");
      setPassword("");
      setConfirm("");
    }
  }

  return (
    <>
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
            onPendingChange={onPendingChange}
          />
        </div>
      </form>
      {outcome ? (
        <AdminActionResultBanner
          outcome={outcome}
          eventsLink={mayReadEvents ? ALL_ADMIN_ACTIONS_LINK : null}
        />
      ) : null}
      {outcome?.ok && issuedPassword ? (
        <OneTimeSecret
          title="Temporary password"
          body="Shown once. Hand it to the new admin yourself; they must replace it at their first sign-in."
          value={issuedPassword}
          inputLabel="Temporary password for the new admin"
          copyLabel="Copy password"
          mono
        />
      ) : null}
    </>
  );
}
