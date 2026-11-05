"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { AdminActionButton } from "../../../components/admin-action-button";
import {
  ALL_ADMIN_ACTIONS_LINK,
  AdminActionResultBanner,
} from "../../../components/admin-action-result-banner";
import { inviteAdminAction } from "./actions";
import { ADMIN_ROLES, ROLE_LABELS, type AdminRole } from "../../../lib/auth/capabilities";
import { looksLikeAdminEmail } from "../../../lib/email-shape";
import type { AdminActionOutcome } from "../../../lib/admin-action-result";
import { ACTION_ICON } from "@badabhai/icons";
import { Timestamp } from "../../../components/timestamp";
import { OneTimeSecret } from "../../../components/one-time-secret";
import { FieldError, FormSummary, useFormValidation } from "../../../components/form-feedback";

/** What the invite dialog says under its title. */
export const INVITE_ADMIN_DESCRIPTION =
  "Creates a pending admin and a one-time accept link, shown here once for you to share. An email is sent only when real invite delivery is configured.";

/**
 * Invite a new admin by work email + role (`manage_admins`). Status defaults to `pending`.
 *
 * The body of the "Invite an admin" dialog (`AdminAccessDialogs`), which owns its title and
 * description; the result and the one-time link render inside it, and closing the dialog drops
 * them (the link cannot be fetched again) — so `onPendingChange` lets the dialog refuse to close
 * while the invite is in flight.
 */
export function InviteAdminForm({
  mayReadEvents,
  onPendingChange,
}: {
  /** Whether the session may open `/events` (`read_events`) — the result banner's link. */
  mayReadEvents: boolean;
  /** The invite request going out (`true`) and settling (`false`) — see AdminActionButton. */
  onPendingChange?: (pending: boolean) => void;
}) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<AdminRole>("analyst");
  const [outcome, setOutcome] = useState<AdminActionOutcome | null>(null);
  const emailId = useId();
  const roleId = useId();

  const emailValid = looksLikeAdminEmail(email);
  const validation = useFormValidation({
    order: ["email"] as const,
    fieldId: () => emailId,
    focus: () => {
      if (typeof document !== "undefined") document.getElementById(emailId)?.focus();
    },
    validate: () => {
      if (email.trim() === "") return { email: "Enter the admin's work email." };
      if (!emailValid) return { email: "Enter a valid email address." };
      return {};
    },
  });

  async function runInvite(): Promise<AdminActionOutcome> {
    const outcome = await inviteAdminAction({ email, role });
    handleSettled(outcome);
    return outcome;
  }

  function handleSettled(o: AdminActionOutcome) {
    setOutcome(o);
    if (o.ok) {
      // The refresh repopulates the admin table. `outcome` is component state, so the
      // accept link SURVIVES it — which matters, because the link cannot be fetched
      // again and losing it would strand the invitee.
      router.refresh();
      setEmail("");
    }
  }

  return (
    <>
      <form
        className={validation.shaking ? "form form--shake" : "form"}
        onSubmit={(e) => e.preventDefault()}
      >
        <FormSummary errors={validation.visible} />
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
              onBlur={() => validation.onBlur("email")}
              aria-invalid={
                validation.errors.email ? true : email !== "" && !emailValid ? true : undefined
              }
              aria-describedby={
                validation.errors.email ? `${emailId}-error` : undefined
              }
            />
            <FieldError id={`${emailId}-error`}>{validation.errors.email}</FieldError>
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
            label="Invite an admin"
            icon={ACTION_ICON.send}
            confirmLabel={`Confirm invite for ${email || "this address"}?`}
            variant="primary"
            disabled={!emailValid}
            action={runInvite}
            onPendingChange={onPendingChange}
          />
        </div>
      </form>
      {outcome && (
        <AdminActionResultBanner
          outcome={outcome}
          eventsLink={mayReadEvents ? ALL_ADMIN_ACTIONS_LINK : null}
          onRetry={runInvite}
        />
      )}
      {outcome?.ok && outcome.acceptUrl ? (
        <AcceptLink url={outcome.acceptUrl} expiresAt={outcome.acceptExpiresAt} />
      ) : null}
    </>
  );
}

/**
 * The one-time accept link, shown once, right after a successful invite (#1494).
 *
 * THIS IS HOW ONBOARDING WORKS BY DEFAULT. `ADMIN_INVITES_ENABLE_REAL` is off unless
 * explicitly enabled and an email provider is configured, so in the ordinary case no mail
 * is sent and this link is the only way the invitee can ever reach the accept page.
 *
 * A BEARER SECRET (`OneTimeSecret`). It cannot be fetched again — re-inviting a pending admin
 * mints a fresh link and invalidates this one.
 */
function AcceptLink({ url, expiresAt }: { url: string; expiresAt?: string }) {
  return (
    <OneTimeSecret
      title="Send this link to the invitee"
      body={
        <>
          Shown once. No email was sent unless real invite delivery is configured
          {expiresAt ? (
            <>
              {" "}
              — the link expires <Timestamp iso={expiresAt} />
            </>
          ) : null}
          .
        </>
      }
      value={url}
      inputLabel="Invite accept link"
      copyLabel="Copy link"
    />
  );
}
