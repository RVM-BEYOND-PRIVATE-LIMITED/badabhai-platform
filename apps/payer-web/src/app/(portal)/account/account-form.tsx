"use client";

import { useState, useTransition } from "react";
import type { FormEvent } from "react";
import { useRouter } from "next/navigation";
import { e164PhoneSchema } from "@badabhai/validators";
import { Button, Input, Toast } from "../../../components/ds";
import { updateAccountAction } from "./actions";
import { ACCOUNT_SAVE_ERROR, ORG_NAME_ERROR, PHONE_ERROR, SAVED_CONFIRMATION } from "./messages";

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
 * EMAIL is the login identity — READ-ONLY, so it is NOT here: there is no email input, and the
 * page's "Signed in as" panel shows it (mono) with the "contact support" helper, beside the
 * read-only role/status. The form holds ONLY what can be edited, so Save follows the fields
 * directly (F22 — a read-only block between the fields and Save put it at y=1,046 on an 800px
 * screen).
 *
 * NO-ORACLE / PRIVACY: the body is built from CHANGED fields only (Save is disabled while
 * pristine, so an empty body is never sent); any failure shows ONE neutral Toast — no
 * field-level oracle. Values are never placed in the URL / storage / analytics, never logged.
 *
 * UI-1: the form is the shared `form` spine (form__section / form__legend / form-actions /
 * form-status) and no longer carries its own card surface — the PAGE wraps it in a `panel`,
 * so /account and /profile stay one visual system. The current phone is a read-only `kv` row
 * beside the field that changes it.
 */

export interface AccountFormProps {
  /** The payer's current org name (pre-fills the editable org field). */
  orgName: string;
  /** Last 4 of the current phone, or null if none on file. */
  phoneLast4: string | null;
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

export function AccountForm({ orgName, phoneLast4 }: AccountFormProps) {
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

  const currentPhone = phoneLast4 ? `•••• ${phoneLast4}` : "Not set";
  const saveDisabled = pending || !isDirty;

  return (
    <form className="form" onSubmit={onSubmit}>
      <div className="form__section">
        <p className="form__legend">Organisation</p>
        <Input
          id="account-org"
          label="Organisation name"
          value={orgValue}
          error={fieldErrors.orgName}
          aria-invalid={fieldErrors.orgName ? true : undefined}
          autoComplete="organization"
          onChange={(e) => {
            setOrgValue(e.target.value);
            setSaved(false);
            if (fieldErrors.orgName) setFieldErrors((p) => ({ ...p, orgName: undefined }));
          }}
        />
      </div>

      <div className="form__section">
        <p className="form__legend">Contact phone</p>
        {/* The full number is never sent to the client — only the last 4. So the current
            value is a READ-ONLY kv row and the input below is a separate, blank NEW value. */}
        <dl className="kv">
          <dt className="kv__k">Current phone</dt>
          <dd className="kv__v bb-mono">{currentPhone}</dd>
        </dl>
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
          autoComplete="tel"
          hint="Leave blank to keep your current number. Enter a full number to change it."
          onChange={(e) => {
            setPhoneValue(e.target.value);
            setSaved(false);
            if (fieldErrors.phone) setFieldErrors((p) => ({ ...p, phone: undefined }));
          }}
        />
      </div>

      <div className="form-actions">
        <Button type="submit" iconLeft="floppy-disk" disabled={saveDisabled} loading={pending}>
          {pending ? "Saving…" : "Save changes"}
        </Button>
      </div>

      <div aria-live="polite" className="form-status">
        {saved ? (
          <div className="alert alert--success">
            <i className="ph-fill ph-check-circle alert__icon" aria-hidden="true" />
            <div className="alert__text">
              <p className="alert__body">{SAVED_CONFIRMATION}</p>
            </div>
          </div>
        ) : null}
        {error ? (
          <Toast tone="danger" title="Couldn’t save">
            {ACCOUNT_SAVE_ERROR}
          </Toast>
        ) : null}
      </div>
    </form>
  );
}
