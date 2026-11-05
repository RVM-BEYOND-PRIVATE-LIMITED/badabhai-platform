"use client";

import { useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@badabhai/icons";
import { setOwnPasswordAction } from "./actions";
import { PasswordInput } from "../../../components/password-input";
import { NewPasswordFields } from "../../../components/new-password-fields";
import { AdminActionResultBanner } from "../../../components/admin-action-result-banner";
import { newPasswordPairReady } from "../../../lib/password-policy";
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

  function submit(e: React.FormEvent) {
    e.preventDefault();
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
        router.refresh();
      }
    });
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
      <form className="form" onSubmit={submit} noValidate aria-busy={pending}>
        {hasPassword ? (
          <PasswordInput
            id={`${ids}-current`}
            label="Current password"
            value={current}
            onChange={setCurrent}
            autoComplete="current-password"
            disabled={pending}
          />
        ) : null}
        <NewPasswordFields
          value={next}
          confirm={confirm}
          onChange={setNext}
          onConfirmChange={setConfirm}
          disabled={pending}
        />
        <div className="form-actions">
          <button className="btn btn--primary" type="submit" disabled={pending || !ready}>
            <Icon name="lock-key" />
            {pending ? "Saving…" : title}
          </button>
        </div>
      </form>
      {outcome ? <AdminActionResultBanner outcome={outcome} eventsLink={null} /> : null}
    </section>
  );
}
