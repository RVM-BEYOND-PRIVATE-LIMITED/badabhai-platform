"use server";

import { requirePayer } from "../../../../lib/auth";
import {
  createManagedHiringOrder,
  requestManagedHiringCallback,
  type ManagedHiringCheckout,
} from "../../../../lib/managed-hiring";

export type ManagedHiringActionResult =
  | { ok: true; checkout: ManagedHiringCheckout }
  | { ok: false; error: string; callback?: false };

export type CallbackActionResult =
  | { ok: true; requestId: string; created: boolean }
  | { ok: false; error: string };

export async function buyManagedHiringAction(input: {
  jobPostingId: string;
  expectedPriceInr: number;
  idempotencyKey: string;
}): Promise<ManagedHiringActionResult> {
  await requirePayer();
  try {
    return {
      ok: true,
      checkout: await createManagedHiringOrder(input),
    };
  } catch {
    return {
      ok: false,
      error: "Managed Hiring checkout could not be prepared. Re-read the quote and retry.",
    };
  }
}

export async function requestCallbackAction(jobPostingId: string): Promise<CallbackActionResult> {
  await requirePayer();
  try {
    const res = await requestManagedHiringCallback(jobPostingId);
    return { ok: true, requestId: res.request_id, created: res.created };
  } catch {
    return { ok: false, error: "Could not request a call right now. Please retry." };
  }
}
