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
  const orgValid = isTeam ? UUID.test(orgId.trim()) : orgName.trim().length > 0;
  const reasonValid = reason.trim().length >= REASON_MIN_CHARS;
  const ready = loginValid && orgValid && reasonValid;

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
    if (!ready || pending) return;
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
                disabled={!ready || pending}
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
          <form className="form" onSubmit={(e) => e.preventDefault()} noValidate>
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
                aria-invalid={loginId !== "" && !loginValid ? true : undefined}
              />
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
                  aria-invalid={orgId !== "" && !UUID.test(orgId.trim()) ? true : undefined}
                />
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
                />
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
                aria-invalid={reason !== "" && !reasonValid ? true : undefined}
              />
            </label>

            {outcome && !outcome.ok ? (
              <AdminActionResultBanner
                outcome={outcome}
                eventsLink={mayReadEvents ? ALL_ADMIN_ACTIONS_LINK : null}
              />
            ) : null}
          </form>
        )}
      </Dialog>
    </>
  );
}
