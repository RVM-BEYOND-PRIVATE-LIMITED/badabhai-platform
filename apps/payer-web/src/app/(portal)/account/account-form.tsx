"use client";

import { useState, useTransition } from "react";
import type { FormEvent } from "react";
import { useRouter } from "next/navigation";
import { e164PhoneSchema } from "@badabhai/validators";
import { Badge, Button, Card, Input, Toast } from "../../../components/ds";
import { updateAccountAction } from "./actions";
import {
  ACCOUNT_SAVE_ERROR,
  EMAIL_SUPPORT_HELPER,
  ORG_NAME_ERROR,
  PHONE_ERROR,
  SAVED_CONFIRMATION,
} from "./messages";

/**
 * Account edit form (PROF-4) — a payer changes their OWN org name + contact phone.
 *
 * Calls {@link updateAccountAction} (→ payer-authed `PATCH /payer/me`); it never sees a
 * secret or a session token (the seam carries the JWT server-side from the httpOnly cookie).
 *
 * PHONE "CHANGE" FLOW: `GET /payer/me` returns ONLY the masked last-4 — the full number is
 * never sent to the client (invariant #2). So this form CANNOT pre-fill the phone. Instead it
 * SHOWS the current masked value read-only ("Current: •••• 1234" / "Not set") and offers a
 * SEPARATE, blank input for a NEW full number. Blank = no phone change; a non-empty value is
 * validated with `e164PhoneSchema` (parity with the backend) and sent as the new `phone`.
 *
 * EMAIL is the login identity — READ-ONLY (mono), with a "contact support" helper. There is
 * NO email input. Role/status are read-only DS Badges (display only, never an authz decision).
 *
 * NO-ORACLE / PRIVACY: the body is built from CHANGED fields only (Save is disabled while
 * pristine, so an empty body is never sent); any failure shows ONE neutral Toast — no
 * field-level oracle. Values are never placed in the URL / storage / analytics, never logged.
 */

type Role = "employer" | "agent";
type Status = "pending" | "active" | "suspended";

const ROLE_LABEL: Record<Role, string> = { employer: "Employer", agent: "Agency" };
const STATUS_TONE: Record<Status, "success" | "warning" | "danger"> = {
  active: "success",
  pending: "warning",
  suspended: "danger",
};
const STATUS_LABEL: Record<Status, string> = {
  active: "Active",
  pending: "Pending",
  suspended: "Suspended",
};

export interface AccountFormProps {
  /** The payer's current org name (pre-fills the editable org field). */
  orgName: string;
  /** The payer's login email — READ-ONLY (shown in mono; no input). */
  email: string;
  /** Last 4 of the current phone, or null if none on file. */
  phoneLast4: string | null;
  role: Role;
  status: Status;
}

interface FieldErrors {
  orgName?: string;
  phone?: string;
}

/** Grapheme/code-point length parity with the backend org-name rule (2..120). */
function orgNameValid(value: string): boolean {
  const len = [...value.trim()].length;
  return len >= 2 && len <= 120;
}

