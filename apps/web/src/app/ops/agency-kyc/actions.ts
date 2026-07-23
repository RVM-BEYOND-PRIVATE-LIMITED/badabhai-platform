"use server";

import { revalidatePath } from "next/cache";
import {
  verifyAgencyKyc,
  rejectAgencyKyc,
  type AgencyKycRejectReason,
} from "@/lib/api";
import { isRejectReason } from "@/lib/agency-kyc-view";

/**
 * Server Actions for the ops Agency-KYC review screen (ADR-0022 Amendment 2).
 *
 * SECURITY: both endpoints are behind the API's `InternalServiceGuard`. The shared
 * `INTERNAL_SERVICE_TOKEN` is attached server-side by `apiPostInternal` (read from
 * `process.env`, NEVER `NEXT_PUBLIC_*`). These actions run ONLY on the server
 * (`"use server"`), so the secret never reaches the browser bundle. If the token is
 * unset the guard fails closed (401) and the action returns its honest error state.
 *
 * NO-LOG: nothing here logs the payerId, the reason, the action result, or the raw
 * API error.
 */

/** Result handed to the client — a change flag + a human message, or an error. */
export type AgencyKycActionState =
  | { ok: true; changed: boolean; message: string }
  | { ok: false; error: string };

const REVIEW_PATH = "/ops/agency-kyc";

/**
 * Verify a pending agency's KYC (flip to `verified`). `changed: false` means the
 * API reported a no-op (not pending / already actioned) — surfaced as an honest,
 * non-error state.
 */
export async function verifyAgencyKycAction(
  payerId: string,
): Promise<AgencyKycActionState> {
  const id = payerId.trim();
  if (!id) {
    return { ok: false, error: "Missing payer id." };
  }
  try {
    const { ok } = await verifyAgencyKyc(id);
    if (ok) {
      revalidatePath(REVIEW_PATH);
      return { ok: true, changed: true, message: "Agency KYC verified." };
    }
    return {
      ok: true,
      changed: false,
      message: "No change — not pending or already actioned.",
    };
  } catch {
    // Generic honest message — covers a missing token (401) or a backend outage.
    // Nothing logged.
    return {
      ok: false,
      error: "Verify failed (backend unavailable or service token).",
    };
  }
}

/**
 * Reject a pending agency's KYC with a bounded reason. An out-of-vocabulary reason
 * is refused client-side before any call. `changed: false` = a no-op (not pending /
 * already actioned).
 */
export async function rejectAgencyKycAction(
  payerId: string,
  reason: AgencyKycRejectReason,
): Promise<AgencyKycActionState> {
  const id = payerId.trim();
  if (!id) {
    return { ok: false, error: "Missing payer id." };
  }
  if (!isRejectReason(reason)) {
    return { ok: false, error: "Pick a valid reject reason." };
  }
  try {
    const { ok } = await rejectAgencyKyc(id, reason);
    if (ok) {
      revalidatePath(REVIEW_PATH);
      return { ok: true, changed: true, message: "Agency KYC rejected." };
    }
    return {
      ok: true,
      changed: false,
      message: "No change — not pending or already actioned.",
    };
  } catch {
    return {
      ok: false,
      error: "Reject failed (backend unavailable or service token).",
    };
  }
}
