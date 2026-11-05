"use client";

import { useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ACTION_ICON, Icon } from "@badabhai/icons";
import { confirmMfaAction, disableMfaAction, enableMfaAction } from "./actions";
import { AuthenticatorEnrollment } from "../../../components/authenticator-enrollment";
import { AdminActionResultBanner } from "../../../components/admin-action-result-banner";
import { FieldError, FormSummary, useFormValidation } from "../../../components/form-feedback";
import type { AdminActionOutcome } from "../../../lib/admin-action-result";

/**
 * Two-step verification (MFA) on/off for your own account (ADR-0060 A2 — owner amendment
 * 2026-11-03: optional, per admin, starts off).
 *
 * THE SWITCH SHOWS THE SERVER'S STATE, never the state being asked for. Flipping it starts a
 * step rather than changing anything:
 *   - off → on: the server mints a fresh secret, the QR code appears, and only a valid code from
 *     it turns verification on (`/admin/me/mfa/enable`, then `/confirm`);
 *   - on → off: a valid CURRENT code is required (`/admin/me/mfa/disable`) — proof the operator
 *     still holds the authenticator, not merely an unattended signed-in browser.
 * Either way the page then refreshes from the server, so `aria-checked` only ever moves when the
 * server says it did.
 */
type Mode = "idle" | "enrolling" | "disabling";

export function MfaPanel({ enabled }: { enabled: boolean }) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("idle");
  const [enrollment, setEnrollment] = useState<{ secret: string; otpauthUri: string } | null>(
    null,
  );
  const [code, setCode] = useState("");
  const [outcome, setOutcome] = useState<AdminActionOutcome | null>(null);
  const [pending, startTransition] = useTransition();
  const ids = useId();
  const validation = useFormValidation({
    order: ["code"] as const,
    fieldId: () => `${ids}-code`,
    focus: () => {
      if (typeof document !== "undefined") document.getElementById(`${ids}-code`)?.focus();
    },
    validate: () => {
      if (code.length === 6) return {};
      return { code: "Enter the 6-digit code from your authenticator app." };
    },
  });

  function cancel() {
    setMode("idle");
    // The un-confirmed secret is dropped with the step: nothing of it outlives the screen.
    setEnrollment(null);
    setCode("");
  }

  function flip() {
    if (pending || mode !== "idle") return;
    setOutcome(null);
    if (enabled) {
      setCode("");
      setMode("disabling");
      return;
    }
    startTransition(async () => {
      const res = await enableMfaAction();
      if (!res.ok) {
        setOutcome({ ok: false, error: res.error });
        // A 409 means it is already on (another tab, another device): show the server's truth.
        router.refresh();
        return;
      }
      setEnrollment(res.enrollment);
      setCode("");
      setMode("enrolling");
    });
  }

  function submitCode() {
    if (pending || code.length !== 6) return;
    setOutcome(null);
    const turningOn = mode === "enrolling";
    startTransition(async () => {
      const result = turningOn
        ? await confirmMfaAction({ code })
        : await disableMfaAction({ code });
      setOutcome(result);
      if (result.ok) {
        cancel();
        validation.reset();
        router.refresh();
      } else {
        setCode("");
      }
    });
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (validation.submit() !== null) return;
    submitCode();
  }

  const labelId = `${ids}-label`;
  const stateId = `${ids}-state`;
  const turningOn = mode === "enrolling";

  return (
    <section className="panel" aria-labelledby={`${ids}-title`}>
      <div className="panel__head">
        <h2 className="panel__title" id={`${ids}-title`}>
          Two-step verification
        </h2>
        <p className="panel__sub">
          Off: you sign in with your email and password only. On: after your password you also
          enter a 6-digit code from an authenticator app (MFA), and can trust a device for 30
          days to skip it.
        </p>
      </div>

      <div className="switch-row">
        <span className="switch-row__label" id={labelId}>
          Two-step verification
        </span>
        <button
          type="button"
          role="switch"
          className="switch"
          aria-checked={enabled}
          aria-labelledby={labelId}
          aria-describedby={stateId}
          onClick={flip}
          disabled={pending || mode !== "idle"}
        >
          <span className="switch__thumb" aria-hidden="true" />
        </button>
        <span className="switch-row__state" id={stateId}>
          {pending && mode === "idle" ? "Working…" : enabled ? "On" : "Off"}
        </span>
      </div>

      {!enabled && mode === "idle" ? (
        <p className="field__help">
          Recommended for every admin, and especially for super admins: with it off, your
          password alone opens this console.
        </p>
      ) : null}

      {mode !== "idle" ? (
        <form className={validation.shaking ? "form form--shake" : "form"} onSubmit={submit} noValidate aria-busy={pending}>
          <FormSummary errors={validation.visible} />
          {turningOn && enrollment ? (
            <>
              <p className="field__help">
                Scan this once with your authenticator app, then enter the 6-digit code it shows
                to turn two-step verification on.
              </p>
              <AuthenticatorEnrollment
                secret={enrollment.secret}
                otpauthUri={enrollment.otpauthUri}
              />
            </>
          ) : (
            <p className="field__help">
              Enter the code your authenticator app shows now. Turning this off also stops any
              trusted device from counting.
            </p>
          )}
          <label className="field">
            <span className="field__label">Authenticator code</span>
            <input
              id={`${ids}-code`}
              className="field__input field__input--code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="\d{6}"
              maxLength={6}
              required
              autoFocus
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
              onBlur={() => validation.onBlur("code")}
              aria-invalid={validation.errors.code ? true : undefined}
              aria-describedby={
                validation.errors.code ? `${ids}-code-error` : undefined
              }
              disabled={pending}
            />
            <FieldError id={`${ids}-code-error`}>{validation.errors.code}</FieldError>
          </label>
          <div className="form-actions">
            <button
              className={`btn ${turningOn ? "btn--primary" : "btn--danger"}`}
              type="submit"
              disabled={pending}
            >
              <Icon name={turningOn ? "shield-check" : ACTION_ICON.suspend} />
              {pending
                ? "Working…"
                : turningOn
                  ? "Turn on two-step verification"
                  : "Turn off two-step verification"}
            </button>
            <button className="btn btn--ghost" type="button" onClick={cancel} disabled={pending}>
              <Icon name={ACTION_ICON.close} />
              Cancel
            </button>
          </div>
        </form>
      ) : null}

      {outcome ? (
        <AdminActionResultBanner
          outcome={outcome}
          eventsLink={null}
          onRetry={() => (mode === "idle" ? flip() : submitCode())}
        />
      ) : null}
    </section>
  );
}