export function AccountForm({ orgName, email, phoneLast4, role, status }: AccountFormProps) {
  const router = useRouter();
  // useState order (mirrored by account-form.test.tsx): orgValue, phoneValue, fieldErrors,
  // error, saved.
  const [orgValue, setOrgValue] = useState(orgName);
  const [phoneValue, setPhoneValue] = useState("");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();

  // What the user actually changed. Org is dirty when its trimmed value differs from the
  // current; phone is dirty when a NON-EMPTY new value was typed (blank = no change).
  const orgChanged = orgValue.trim() !== orgName.trim();
  const phoneChanged = phoneValue.trim() !== "";
  const isDirty = orgChanged || phoneChanged;

  function validate(): FieldErrors {
    const errs: FieldErrors = {};
    // Org is only validated when it changed (an unchanged, valid current value passes through).
    if (orgChanged && !orgNameValid(orgValue)) errs.orgName = ORG_NAME_ERROR;
    // Phone is only validated when a new value was entered (blank = no change, no error).
    if (phoneChanged && !e164PhoneSchema.safeParse(phoneValue).success) errs.phone = PHONE_ERROR;
    return errs;
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);

    // Pristine guard (the button is also disabled): never send an empty body.
    if (!isDirty) return;

    const errs = validate();
    setFieldErrors(errs);
    if (Object.keys(errs).length > 0) {
      // A11y: move focus to the first invalid field.
      const firstInvalid = errs.orgName ? "account-org" : "account-phone";
      document.getElementById(firstInvalid)?.focus();
      return;
    }

    // Build the PATCH body from CHANGED fields only — never payer_id/email/role/status.
    const payload: { orgName?: string; phone?: string } = {};
    if (orgChanged) payload.orgName = orgValue.trim();
    if (phoneChanged) payload.phone = phoneValue.trim();

    startTransition(async () => {
      const res = await updateAccountAction(payload);
      if (res.ok) {
        setSaved(true);
        // Clear the one-shot new-phone input so it reflects "no pending change" post-save.
        setPhoneValue("");
        // Re-render the shell account-menu + /account with the new values (server-held).
        router.refresh();
      } else {
        setError(res.error);
      }
    });
  }

  const orgErrorId = fieldErrors.orgName ? "account-org-error" : undefined;
  const phoneErrorId = fieldErrors.phone ? "account-phone-error" : undefined;
  const currentPhone = phoneLast4 ? `•••• ${phoneLast4}` : "Not set";
  const saveDisabled = pending || !isDirty;

  return (
    <Card as="form" className="account-form" onSubmit={onSubmit}>
      <Input
        id="account-org"
        label="Organisation name"
        value={orgValue}
        error={fieldErrors.orgName}
        aria-invalid={fieldErrors.orgName ? true : undefined}
        aria-describedby={orgErrorId}
        autoComplete="organization"
        onChange={(e) => {
          setOrgValue(e.target.value);
          setSaved(false);
          if (fieldErrors.orgName) setFieldErrors((p) => ({ ...p, orgName: undefined }));
        }}
      />

      <div className="account-form__phone">
        <p className="account-form__current">
          <span className="account-form__current-label">Current phone</span>
          <span className="bb-mono account-form__current-value">{currentPhone}</span>
        </p>
        <Input
          id="account-phone"
          label="New phone"
          optional
          type="tel"
          inputMode="tel"
          placeholder="+91…"
          value={phoneValue}
          error={fieldErrors.phone}
          aria-invalid={fieldErrors.phone ? true : undefined}
          aria-describedby={phoneErrorId}
          autoComplete="tel"
          hint="Leave blank to keep your current number. Enter a full number to change it."
          onChange={(e) => {
            setPhoneValue(e.target.value);
            setSaved(false);
            if (fieldErrors.phone) setFieldErrors((p) => ({ ...p, phone: undefined }));
          }}
        />
      </div>

      <div className="account-form__email">
        <span className="account-form__email-label">Account email</span>
        <span className="bb-mono account-form__email-value">{email}</span>
        <span className="account-form__email-help">{EMAIL_SUPPORT_HELPER}</span>
      </div>

      <div className="account-form__meta">
        <Badge tone="brand" upper>
          {ROLE_LABEL[role]}
        </Badge>
        <Badge tone={STATUS_TONE[status]} upper>
          {STATUS_LABEL[status]}
        </Badge>
      </div>

      <div className="account-form__actions">
        <Button type="submit" iconLeft="floppy-disk" disabled={saveDisabled} loading={pending}>
          {pending ? "Saving…" : "Save changes"}
        </Button>
      </div>

      <div aria-live="polite" className="account-form__status">
        {saved ? <span className="account-form__saved">{SAVED_CONFIRMATION}</span> : null}
        {error ? (
          <Toast tone="danger" title="Couldn’t save">
            {ACCOUNT_SAVE_ERROR}
          </Toast>
        ) : null}
      </div>
    </Card>
  );
}
