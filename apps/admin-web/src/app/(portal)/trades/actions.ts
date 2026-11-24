"use server";

import { z } from "zod";
import { isAdminRequestError } from "../../../lib/admin-http";
import { describeAdminActionError } from "../../../lib/describe-admin-error";
import {
  setTradeRelease,
  type TradeReleaseRow,
} from "../../../lib/trade-release";

const updateSchema = z
  .object({
    roleKind: z.string().trim().min(1, "Choose a trade.").max(128),
    postingEnabled: z.boolean().optional(),
    formEnabled: z.boolean().optional(),
  })
  .refine(
    (value) => value.postingEnabled !== undefined || value.formEnabled !== undefined,
    "Choose what to change.",
  );

export type TradeReleaseActionResult =
  | { ok: true; row: TradeReleaseRow }
  | { ok: false; error: string };

/**
 * The server's own words for a REFUSAL are shown here, deliberately: an operator already signed
 * in and holding `manage_postings` is being told why this switch was not changed. A 5xx or a
 * transport failure is not a refusal to interpret, so it goes through the usual safe copy.
 */
function refusalMessage(err: unknown): string {
  if (isAdminRequestError(err) && err.status >= 400 && err.status < 500) return err.message;
  return describeAdminActionError(err);
}

export async function updateTradeReleaseAction(
  input: unknown,
): Promise<TradeReleaseActionResult> {
  const parsed = updateSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the change." };
  }
  try {
    const row = await setTradeRelease(parsed.data.roleKind, {
      ...(parsed.data.postingEnabled === undefined
        ? {}
        : { postingEnabled: parsed.data.postingEnabled }),
      ...(parsed.data.formEnabled === undefined
        ? {}
        : { formEnabled: parsed.data.formEnabled }),
    });
    return { ok: true, row };
  } catch (err) {
    return { ok: false, error: refusalMessage(err) };
  }
}
