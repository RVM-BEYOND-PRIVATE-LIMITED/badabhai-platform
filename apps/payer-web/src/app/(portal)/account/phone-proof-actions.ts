"use server";

import { z } from "zod";
import { requestPhoneProof, verifyPhoneProof } from "../../../lib/payer-api";
import { isPayerStatus, PayerConflictError } from "../../../lib/payer-errors";
import { isPayerUnauthorized } from "../../../lib/payer-http";
import {
  PHONE_PROOF_IN_FLIGHT,
  PHONE_PROOF_LINKED_ELSEWHERE,
  PHONE_PROOF_NO_PHONE,
  PHONE_PROOF_NOT_PROVABLE,
  PHONE_PROOF_PHONE_CHANGED,
  PHONE_PROOF_RATE_LIMITED,
  PHONE_PROOF_SMS_FAILED,
  PHONE_PROOF_UNAVAILABLE,
  PHONE_PROOF_WRONG_CODE,
} from "./messages";

/**
 * "Confirm your number" Server Actions (#2754 item 3) — the signed-in company proves its phone.
 *
 * Both run SERVER-SIDE only: the session JWT is read from the httpOnly cookie inside
 * {@link payerFetch}; the full phone number is never sent to the client, and the code is never
 * logged or echoed back. The API's own text is never surfaced — every refusal maps to the app's
 * copy, one message per machine-readable reason/status.
 */

const CODE = z.string().trim().regex(/^\d{4,8}$/);
const IDEMPOTENCY_KEY = z.string().min(8).max(200);

export type PhoneProofFailureReason =
  | "no_phone_on_account"
  | "phone_not_provable"
  | "wrong_code"
  | "phone_changed"
  | "phone_linked_to_another_account"
  | "in_flight"
  | "rate_limited"
  | "sms_failed"
  | "unavailable";

export type RequestPhoneProofResult =
  | { ok: true; resendInSeconds: number }
  | { ok: false; error: string; reason: PhoneProofFailureReason };

export type VerifyPhoneProofResult =
  | { ok: true }
  | { ok: false; error: string; reason: PhoneProofFailureReason };

export async function requestPhoneProofAction(): Promise<RequestPhoneProofResult> {
  try {
    const res = await requestPhoneProof();
    return { ok: true, resendInSeconds: res.resendInSeconds };
  } catch (e) {
    const reason = requestFailureReason(e);
    return { ok: false, error: requestFailureCopy(reason), reason };
  }
}

export async function verifyPhoneProofAction(input: {
  code: string;
  idempotencyKey: string;
}): Promise<VerifyPhoneProofResult> {
  const code = CODE.safeParse(input.code);
  if (!code.success) return { ok: false, error: PHONE_PROOF_WRONG_CODE, reason: "wrong_code" };
  const key = IDEMPOTENCY_KEY.safeParse(input.idempotencyKey);
  if (!key.success) return { ok: false, error: PHONE_PROOF_UNAVAILABLE, reason: "unavailable" };

  try {
    await verifyPhoneProof({ code: code.data, idempotencyKey: key.data });
    return { ok: true };
  } catch (e) {
    const reason = verifyFailureReason(e);
    return { ok: false, error: verifyFailureCopy(reason), reason };
  }
}

/** The machine-readable `reason` on a 409, or null when the answer carries none. */
function conflictReason(e: unknown): string | null {
  return e instanceof PayerConflictError ? e.reason : null;
}

/**
 * `POST /payer/me/phone-proof` refusals: the two 409 reasons, the send/attempt cap (429), the
 * provider failure (502), and 503/other. A 404 means the switch went off mid-flow — the generic
 * unavailable copy, never an invitation to retry forever.
 */
function requestFailureReason(e: unknown): PhoneProofFailureReason {
  const reason = conflictReason(e);
  if (reason === "no_phone_on_account" || reason === "phone_not_provable") return reason;
  if (isPayerStatus(e, 429)) return "rate_limited";
  if (isPayerStatus(e, 502)) return "sms_failed";
  return "unavailable";
}

function requestFailureCopy(reason: PhoneProofFailureReason): string {
  switch (reason) {
    case "no_phone_on_account":
      return PHONE_PROOF_NO_PHONE;
    case "phone_not_provable":
      return PHONE_PROOF_NOT_PROVABLE;
    case "rate_limited":
      return PHONE_PROOF_RATE_LIMITED;
    case "sms_failed":
      return PHONE_PROOF_SMS_FAILED;
    default:
      return PHONE_PROOF_UNAVAILABLE;
  }
}

/**
 * `POST /payer/me/phone-proof/verify` refusals. The transport raises a 401 as its session-expiry
 * class, so both that and a typed 401 mean "wrong or expired code" here. A retry with the SAME
 * idempotency key replays the first answer; `in_flight` says the first is still running.
 */
function verifyFailureReason(e: unknown): PhoneProofFailureReason {
  if (isPayerUnauthorized(e) || isPayerStatus(e, 401)) return "wrong_code";
  const reason = conflictReason(e);
  if (
    reason === "phone_changed" ||
    reason === "phone_linked_to_another_account" ||
    reason === "in_flight"
  ) {
    return reason;
  }
  if (isPayerStatus(e, 429)) return "rate_limited";
  if (isPayerStatus(e, 502)) return "sms_failed";
  return "unavailable";
}

function verifyFailureCopy(reason: PhoneProofFailureReason): string {
  switch (reason) {
    case "wrong_code":
      return PHONE_PROOF_WRONG_CODE;
    case "phone_changed":
      return PHONE_PROOF_PHONE_CHANGED;
    case "phone_linked_to_another_account":
      return PHONE_PROOF_LINKED_ELSEWHERE;
    case "in_flight":
      return PHONE_PROOF_IN_FLIGHT;
    case "rate_limited":
      return PHONE_PROOF_RATE_LIMITED;
    case "sms_failed":
      return PHONE_PROOF_SMS_FAILED;
    default:
      return PHONE_PROOF_UNAVAILABLE;
  }
}
