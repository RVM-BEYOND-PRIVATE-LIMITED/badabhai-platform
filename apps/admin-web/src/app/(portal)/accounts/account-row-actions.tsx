"use client";

import { useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@badabhai/icons";
import { Dialog } from "../../../components/dialog";
import { ConfirmDialog } from "../../../components/confirm-dialog";
import { OneTimeSecret } from "../../../components/one-time-secret";
import { FieldError, FormSummary, useFormValidation } from "../../../components/form-feedback";
import {
  ALL_ADMIN_ACTIONS_LINK,
  AdminActionResultBanner,
} from "../../../components/admin-action-result-banner";
import { issueTemporaryPasswordAction, revokePayerPasswordAction } from "./actions";
import {
  PASSWORD_STATE_LABELS,
  type AccountPasswordState,
  type AccountStatus,
  type AccountType,
} from "../../../lib/account-labels";
import { shortId } from "../../../lib/format";
import type { AdminActionOutcome } from "../../../lib/admin-action-result";

/** The reason floor the API enforces (`AdminPayerReasonTextSchema`). */
const REASON_MIN_CHARS = 15;

/**
 * A client-safe row shape — NOT `AccountListItem`, whose module is `server-only`.
 */
export interface AccountActionRow {
  id: string;
  type: AccountType;
  status: AccountStatus;
  password_state: AccountPasswordState;
  login_id?: string | null;
  organisation?: string | null;
}

/**
 * Per-row payer credential actions (#2578): issue a one-time password (with a reason, shown
 * once), and revoke password sign-in (T3, with a reason and typed confirmation).
 */
export function AccountRowActions({
  account,
  mayReadEvents,
}: {
  account: AccountActionRow;
  mayReadEvents: boolean;
}) {
  const router = useRouter();
  const [issueOpen, setIssueOpen] = useState(false);
  const [revokeOpen, setRevokeOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [pending, startTransition] = useTransition();
  const [outcome, setOutcome] = useState<AdminActionOutcome | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [shared, setShared] = useState(false);
  const [notice, setNotice] = useState<AdminActionOutcome | null>(null);
  const ids = useId();

  const subject = account.login_id
    ? account.login_id
    : `account ${shortId(account.id)}`;
  const reasonValid = reason.trim().length >= REASON_MIN_CHARS;
  const eventsLink = mayReadEvents ? ALL_ADMIN_ACTIONS_LINK : null;
  const validation = useFormValidation({
    order: ["reason"] as const,
    fieldId: () => `${ids}-issue-reason`,
    focus: () => {
      if (typeof document !== "undefined")
        document.getElementById(`${ids}-issue-reason`)?.focus();
    },
    validate: () =>
      reason.trim().length >= REASON_MIN_CHARS
        ? {}
        : { reason: `Explain the reason in at least ${REASON_MIN_CHARS} characters.` },
  });

  function closeIssue() {
    if (secret && !shared) return;
    setIssueOpen(false);
    setReason("");
    setOutcome(null);
    setSecret(null);
    setShared(false);
  }

  function issue() {
    if (validation.submit() !== null || pending) return;
    startTransition(async () => {
      const result = await issueTemporaryPasswordAction(account.id, reason.trim());
      setOutcome(result);
      if (result.ok) {
        setSecret(result.temporaryPassword ?? null);
        setReason("");
        router.refresh();
      }
    });
  }

  return (
    <div className="row-actions">
      <button
        className="btn btn--ghost btn--sm"
        type="button"
        onClick={() => setIssueOpen(true)}
      >
        <Icon name="key" />
        <span>Issue password</span>
        <span className="sr-only"> for {subject}</span>
      </button>
      <button
        className="btn btn--ghost btn--sm"
        type="button"
        onClick={() => setRevokeOpen(true)}
        disabled={account.password_state === "revoked" || account.password_state === "none"}
      >
        <Icon name="prohibit" />
        <span>Revoke password</span>
        <span className="sr-only"> for {subject}</span>
      </button>

      {notice ? <AdminActionResultBanner outcome={notice} eventsLink={eventsLink} /> : null}

      <Dialog
        open={issueOpen}
        onClose={closeIssue}
        title="Issue a one-time password"
        description={`The customer must replace it at first sign-in. It is shown once.`}
        footer={
          secret ? (
            <button
              className="btn btn--primary"
              type="button"
              onClick={closeIssue}
              disabled={!shared}
            >
              <span>Done</span>
            </button>
          ) : (
            <>
              <button
                className="btn btn--ghost"
                type="button"
                onClick={closeIssue}
                disabled={pending}
              >
                Cancel
              </button>
              <button
                className="btn btn--primary"
                type="button"
                onClick={issue}
                disabled={pending}
              >
                <span>{pending ? "Working…" : "Issue password"}</span>
              </button>
            </>
          )
        }
      >
        {secret ? (
          <>
            {outcome ? (
              <AdminActionResultBanner outcome={outcome} eventsLink={eventsLink} />
            ) : null}
            <OneTimeSecret
              title="Temporary password"
              body="Shown once. Hand it to the customer yourself; they must replace it at their first sign-in."
              value={secret}
              inputLabel={`Temporary password for ${subject}`}
              copyLabel="Copy password"
              mono
            />
            <label className="field field--check">
              <input
                type="checkbox"
                checked={shared}
                onChange={(e) => setShared(e.target.checked)}
              />
              <span className="field__label">
                I have shared this password securely with the customer
              </span>
            </label>
          </>
        ) : (
          <form
            className={validation.shaking ? "form form--shake" : "form"}
            onSubmit={(e) => e.preventDefault()}
            noValidate
          >
            <FormSummary errors={validation.visible} />
            <label className="field" htmlFor={`${ids}-issue-reason`}>
              <span className="field__label">
                Why are you issuing a new password?<span className="req">*</span>
              </span>
              <textarea
                id={`${ids}-issue-reason`}
                className="field__input"
                rows={3}
                required
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                onBlur={() => validation.onBlur("reason")}
                aria-invalid={
                  validation.errors.reason
                    ? true
                    : reason !== "" && !reasonValid
                      ? true
                      : undefined
                }
                aria-describedby={
                  validation.errors.reason ? `${ids}-issue-reason-error` : undefined
                }
              />
              <FieldError id={`${ids}-issue-reason-error`}>
                {validation.errors.reason}
              </FieldError>
            </label>
            {outcome && !outcome.ok ? (
              <AdminActionResultBanner
                outcome={outcome}
                eventsLink={eventsLink}
                onRetry={issue}
              />
            ) : null}
          </form>
        )}
      </Dialog>

      <ConfirmDialog
        open={revokeOpen}
        onClose={() => setRevokeOpen(false)}
        tier="destructive"
        targetName={subject}
        title="Revoke password sign-in"
        description="The customer can still sign in with an emailed code. Every password session is signed out."
        changes={[
          {
            label: "Password sign-in",
            before: PASSWORD_STATE_LABELS[account.password_state],
            after: "Revoked",
          },
        ]}
        confirmLabel="Revoke password"
        onConfirm={({ text }) => revokePayerPasswordAction(account.id, text)}
        onSettled={(result) => {
          setNotice(result);
          if (result.ok) router.refresh();
        }}
      />
    </div>
  );
}
