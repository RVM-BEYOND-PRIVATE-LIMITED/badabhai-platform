"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  campusDriveCreateInputSchema,
  type CampusDriveRequest,
} from "../../../lib/contracts";
import {
  cancelCampusDriveRequest,
  createCampusDriveRequest,
} from "../../../lib/payer-api";
import {
  isPayerForbiddenError,
  isPayerStatus,
  PayerBadRequestError,
  PayerConflictError,
} from "../../../lib/payer-errors";

/**
 * #2746 / #2813 — campus-drive Server Actions. Tenancy is the SERVER session (XB-A): the client
 * never sends a company id. The `Idempotency-Key` is minted by the FORM once per submission and
 * reused on every retry, so a timed-out tap cannot create two requests.
 *
 * Errors are returned as the API's closed `reason` token (plus the `missing` steps for a
 * `company_not_verified` 403) and mapped to words by the form. The server's own message and any
 * contact/roles note are never returned.
 */

export type CreateCampusDriveResult =
  | { ok: true; request: CampusDriveRequest }
  | {
      ok: false;
      reason: string;
      missing?: string[];
      limit?: number;
      open?: number;
    };

export async function createCampusDriveAction(input: {
  jobPostingId?: string;
  branchIds: number[];
  preferredFrom: string;
  preferredTo: string;
  openings: number;
  rolesNote?: string;
  contactName: string;
  contactPhone: string;
  idempotencyKey: string;
}): Promise<CreateCampusDriveResult> {
  const parsed = campusDriveCreateInputSchema.safeParse({
    jobPostingId: input.jobPostingId,
    branchIds: input.branchIds,
    preferredFrom: input.preferredFrom,
    preferredTo: input.preferredTo,
    openings: input.openings,
    rolesNote: input.rolesNote,
    contactName: input.contactName,
    contactPhone: input.contactPhone,
  });
  if (!parsed.success) {
    return { ok: false, reason: "validation_failed" };
  }
  if (!z.string().min(8).max(200).regex(/^[A-Za-z0-9._:-]+$/).safeParse(input.idempotencyKey).success) {
    return { ok: false, reason: "idempotency_key_required" };
  }
  try {
    const request = await createCampusDriveRequest(parsed.data, input.idempotencyKey);
    revalidatePath("/campus-drives");
    return { ok: true, request };
  } catch (e) {
    if (isPayerForbiddenError(e)) {
      return {
        ok: false,
        reason: e.reason ?? "forbidden",
        ...(e.missing.length > 0 ? { missing: [...e.missing] } : {}),
      };
    }
    if (e instanceof PayerBadRequestError) {
      return { ok: false, reason: e.reason };
    }
    if (e instanceof PayerConflictError) {
      return { ok: false, reason: e.reason ?? "conflict" };
    }
    if (isPayerStatus(e, 404)) return { ok: false, reason: "unavailable" };
    return { ok: false, reason: "failed" };
  }
}

export type CancelCampusDriveResult =
  | { ok: true; request: CampusDriveRequest }
  | { ok: false; reason: string };

export async function cancelCampusDriveAction(id: string): Promise<CancelCampusDriveResult> {
  if (!z.string().uuid().safeParse(id).success) {
    return { ok: false, reason: "not_found" };
  }
  try {
    const request = await cancelCampusDriveRequest(id);
    if (!request) return { ok: false, reason: "not_found" };
    revalidatePath("/campus-drives");
    revalidatePath(`/campus-drives/${id}`);
    return { ok: true, request };
  } catch (e) {
    if (e instanceof PayerConflictError) {
      return { ok: false, reason: e.reason ?? "drive_request_not_cancellable" };
    }
    if (isPayerStatus(e, 404)) return { ok: false, reason: "not_found" };
    return { ok: false, reason: "failed" };
  }
}
