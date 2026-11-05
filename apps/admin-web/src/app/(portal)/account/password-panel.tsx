"use client";

import { useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@badabhai/icons";
import { setOwnPasswordAction } from "./actions";
import { PasswordInput } from "../../../components/password-input";
import { NewPasswordFields } from "../../../components/new-password-fields";
import { AdminActionResultBanner } from "../../../components/admin-action-result-banner";
import { FieldError, FormSummary, useFormValidation } from "../../../components/form-feedback";
import { passwordPolicyProblem, newPasswordPairReady } from "../../../lib/password-policy";
import type { AdminActionOutcome } from "../../../lib/admin-action-result";

/**
 * Set or change your own password (ADR-0060 A5).
 *
 * Two shapes from one flag the SERVER reports (`has_password` on `GET /admin/me`): with no
 * password yet — an invited admin who signs in by emailed code — it is "Set a password"
 * (new + confirm); with one, "Change password" adds the current password, which the API
 * requires and verifies.
 *
 * After a save the page refreshes from the server, so the panel becomes "Change password" on the
 * server's word rather than by assuming the save took. The fresh session the change returns was
 * already written into the cookie by the Server Action — nothing token-shaped comes back here.
 */
export function PasswordPanel({ hasPassword }: { hasPassword: boolean }) {
  const router = useRouter();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [outcome, setOutcome] = useState<AdminActionOutcome | null>(null);
  const [pending, startTransition] = useTransition();
  const ids = useId();

  const title = hasPassword ? "Change password" : "Set a password";
  const ready = newPasswordPairReady(next, confirm) && (!hasPassword || current !== "");
  const validation = useFormValidation({
    order: hasPassword ? (["current", "next", "confirm"] as const) : (["next", "confirm"] as const),
    fieldId: (field) =>
      field === "current"
        ? `${ids}-current`
        : field === "next"
          ? `${ids}-np-new`
          : `${ids}-np-confirm`,
    focus: (field) => {
      if (typeof document === "undefined") return;
      const byId = {
        current: `${ids}-current`,
        next: `${ids}-np-new`,
        confirm: `${ids}-np-confirm`,
      };
      document.getElementById(byId[field])?.focus();
    },
    validate: () => {
      const errors: Partial<Record<"current" | "next" | "confirm", string>> = {};
      if (hasPassword && current === "") errors.current = "Enter your current password.";
      const problem = passwordPolicyProblem(next);
      if (next !== "" && problem) errors.next = problem;
      if (confirm !== "" && confirm !== next) errors.confirm = "The two passwords don't match.";
      return errors;
    },
  });

  function save() {
    if (!ready || pending) return;
    setOutcome(null);
    startTransition(async () => {
      const result = await setOwnPasswordAction({
        currentPassword: hasPassword ? current : undefined,
        newPassword: next,
      });
      setOutcome(result);
      if (result.ok) {
        setCurrent("");
        setNext("");
        setConfirm("");
        validation.reset();
        router.refresh();
      }
    });
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (validation.submit() !== null) return;
    save();
  }

  return (
    <section className="panel" aria-labelledby={`${ids}-title`}>
      <div className="panel__head">
        <h2 className="panel__title" id={`${ids}-title`}>
          {title}
        </h2>
        <p className="panel__sub">
          {hasPassword
            ? "Changing it signs out every other session on your account."
            : "You sign in with an emailed code today. Set a password to sign in with your email and password instead."}
        </p>
      </div>
      <form className={validation.shaking ? "form form--shake" : "form"} onSubmit={submit} noValidate aria-busy={pending}>
        <FormSummary errors={validation.visible} />
        {hasPassword ? (
          <>
            <PasswordInput
              id={`${ids}-current`}
              label="Current password"
              value={current}
              onChange={setCurrent}
              autoComplete="current-password"
              onBlur={() => validation.onBlur("current")}
              invalid={Boolean(validation.errors.current)}
              describedBy={
                validation.errors.current ? `${ids}-current-error` : undefined
              }
              disabled={pending}
            />
            <FieldError id={`${ids}-current-error`}>{validation.errors.current}</FieldError>
          </>
        ) : null}
        <NewPasswordFields
          idPrefix={`${ids}-np`}
          value={next}
          confirm={confirm}
          onChange={setNext}
          onConfirmChange={setConfirm}
          onBlur={() => validation.onBlur("next")}
          onConfirmBlur={() => validation.onBlur("confirm")}
          disabled={pending}
        />
        <div className="form-actions">
          <button className="btn btn--primary" type="submit" disabled={pending}>
            <Icon name="lock-key" />
            {pending ? "Saving…" : title}
          </button>
        </div>
      </form>
      {outcome ? (
        <AdminActionResultBanner outcome={outcome} eventsLink={null} onRetry={save} />
      ) : null}
    </section>
  );
}
