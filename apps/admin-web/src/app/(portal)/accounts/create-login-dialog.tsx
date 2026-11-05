"use client";

import { useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@badabhai/icons";
import { Dialog } from "../../../components/dialog";
import { OneTimeSecret } from "../../../components/one-time-secret";
import {
  ALL_ADMIN_ACTIONS_LINK,
  AdminActionResultBanner,
} from "../../../components/admin-action-result-banner";
import { createPayerLoginAction } from "./actions";
import { FieldError, FormSummary, useFormValidation } from "../../../components/form-feedback";
import {
  ACCOUNT_TYPES,
  ACCOUNT_TYPE_LABELS,
  type AccountType,
} from "../../../lib/account-labels";
import type { AdminActionOutcome } from "../../../lib/admin-action-result";

/** The server's reason floor (`AdminPayerReasonTextSchema`). */
const REASON_MIN_CHARS = 15;

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const PHONE = /^\+[1-9]\d{7,14}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Email or E.164 phone — the two shapes the payer door and the create route accept. */
function loginLooksValid(value: string): boolean {
  const v = value.trim();
  return EMAIL.test(v) || PHONE.test(v);
}

/**
 * "Create a login" (#2578) — an owner login for a company/agency, or a team member under an
 * existing org. The server generates the temporary password and returns it ONCE; the dialog
 * shows it with a copy button and refuses to close until the operator confirms they have shared
 * it securely.
 */
export function CreateLoginDialog({ mayReadEvents }: { mayReadEvents: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<AccountType>("company_owner");
  const [loginId, setLoginId] = useState("");
  const [orgName, setOrgName] = useState("");
  const [orgId, setOrgId] = useState("");
  const [reason, setReason] = useState("");
  const [outcome, setOutcome] = useState<AdminActionOutcome | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [shared, setShared] = useState(false);
  const [pending, startTransition] = useTransition();
  const ids = useId();

  const isTeam = type === "team_member";
  const loginValid = loginLooksValid(loginId);
  const reasonValid = reason.trim().length >= REASON_MIN_CHARS;
  const validation = useFormValidation({
    order: isTeam ? (["loginId", "orgId", "reason"] as const) : (["loginId", "orgName", "reason"] as const),
    fieldId: (field) => `${ids}-${field}`,
    focus: (field) => {
      if (typeof document !== "undefined") document.getElementById(`${ids}-${field}`)?.focus();
    },
    validate: () => {
      const errors: Partial<Record<"loginId" | "orgName" | "orgId" | "reason", string>> = {};
      if (loginId.trim() === "") errors.loginId = "Enter an email or phone number.";
      else if (!loginValid) errors.loginId = "Enter a valid email or +phone number.";
      if (isTeam) {
        if (orgId.trim() === "") errors.orgId = "Enter the organisation id.";
        else if (!UUID.test(orgId.trim())) errors.orgId = "Enter a valid organisation id.";
      } else if (orgName.trim() === "") {
        errors.orgName = "Enter the organisation name.";
      }
      if (reason.trim().length < REASON_MIN_CHARS)
        errors.reason = `Explain the reason in at least ${REASON_MIN_CHARS} characters.`;
      return errors;
    },
  });

  function reset() {
    setType("company_owner");
    setLoginId("");
    setOrgName("");
    setOrgId("");
    setReason("");
    setOutcome(null);
    setSecret(null);
    setShared(false);
  }

  function close() {
    // A minted password may not be dismissed before it has been handed over: it cannot be
    // shown again after this dialog unmounts.
    if (secret && !shared) return;
    setOpen(false);
    reset();
  }

  function submit() {
    if (validation.submit() !== null || pending) return;
    startTransition(async () => {
      const result = await createPayerLoginAction({
        loginId: loginId.trim(),
        type,
        orgName: isTeam ? undefined : orgName.trim(),
        orgId: isTeam ? orgId.trim() : undefined,
        reason: reason.trim(),
      });
      setOutcome(result);
      if (result.ok) {
        setSecret(result.temporaryPassword ?? null);
        router.refresh();
        setReason("");
      }
    });
  }

  return (
    <>
      <button className="btn btn--primary" type="button" onClick={() => setOpen(true)}>
        <Icon name="user-plus" />
        <span>Create a login</span>
      </button>

      <Dialog
        open={open}
        onClose={close}
        title="Create a login"
        description="An admin-issued login is active at once. The customer must replace the temporary password at first sign-in."
        footer={
          secret ? (
            <button
              className="btn btn--primary"
              type="button"
              onClick={close}
              disabled={!shared}
            >
              <span>Done</span>
            </button>
          ) : (
            <>
              <button className="btn btn--ghost" type="button" onClick={close} disabled={pending}>
                Cancel
              </button>
              <button
                className="btn btn--primary"
                type="button"
                onClick={submit}
                disabled={pending}
              >
                <span>{pending ? "Working…" : "Create login"}</span>
              </button>
            </>
          )
        }
      >
        {secret ? (
          <>
            {outcome ? (
              <AdminActionResultBanner
                outcome={outcome}
                eventsLink={mayReadEvents ? ALL_ADMIN_ACTIONS_LINK : null}
                onRetry={submit}
              />
            ) : null}
            <OneTimeSecret
              title="Temporary password"
              body="Shown once. Hand it to the customer yourself; they must replace it at their first sign-in."
              value={secret}
              inputLabel="Temporary password for the new customer login"
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
            <label className="field" htmlFor={`${ids}-type`}>
              <span className="field__label">Login type</span>
              <select
                id={`${ids}-type`}
                className="field__input"
                value={type}
                onChange={(e) => setType(e.target.value as AccountType)}
              >
                {ACCOUNT_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {ACCOUNT_TYPE_LABELS[t]}
                  </option>
                ))}
              </select>
            </label>

            <label className="field" htmlFor={`${ids}-login`}>
              <span className="field__label">
                Login ID — email or phone<span className="req">*</span>
              </span>
              <input
                id={`${ids}-login`}
                className="field__input"
                type="text"
                autoComplete="off"
                spellCheck={false}
                required
                value={loginId}
                onChange={(e) => setLoginId(e.target.value)}
                onBlur={() => validation.onBlur("loginId")}
                aria-invalid={
                  validation.errors.loginId
                    ? true
                    : loginId !== "" && !loginValid
                      ? true
                      : undefined
                }
                aria-describedby={
                  validation.errors.loginId ? `${ids}-loginId-error` : undefined
                }
              />
              <FieldError id={`${ids}-loginId-error`}>{validation.errors.loginId}</FieldError>
            </label>

            {isTeam ? (
              <label className="field" htmlFor={`${ids}-org`}>
                <span className="field__label">
                  Organisation id<span className="req">*</span>
                </span>
                <input
                  id={`${ids}-org`}
                  className="field__input mono"
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  required
                  value={orgId}
                  onChange={(e) => setOrgId(e.target.value)}
                  onBlur={() => validation.onBlur("orgId")}
                  aria-invalid={
                    validation.errors.orgId
                      ? true
                      : orgId !== "" && !UUID.test(orgId.trim())
                        ? true
                        : undefined
                  }
                  aria-describedby={
                    validation.errors.orgId ? `${ids}-orgId-error` : undefined
                  }
                />
                <FieldError id={`${ids}-orgId-error`}>{validation.errors.orgId}</FieldError>
              </label>
            ) : (
              <label className="field" htmlFor={`${ids}-orgname`}>
                <span className="field__label">
                  Organisation name<span className="req">*</span>
                </span>
                <input
                  id={`${ids}-orgname`}
                  className="field__input"
                  type="text"
                  autoComplete="off"
                  required
                  value={orgName}
                  onChange={(e) => setOrgName(e.target.value)}
                  onBlur={() => validation.onBlur("orgName")}
                  aria-invalid={validation.errors.orgName ? true : undefined}
                  aria-describedby={
                    validation.errors.orgName ? `${ids}-orgName-error` : undefined
                  }
                />
                <FieldError id={`${ids}-orgName-error`}>{validation.errors.orgName}</FieldError>
              </label>
            )}

            <label className="field" htmlFor={`${ids}-reason`}>
              <span className="field__label">
                Why are you creating this login?<span className="req">*</span>
              </span>
              <textarea
                id={`${ids}-reason`}
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
                  validation.errors.reason ? `${ids}-reason-error` : undefined
                }
              />
              <FieldError id={`${ids}-reason-error`}>{validation.errors.reason}</FieldError>
            </label>

            {outcome && !outcome.ok ? (
              <AdminActionResultBanner
                outcome={outcome}
                eventsLink={mayReadEvents ? ALL_ADMIN_ACTIONS_LINK : null}
                onRetry={submit}
              />
            ) : null}
          </form>
        )}
      </Dialog>
    </>
  );
}
