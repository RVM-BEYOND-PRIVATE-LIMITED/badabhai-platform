"use client";

import { useEffect, useState, useTransition } from "react";
import { Badge, Button, Input, Toast } from "../../../components/ds";
import { maskLast4 } from "../../../lib/masking";
import { requestPhoneProofAction, verifyPhoneProofAction } from "./phone-proof-actions";
import type { PhoneProofFailureReason } from "./phone-proof-actions";
import {
  PHONE_PROOF_CODE_ERROR,
  PHONE_PROOF_CODE_HELPER,
  PHONE_PROOF_CONFIRMED,
  PHONE_PROOF_PROMPT,
  PHONE_PROOF_VERIFIED,
} from "./messages";

/**
 * "Confirm your number" (#2754 item 3) — the signed-in company proves its phone so it can sign
 * in by SMS code. Rendered beside the contact-phone field only when `GET /payer/me/phone-proof`
 * answered (a 404 hides it entirely: the switch is off).
 *
 * PRIVACY: the full number never reaches this component and the code is never logged or shown
 * back. The confirmation line uses the masked last-4 the account page already displays.
 *
 * IDEMPOTENCY: one key is minted per verify attempt and reused on a retry of that attempt (the
 * code is single-use, so a lost success response must replay `proven`, not answer 401). A new
 * attempt — a different code, a resend, or a refusal that requires a new code — mints a new key.
 */

export interface PhoneProofPromptProps {
  /** The server's `GET /payer/me/phone-proof` answer. */
  proven: boolean;
  /** Last 4 of the number on file, or null when there is none. */
  phoneLast4: string | null;
}

type Step = "idle" | "sent";

/** A random UUID for `Idempotency-Key` (PII-free; one per verify attempt). */
function mintAttemptKey(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `phone-proof-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function PhoneProofPrompt({ proven, phoneLast4 }: PhoneProofPromptProps) {
  const [step, setStep] = useState<Step>("idle");
  const [code, setCode] = useState("");
  const [cooldown, setCooldown] = useState(0);
  const [codeError, setCodeError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [provenNow, setProvenNow] = useState(false);
  const [attemptKey, setAttemptKey] = useState<string | null>(null);
  const [attemptCode, setAttemptCode] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // Tick the resend cooldown down to zero (the server owns the actual cooldown).
  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((s) => Math.max(0, s - 1)), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  const confirmed = proven || provenNow;

  function forgetAttempt() {
    setAttemptKey(null);
    setAttemptCode(null);
  }

  function requestCode() {
    if (pending) return;
    setError(null);
    startTransition(async () => {
      const res = await requestPhoneProofAction();
      if (res.ok) {
        setStep("sent");
        setCooldown(res.resendInSeconds);
        setCode("");
        setCodeError(null);
        forgetAttempt();
      } else {
        setError(res.error);
      }
    });
  }

  function resend() {
    if (pending || cooldown > 0) return;
    requestCode();
  }

  function verify() {
    if (pending) return;
    const submitted = code.trim();
    if (!/^\d{4,8}$/.test(submitted)) {
      setCodeError(PHONE_PROOF_CODE_ERROR);
      return;
    }
    setCodeError(null);
    setError(null);

    // Reuse the key only for a retry of the SAME code; anything else is a new attempt.
    const key = attemptKey && attemptCode === submitted ? attemptKey : mintAttemptKey();
    setAttemptKey(key);
    setAttemptCode(submitted);

    startTransition(async () => {
      const res = await verifyPhoneProofAction({ code: submitted, idempotencyKey: key });
      if (res.ok) {
        setProvenNow(true);
        setError(null);
        return;
      }
      setError(res.error);
      handleRetryState(res.reason);
    });
  }

  /**
   * Keep the SAME key only when replaying it is what rescues the attempt (a lost answer, or a
   * duplicate still in flight). A 429 or a moved phone needs a fresh attempt: reset the key, and
   * for a moved phone return to the prompt so a new code is requested.
   */
  function handleRetryState(reason: PhoneProofFailureReason) {
    if (reason === "in_flight" || reason === "sms_failed" || reason === "unavailable") return;
    forgetAttempt();
    if (reason === "phone_changed") {
      setStep("idle");
      setCode("");
      setCooldown(0);
    }
  }

  if (confirmed) {
    return (
      <div className="form__section">
        <p className="form__legend">SMS sign-in</p>
        <p>
          <Badge tone="success" upper>
            Confirmed
          </Badge>{" "}
          <span className="bb-mono">{maskLast4(phoneLast4)}</span>{" "}
          <span>{PHONE_PROOF_CONFIRMED}</span>
        </p>
        <div aria-live="polite" className="form-status">
          {provenNow ? <Toast tone="success">{PHONE_PROOF_VERIFIED}</Toast> : null}
        </div>
      </div>
    );
  }

  return (
    <div className="form__section">
      <p className="form__legend">SMS sign-in</p>
      {step === "idle" ? (
        <>
          <p className="form__hint">{PHONE_PROOF_PROMPT}</p>
          <Button
            type="button"
            variant="secondary"
            iconLeft="shield-check"
            loading={pending}
            disabled={pending}
            onClick={requestCode}
          >
            Confirm your number
          </Button>
        </>
      ) : (
        <>
          <p className="form__hint">{PHONE_PROOF_CODE_HELPER}</p>
          <Input
            id="phone-proof-code"
            label="Confirmation code"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={8}
            value={code}
            error={codeError ?? undefined}
            aria-invalid={codeError ? true : undefined}
            onChange={(e) => {
              setCode(e.target.value.replace(/\D/g, ""));
              if (codeError) setCodeError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                verify();
              }
            }}
          />
          <div className="form-actions">
            <Button
              type="button"
              variant="primary"
              loading={pending}
              disabled={pending}
              onClick={verify}
            >
              Confirm number
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={pending || cooldown > 0}
              onClick={resend}
              iconLeft="arrow-clockwise"
            >
              {cooldown > 0 ? `Resend code (${cooldown}s)` : "Resend code"}
            </Button>
          </div>
        </>
      )}
      <div aria-live="polite" className="form-status">
        {error ? (
          <Toast tone="danger" title="Couldn’t confirm">
            {error}
          </Toast>
        ) : null}
      </div>
    </div>
  );
}
